/**
 * Captcha solver dispatch.
 *
 * zcode-api runs `captcha-happy.ts` in its long-lived proxy process. OMP runs
 * the same module in one long-lived worker thread: the worker preserves
 * zcode-api's module-level cookie/CDN/SDK caches across idle periods while
 * isolating Alibaba guest rejections from OMP's main-thread recovery handlers.
 *
 * The worker accepts concurrent solve messages, matching upstream's in-process
 * concurrency. If it crashes, every pending solve rejects and the next request
 * creates a fresh worker; `captcha-pool.ts` owns the existing retry policy.
 */
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_SOLVE_TIMEOUT_MS || 90_000);
const WORKER_URL = new URL("./captcha-worker.ts", import.meta.url);

interface SolveResponse {
  id: string;
  ok?: boolean;
  token?: string;
  error?: string;
}

interface PendingSolve {
  resolve(token: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

let worker: Worker | null = null;
const pending = new Map<string, PendingSolve>();

function rejectAll(error: Error): void {
  for (const solve of pending.values()) {
    clearTimeout(solve.timer);
    solve.reject(error);
  }
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;

  const created = new Worker(WORKER_URL);
  worker = created;
  // A warm idle worker must not keep OMP alive after the session exits.
  created.unref();

  created.on("message", (message: SolveResponse) => {
    const solve = pending.get(message.id);
    if (!solve) return;
    pending.delete(message.id);
    clearTimeout(solve.timer);
    if (message.ok && message.token) solve.resolve(message.token);
    else solve.reject(new Error(message.error || "captcha solve produced no token"));
  });

  created.on("error", (error: Error) => {
    if (worker === created) worker = null;
    rejectAll(new Error(`captcha worker failed: ${error.message}`));
  });

  created.on("exit", (code: number) => {
    if (worker !== created) return;
    worker = null;
    if (code !== 0 || pending.size > 0) {
      rejectAll(new Error(`captcha worker exited with code ${code}`));
    }
  });

  return created;
}

export function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    return Promise.reject(
      new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`),
    );
  }

  const id = randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    const solve = pending.get(id);
    if (!solve) return;
    pending.delete(id);
    solve.reject(new Error(`captcha solve timed out after ${SOLVE_TIMEOUT_MS}ms`));
  }, SOLVE_TIMEOUT_MS);

  pending.set(id, { resolve, reject, timer });
  try {
    getWorker().postMessage({ id, scene, region, prefix });
  } catch (error) {
    pending.delete(id);
    clearTimeout(timer);
    reject(error instanceof Error ? error : new Error(String(error)));
  }
  return promise;
}

/** The persistent worker handles concurrent messages internally. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** Terminate the worker and reject any in-flight solves. */
export function shutdownCaptchaSolver(): void {
  const current = worker;
  worker = null;
  rejectAll(new Error("captcha solver shut down"));
  if (current) void current.terminate();
}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
}
