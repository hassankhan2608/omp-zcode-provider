/**
 * Solver backend dispatch.
 *
 * Backend (ZCODE_CAPTCHA_BACKEND): "happy" (default) — zcode-api's happy-dom
 * solver in `captcha-happy.ts`, which is carried here unmodified apart from two
 * host-difference fixes.
 *
 * This is the ONLY captcha file that diverges from zcode-api: upstream calls
 * `solveTraceless` in-process, this dispatches it to a worker thread. The
 * public API is unchanged, so `captcha-pool.ts` and `captcha.ts` stay
 * byte-identical to upstream and keep owning retries, pooling, and the CPU
 * governor.
 *
 * The reason is not preference. Upstream's own containment
 * (`process.on("unhandledRejection")` inside `captcha-happy.ts`) relies on the
 * proxy being the sole listener on its process. OMP registers its own
 * `unhandledRejection` listeners and Node invokes all of them, so upstream's
 * silent handler cannot prevent OMP from tearing down the agent turn. Moving
 * the sandbox onto a thread restores the process ownership upstream assumes.
 * @see ./captcha-worker.ts
 */
import { Worker } from "node:worker_threads";

const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";

/**
 * Ceiling on one solve, including worker startup. Above upstream's observed
 * solve times (~4-10s) with headroom for a cold happy-dom import; the pool's
 * own stall detection handles anything slower.
 */
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SOLVE_TIMEOUT_MS || 90_000);

const WORKER_URL = new URL("./captcha-worker.ts", import.meta.url);

interface SolveResult {
  ok?: boolean;
  token?: string;
  error?: string;
}

/** Workers currently solving, so shutdown can terminate them. */
const live = new Set<Worker>();

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    throw new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`);
  }

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const worker = new Worker(WORKER_URL, { workerData: { scene, region, prefix } });
  live.add(worker);

  let settled = false;
  const settle = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    live.delete(worker);
    void worker.terminate();
    apply();
  };

  const timer = setTimeout(() => {
    settle(() => reject(new Error(`captcha solve timed out after ${SOLVE_TIMEOUT_MS}ms`)));
  }, SOLVE_TIMEOUT_MS);

  worker.on("message", (message: SolveResult) => {
    settle(() => {
      if (message.ok && message.token) resolve(message.token);
      else reject(new Error(message.error || "captcha solve produced no token"));
    });
  });
  // A guest failure severe enough to kill the thread is a solve failure, which
  // the pool retries — never a host failure.
  worker.on("error", (error: Error) => {
    settle(() => reject(new Error(`captcha worker failed: ${error.message}`)));
  });
  worker.on("exit", (code: number) => {
    settle(() => reject(new Error(`captcha worker exited early with code ${code}`)));
  });

  return promise;
}

/** Worker-per-solve needs no pool sizing — kept for the pool API. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** Terminate any in-flight solve workers. */
export function shutdownCaptchaSolver(): void {
  for (const worker of live) void worker.terminate();
  live.clear();
}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
}
