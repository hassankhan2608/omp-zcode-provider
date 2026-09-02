/**
 * Fireworks presentation tests.
 *
 * Two properties are load-bearing and both were shipped broken once:
 *
 *   - It must be a **widget**, never `ui.custom`. OMP's custom UI calls
 *     `TUI.showOverlay()`, which always moves keyboard focus to the component,
 *     and a decorative celebration that swallows Escape/Ctrl-C traps the user.
 *   - Its lifetime must run on **OMP's session timers** (`ctx.setTimeout` /
 *     `ctx.setInterval`), which OMP clears on `session_shutdown`. Global timers
 *     can fire into a torn-down session.
 *
 * The fake host therefore drives both the widget and the timers, so nothing
 * here depends on wall-clock time.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  showClaimFireworks,
  type ClaimFireworksHost,
  type ClaimFireworksMessage,
  type ClaimFireworksTui,
  type FireworksComponent,
} from "../src/claim-fireworks.js";

const MESSAGE: ClaimFireworksMessage = {
  headline: "100,000,000 TOKENS",
  lines: ["ZCode Global Build", "GLM-5.3-Flash · 100M tokens · one-time", "Valid until Sep 3, 2026, 7:30 AM", "a@b.dev"],
};

interface WidgetCall {
  key: string;
  cleared: boolean;
  placement?: string;
  rendered: string[];
}
interface Captured {
  calls: WidgetCall[];
  pumps: number;
  customCalls: number;
  /** Live timers by handle; `clearTimer` really removes them. */
  timeouts: Map<number, () => void>;
  intervals: Map<number, () => void>;
  cleared: number;
}

type WidgetContent =
  | readonly string[]
  | ((tui: ClaimFireworksTui, theme: unknown) => FireworksComponent)
  | undefined;

/** Includes `custom` only to prove the presenter never calls it. */
interface FakeUi {
  setWidget(key: string, content: WidgetContent, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  custom(): void;
}

function fakeHost(options: { mode?: string; fireworksEnv?: string } = {}): {
  host: ClaimFireworksHost;
  captured: Captured;
  fireTimeout(): void;
  tick(): void;
} {
  const captured: Captured = {
    calls: [],
    pumps: 0,
    customCalls: 0,
    timeouts: new Map(),
    intervals: new Map(),
    cleared: 0,
  };
  let nextHandle = 1;
  if (options.fireworksEnv !== undefined) process.env.ZCODE_CLAIM_FIREWORKS = options.fireworksEnv;
  else delete process.env.ZCODE_CLAIM_FIREWORKS;

  const ui: FakeUi = {
    setWidget(key, content, widgetOptions): void {
      if (content === undefined) {
        captured.calls.push({ key, cleared: true, rendered: [] });
        return;
      }
      const tui: ClaimFireworksTui = {
        requestRender(): void {
          captured.pumps += 1;
        },
      };
      const component = typeof content === "function" ? content(tui, {}) : { render: () => content };
      captured.calls.push({
        key,
        cleared: false,
        ...(widgetOptions?.placement !== undefined ? { placement: widgetOptions.placement } : {}),
        rendered: [...component.render(80)],
      });
    },
    custom(): void {
      captured.customCalls += 1;
    },
  };

  const host: ClaimFireworksHost = {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui,
    setTimeout(callback: () => void) {
      const handle = nextHandle++;
      captured.timeouts.set(handle, callback);
      return handle;
    },
    setInterval(callback: () => void) {
      const handle = nextHandle++;
      captured.intervals.set(handle, callback);
      return handle;
    },
    clearTimer(timer) {
      captured.cleared += 1;
      captured.timeouts.delete(timer as number);
      captured.intervals.delete(timer as number);
    },
  };

  return {
    host,
    captured,
    // Fire the oldest live timeout, mirroring how the real clock would.
    fireTimeout: () => {
      const [handle, callback] = [...captured.timeouts.entries()][0] ?? [];
      if (handle === undefined || !callback) return;
      captured.timeouts.delete(handle);
      callback();
    },
    tick: () => {
      for (const interval of captured.intervals.values()) interval();
    },
  };
}

afterEach(() => {
  delete process.env.ZCODE_CLAIM_FIREWORKS;
});

describe("showClaimFireworks", () => {
  it("shows the widget above the editor with the full claim details", () => {
    const h = fakeHost();
    void showClaimFireworks(h.host, MESSAGE);

    expect(h.captured.calls[0]!.cleared).toBe(false);
    expect(h.captured.calls[0]!.placement).toBe("aboveEditor");
    expect(h.captured.calls[0]!.rendered.join("\n")).toContain("100,000,000 TOKENS");
  });

  it("schedules its lifetime on the session timers OMP clears at shutdown", () => {
    const h = fakeHost();
    void showClaimFireworks(h.host, MESSAGE);

    // One interval to animate, one timeout to retire the widget - both owned by
    // the session, so a shutdown cannot leave a callback pointing at dead UI.
    expect(h.captured.intervals.size).toBe(1);
    expect(h.captured.timeouts.size).toBe(1);
  });

  it("removes the widget when the session timeout fires, not before", async () => {
    const h = fakeHost();
    const shown = showClaimFireworks(h.host, MESSAGE);

    expect(h.captured.calls.some((call) => call.cleared)).toBe(false);
    h.fireTimeout();
    await shown;

    const last = h.captured.calls[h.captured.calls.length - 1]!;
    expect(last.cleared).toBe(true);
    expect(last.key).toBe(h.captured.calls[0]!.key);
    // Both timers released.
    expect(h.captured.cleared).toBeGreaterThanOrEqual(2);
  });

  it("animates by asking the host to re-render on each interval tick", () => {
    const h = fakeHost();
    void showClaimFireworks(h.host, MESSAGE);
    h.tick();
    h.tick();
    expect(h.captured.pumps).toBe(2);
  });

  it("replaces an earlier celebration without letting its timer retire the new one", async () => {
    const h = fakeHost();
    const first = showClaimFireworks(h.host, MESSAGE);
    const second = showClaimFireworks(h.host, { headline: "SECOND", lines: ["b@b.dev"] });
    await first;

    // The first celebration finished, but its widget must not have been cleared
    // after the second one was already on screen.
    const lastShown = h.captured.calls.map((call) => call.cleared).lastIndexOf(false);
    const lastCleared = h.captured.calls.map((call) => call.cleared).lastIndexOf(true);
    expect(lastShown).toBeGreaterThan(lastCleared);

    h.fireTimeout();
    await second;
    expect(h.captured.calls[h.captured.calls.length - 1]!.cleared).toBe(true);
  });

  it("survives a stale string payload from a scheduler created before hot reload", async () => {
    const h = fakeHost();
    const stalePayload = "ZCode claim: ZCode Global Build claimed for a@b.dev";
    const shown = showClaimFireworks(h.host, stalePayload);
    expect(h.captured.calls[0]!.rendered.join("\n")).toContain(stalePayload);
    h.fireTimeout();
    await shown;
    expect(h.captured.calls[h.captured.calls.length - 1]!.cleared).toBe(true);
  });

  it("never calls the focus-stealing custom UI", () => {
    const h = fakeHost();
    void showClaimFireworks(h.host, MESSAGE);
    expect(h.captured.customCalls).toBe(0);
  });

  it("skips the celebration when ZCODE_CLAIM_FIREWORKS=0", async () => {
    const h = fakeHost({ fireworksEnv: "0" });
    await showClaimFireworks(h.host, MESSAGE);
    expect(h.captured.calls).toHaveLength(0);
    expect(h.captured.timeouts.size).toBe(0);
  });

  it("skips the celebration outside the TUI", async () => {
    const h = fakeHost({ mode: "print" });
    await showClaimFireworks(h.host, MESSAGE);
    expect(h.captured.calls).toHaveLength(0);
  });
});
