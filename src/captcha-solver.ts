/**
 * Captcha solver dispatch.
 *
 * zcode-api runs `captcha-happy.ts` inside its long-lived proxy process. OMP
 * runs the same module in one long-lived worker thread, for two reasons that
 * pull in opposite directions:
 *
 *   - **Keep it alive.** The module holds zcode-api's cookie jar, CDN cache and
 *     initialised FeiLin SDK. Spawning a worker per solve throws those away and
 *     the first solve after an idle period comes back
 *     `400 {"code":3007}` - the bug we shipped once already.
 *   - **Keep it isolated.** Alibaba's SDK throws inside happy-dom on every
 *     solve. In-process those become unhandled rejections in OMP's own realm.
 *
 * The worker accepts concurrent solve messages, matching upstream's in-process
 * concurrency; `captcha-pool.ts` owns the retry/storm policy above it.
 *
 * The solver is built through {@link createCaptchaSolver} so the worker and its
 * timers can be injected in tests. The module-level functions below are the
 * process-wide instance the vendored `captcha-pool.ts`/`captcha.ts` import - do
 * not change their names or signatures without checking `bun run parity`.
 */
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SOLVE_TIMEOUT_MS || 90_000);
const DEFAULT_CONCURRENCY = Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
const WORKER_URL = new URL("./captcha-worker.ts", import.meta.url);

interface SolveResponse {
  id: string;
  ok?: boolean;
  token?: string;
  error?: string;
}

/** Sandbox stderr line forwarded by the worker; carries no solve id. */
interface DiagnosticMessage {
  kind: "diag";
  text: string;
}

/** The slice of `node:worker_threads` Worker this module uses. */
export interface SolverWorker {
  postMessage(message: { id: string; scene: string; region: string; prefix: string }): void;
  on(event: "message" | "error" | "exit", listener: (payload: never) => void): void;
  unref(): void;
  terminate(): void | Promise<number>;
}

export interface CaptchaSolverDeps {
  spawn: () => SolverWorker;
  timeoutMs: number;
  /** Timer seam: returns a handle passed back to {@link clearTimer}. */
  startTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  concurrency?: number;
  /**
   * Sink for sandbox diagnostics the worker forwards instead of writing to the
   * shared stderr descriptor. Defaults to dropping them.
   */
  log?: (message: string) => void;
}

export interface CaptchaSolver {
  solve(scene: string, region: string, prefix: string): Promise<string>;
  shutdown(): void;
  setConcurrency(n: number): void;
  concurrency(): number;
}

interface PendingSolve {
  reject(error: Error): void;
  resolve(token: string): void;
  timer: unknown;
}
/**
 * A worker that cannot import `happy-dom` / `undici` failed to *start*, not to
 * solve.
 *
 * The vendored sandbox imports both, and only inside the worker, so a plugin
 * tree installed without dependencies passes registration, model discovery and
 * `omp plugin doctor`, then reports
 * `captcha failed after 4 attempts: Cannot find package 'happy-dom'` the first
 * time a request hits an in-body `{"code":3007}` challenge.
 *
 * This is deliberately classified here rather than preflighted before the
 * import: Bun answers `import.meta.resolve` / `require.resolve` out of its
 * global install cache, so a preflight passes on any machine that happens to
 * have the package cached and only fails on the machine that does not. The
 * worker's own import error is the one honest signal.
 */
const MISSING_PACKAGE = /Cannot find (?:package|module) ['"]([^'"]+)['"]/;

const REPAIR_COMMAND = "omp install github:hassankhan2608/omp-zcode-provider --force";

/**
 * Rewrite a start-up failure into a repair instruction, or return undefined
 * for an ordinary solve failure.
 */
function asDependencyFailure(message: string): Error | undefined {
  const match = MISSING_PACKAGE.exec(message);
  if (!match) return undefined;
  return new Error(
    `zcode captcha cannot start: runtime dependency ${match[1]} is missing from the installed plugin. ` +
      `Reinstall it so its dependencies are installed: ${REPAIR_COMMAND}`,
  );
}

export function createCaptchaSolver(deps: CaptchaSolverDeps): CaptchaSolver {
  let worker: SolverWorker | null = null;
  let concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const pending = new Map<string, PendingSolve>();
  /** Set once a worker proves the install is broken; never cleared. */
  let fatalError: Error | undefined;

  const rejectAll = (error: Error): void => {
    for (const solve of pending.values()) {
      deps.clearTimer(solve.timer);
      solve.reject(error);
    }
    pending.clear();
  };

  /** Drop the current worker so the next solve starts a fresh one. */
  const discard = (current: SolverWorker | null, error: Error): void => {
    if (current && worker === current) worker = null;
    rejectAll(error);
    if (current) void current.terminate();
  };

  const getWorker = (): SolverWorker => {
    if (worker) return worker;

    const created = deps.spawn();
    worker = created;
    // A warm idle worker must not keep OMP alive after the session exits.
    created.unref();

    created.on("message", (message: never) => {
      const payload = message as unknown as DiagnosticMessage | SolveResponse;
      if ("kind" in payload && payload.kind === "diag") {
        deps.log?.(payload.text);
        return;
      }
      const response = payload as SolveResponse;
      const solve = pending.get(response.id);
      if (!solve) return;
      pending.delete(response.id);
      deps.clearTimer(solve.timer);
      if (response.ok && response.token) {
        solve.resolve(response.token);
        return;
      }
      const reason = response.error || "captcha solve produced no token";
      const fatal = asDependencyFailure(reason);
      if (fatal) {
        // Latch before rejecting: the vendored pool retries four times, and a
        // missing package cannot appear inside a running process, so every
        // retry would spawn another worker and trip the mint-storm detector.
        fatalError = fatal;
        solve.reject(fatal);
        discard(created, fatal);
        return;
      }
      solve.reject(new Error(reason));
    });

    created.on("error", (payload: never) => {
      const error = payload as unknown as Error;
      if (worker === created) worker = null;
      const fatal = asDependencyFailure(error.message);
      if (fatal) fatalError = fatal;
      rejectAll(fatal ?? new Error(`captcha worker failed: ${error.message}`));
    });

    created.on("exit", (payload: never) => {
      const code = payload as unknown as number;
      if (worker !== created) return;
      worker = null;
      if (code !== 0 || pending.size > 0) rejectAll(new Error(`captcha worker exited with code ${code}`));
    });

    return created;
  };

  return {
    solve(scene: string, region: string, prefix: string): Promise<string> {
      if (fatalError) return Promise.reject(fatalError);
      const id = randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      const current = getWorker();

      const timer = deps.startTimer(() => {
        const solve = pending.get(id);
        if (!solve) return;
        pending.delete(id);
        solve.reject(new Error(`captcha solve timed out after ${deps.timeoutMs}ms`));
        // A stalled solve keeps a live happy-dom window running inside the
        // worker, and the pool's retries pile more behind it. Terminating is
        // the only way to reclaim that; the warm caches are already suspect on
        // a stall, and the next solve rebuilds them.
        discard(current, new Error("captcha worker terminated after a stalled solve"));
      }, deps.timeoutMs);

      pending.set(id, { resolve, reject, timer });
      try {
        current.postMessage({ id, scene, region, prefix });
      } catch (error) {
        pending.delete(id);
        deps.clearTimer(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return promise;
    },

    shutdown(): void {
      discard(worker, new Error("captcha solver shut down"));
    },

    setConcurrency(n: number): void {
      // The worker multiplexes messages itself, so this only records what the
      // pool asked for - but `captchaSolverConcurrency()` must report that
      // number rather than a fixed default, or the pool's own stats lie.
      if (Number.isFinite(n) && n > 0) concurrency = Math.floor(n);
    },

    concurrency(): number {
      return concurrency;
    },
  };
}

/**
 * Sink for sandbox diagnostics, installed by the extension.
 *
 * The process-wide solver below is constructed at import time - long before an
 * `ExtensionAPI` exists - and it is imported by the vendored pool, so it
 * cannot take `pi.logger` as a constructor argument. A settable sink keeps the
 * default (drop) safe for tests and probes.
 */
let diagnosticSink: ((message: string) => void) | undefined;

/** Route forwarded sandbox stderr into the host logger. */
export function setCaptchaDiagnosticSink(sink: (message: string) => void): void {
  diagnosticSink = sink;
}

/** Process-wide instance used by the vendored captcha pool. */
const solver = createCaptchaSolver({
  spawn: () => new Worker(WORKER_URL) as unknown as SolverWorker,
  timeoutMs: SOLVE_TIMEOUT_MS,
  startTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  log: (message) => diagnosticSink?.(message),
});

export function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    return Promise.reject(new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`));
  }
  return solver.solve(scene, region, prefix);
}

export function setCaptchaSolverConcurrency(n: number): void {
  solver.setConcurrency(n);
}

/** Terminate the worker and reject any in-flight solves. */
export function shutdownCaptchaSolver(): void {
  solver.shutdown();
}

export function captchaSolverConcurrency(): number {
  return solver.concurrency();
}
