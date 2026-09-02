/**
 * Captcha solver worker lifecycle.
 *
 * The worker is deliberately long-lived: it holds zcode-api's module-level
 * cookie/CDN/SDK caches, which is what keeps a solve after an idle period from
 * starting completely cold (and returning `400 {"code":3007}`).
 *
 * The behaviour under test here is what happens when a solve *stalls*. Upstream
 * documents "pe-stall storms"; inside the worker the stalled `solveTraceless`
 * keeps a live happy-dom window running. Rejecting the caller without
 * terminating the worker leaves that window - and every one behind it - alive,
 * which is the RAM growth we observed in practice.
 *
 * Timers are injected rather than real, so these tests drive the stall
 * deterministically.
 */
import { describe, expect, it } from "bun:test";
import { createCaptchaSolver, type SolverWorker } from "../src/captcha-solver.js";

interface FakeWorker extends SolverWorker {
  sent: Array<{ id: string; scene: string; region: string; prefix: string }>;
  terminated: number;
  emit(event: "message" | "error" | "exit", payload: unknown): void;
}

function fakeWorker(): FakeWorker {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {};
  const worker: FakeWorker = {
    sent: [],
    terminated: 0,
    postMessage(message) {
      worker.sent.push(message);
    },
    on(event, listener) {
      (listeners[event] ??= []).push(listener as (payload: unknown) => void);
    },
    unref() {},
    terminate() {
      worker.terminated += 1;
    },
    emit(event, payload) {
      for (const listener of listeners[event] ?? []) listener(payload);
    },
  };
  return worker;
}

/** Manual timer control: `fire()` runs the pending solve timeout. */
function manualTimers() {
  const scheduled: Array<() => void> = [];
  return {
    scheduled,
    startTimer: (callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length - 1;
    },
    clearTimer: () => {},
    fire: () => {
      const callback = scheduled.shift();
      callback?.();
    },
  };
}

function harness() {
  const workers: FakeWorker[] = [];
  const timers = manualTimers();
  const solver = createCaptchaSolver({
    spawn: () => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker;
    },
    timeoutMs: 90_000,
    startTimer: timers.startTimer,
    clearTimer: timers.clearTimer,
  });
  return { solver, workers, timers };
}

describe("createCaptchaSolver", () => {
  it("reuses one worker across solves so the SDK caches stay warm", async () => {
    const h = harness();
    const first = h.solver.solve("scene", "cn", "prefix");
    const second = h.solver.solve("scene", "cn", "prefix");

    expect(h.workers).toHaveLength(1);
    const [a, b] = h.workers[0].sent;
    h.workers[0].emit("message", { id: a.id, ok: true, token: "token-a" });
    h.workers[0].emit("message", { id: b.id, ok: true, token: "token-b" });

    expect(await first).toBe("token-a");
    expect(await second).toBe("token-b");
  });

  it("terminates the stalled worker on timeout instead of leaving it running", async () => {
    const h = harness();
    const attempt = h.solver.solve("scene", "cn", "prefix");
    h.timers.fire();

    await expect(attempt).rejects.toThrow(/timed out after 90000ms/);
    expect(h.workers[0].terminated).toBe(1);
  });

  it("fails the other solves queued behind a stall, because they share that worker", async () => {
    const h = harness();
    const stalled = h.solver.solve("scene", "cn", "prefix");
    const queued = h.solver.solve("scene", "cn", "prefix");
    h.timers.fire();

    await expect(stalled).rejects.toThrow(/timed out/);
    await expect(queued).rejects.toThrow(/terminated after a stalled solve/);
  });

  it("spawns a fresh worker for the next solve after a stall", async () => {
    const h = harness();
    const stalled = h.solver.solve("scene", "cn", "prefix");
    h.timers.fire();
    await expect(stalled).rejects.toThrow(/timed out/);

    const next = h.solver.solve("scene", "cn", "prefix");
    expect(h.workers).toHaveLength(2);
    const sent = h.workers[1].sent[0];
    h.workers[1].emit("message", { id: sent.id, ok: true, token: "fresh" });
    expect(await next).toBe("fresh");
  });

  it("rejects pending solves when the worker crashes and recovers on the next call", async () => {
    const h = harness();
    const attempt = h.solver.solve("scene", "cn", "prefix");
    h.workers[0].emit("error", new Error("boom"));

    await expect(attempt).rejects.toThrow(/captcha worker failed: boom/);
    void h.solver.solve("scene", "cn", "prefix");
    expect(h.workers).toHaveLength(2);
  });

  it("reports the concurrency the pool configured, not a fixed default", () => {
    const h = harness();
    expect(h.solver.concurrency()).toBe(4);
    h.solver.setConcurrency(2);
    expect(h.solver.concurrency()).toBe(2);
  });

  it("terminates the worker and rejects in-flight solves on shutdown", async () => {
    const h = harness();
    const attempt = h.solver.solve("scene", "cn", "prefix");
    h.solver.shutdown();

    await expect(attempt).rejects.toThrow(/shut down/);
    expect(h.workers[0].terminated).toBe(1);
  });
});
