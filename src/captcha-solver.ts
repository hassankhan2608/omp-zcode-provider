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

export function createCaptchaSolver(deps: CaptchaSolverDeps): CaptchaSolver {
  let worker: SolverWorker | null = null;
  let concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const pending = new Map<string, PendingSolve>();

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
      const response = message as unknown as SolveResponse;
      const solve = pending.get(response.id);
      if (!solve) return;
      pending.delete(response.id);
      deps.clearTimer(solve.timer);
      if (response.ok && response.token) solve.resolve(response.token);
      else solve.reject(new Error(response.error || "captcha solve produced no token"));
    });

    created.on("error", (payload: never) => {
      const error = payload as unknown as Error;
      if (worker === created) worker = null;
      rejectAll(new Error(`captcha worker failed: ${error.message}`));
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

/** Process-wide instance used by the vendored captcha pool. */
const solver = createCaptchaSolver({
  spawn: () => new Worker(WORKER_URL) as unknown as SolverWorker,
  timeoutMs: SOLVE_TIMEOUT_MS,
  startTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
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
