/**
 * OMP-only regressions for the vendored captcha pool.
 *
 * `tests/captcha-pool.test.ts` is upstream's suite and is kept as a copy (see
 * `upstream-parity.ts`), so OMP-specific tests live here instead - otherwise
 * every one of them would have to be registered as an allowed divergence and
 * the parity report would drown in them.
 */
import { describe, expect, it, mock } from "bun:test";
import * as realSolver from "../src/captcha-solver.js";

const solveMock = mock(async (_scene: string, _region: string, _prefix: string) => "x".repeat(64));

mock.module("../src/captcha-solver.js", () => ({
  ...realSolver,
  runCaptchaSolve: solveMock,
  shutdownCaptchaSolver: () => {},
  setCaptchaSolverConcurrency: () => {},
  captchaSolverConcurrency: () => 2,
}));

const { CaptchaTokenPool } = await import("../src/captcha-pool.js");

const CFG = { enabled: true, prefix: "no8xfe", sceneId: "11xygtvd", region: "sgp" };

interface TimerRecord {
  ms: number;
  /** Opaque: Bun's timer handle, only ever compared by identity. */
  handle: unknown;
  unrefed: boolean;
  cleared: boolean;
}

describe("CaptchaTokenPool take deadline (OMP process-exit boundary)", () => {
  it("does not leave the losing race timer holding the event loop open", async () => {
    // Upstream is a long-lived proxy, so a deadline timer left pending after a
    // fast take costs it nothing. OMP also runs as `omp -p`, which exits when
    // its work is done: measured before the fix, a 2ms take kept the process
    // alive for the full 25s deadline and `omp -p` took 25.5s to exit after
    // printing its answer.
    process.env.ZCODE_CAPTCHA_SKIP_DEPS = "1";
    solveMock.mockImplementation(async () => "x".repeat(64));

    const timers: TimerRecord[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;

    globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(callback, ms, ...args);
      const record: TimerRecord = { ms: ms ?? 0, handle, unrefed: false, cleared: false };
      timers.push(record);
      const originalUnref = handle.unref?.bind(handle);
      handle.unref = () => {
        record.unrefed = true;
        return originalUnref ? originalUnref() : handle;
      };
      return handle;
    }) as typeof globalThis.setTimeout;

    globalThis.clearTimeout = ((handle: ReturnType<typeof globalThis.setTimeout>) => {
      for (const record of timers) if (record.handle === handle) record.cleared = true;
      return realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout;

    try {
      const pool = new CaptchaTokenPool({
        poolSizeMin: 1,
        poolSizeMax: 2,
        tokenTtlMs: 60_000,
        refillIntervalMs: 600_000,
        staggerMs: 0,
        solveRetries: 1,
        solveConcurrency: 1,
        scaleDownIdleMs: 600_000,
      });
      const token = await pool.takeToken(CFG);
      pool.stopBackgroundRefill();
      expect(token.length).toBeGreaterThan(0);

      // The deadline timer is the long one: the pool floors it at 1s.
      const deadlineTimers = timers.filter((record) => record.ms >= 1_000);
      expect(deadlineTimers.length).toBeGreaterThan(0);
      for (const record of deadlineTimers) {
        expect(record.cleared || record.unrefed).toBe(true);
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
