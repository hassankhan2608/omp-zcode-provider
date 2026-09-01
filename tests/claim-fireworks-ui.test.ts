/**
 * Fireworks presentation tests: the TUI bridge between claim success and the
 * animated overlay. Fake ui.custom captures the factory; a fake TUI records
 * render pumps; Escape resolves; the env kill-switch and mode guard skip it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { showClaimFireworks, type ClaimFireworksHost } from "../src/claim-fireworks.js";

interface Captured {
  factories: Array<(tui: unknown, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => unknown>;
  done?: (result?: unknown) => void;
  rendered: string[][];
  pumps: number;
  finished: number;
}

function fakeHost(options: { mode?: string; fireworksEnv?: string } = {}): { host: ClaimFireworksHost; captured: Captured } {
  const captured: Captured = { factories: [], rendered: [], pumps: 0, finished: 0 };
  if (options.fireworksEnv !== undefined) process.env.ZCODE_CLAIM_FIREWORKS = options.fireworksEnv;
  else delete process.env.ZCODE_CLAIM_FIREWORKS;

  const host: ClaimFireworksHost = {
    mode: options.mode ?? "tui",
    hasUI: true,
    ui: {
      custom<T>(factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (result?: T) => void) => unknown): Promise<T> {
        captured.factories.push(factory as Captured["factories"][number]);
        return new Promise<T>((resolve) => {
          const done = (result?: T): void => {
            captured.finished += 1;
            resolve(result as T);
          };
          const tui = { requestRender: (): void => void (captured.pumps += 1) };
          const component = factory(tui, {}, {}, done) as {
            render(width: number): readonly string[];
            handleInput?(data: string): void;
          };
          // Pump a few frames like the TUI would after requestRender, then
          // dismiss with Escape so the overlay promise settles.
          for (let frame = 0; frame < 3; frame++) {
            component.render(80).forEach((line) => captured.rendered.push([...line]));
            component.handleInput?.("");
          }
          component.handleInput?.("\x1b");
        });
      },
    },
  };
  return { host, captured };
}

afterEach(() => {
  delete process.env.ZCODE_CLAIM_FIREWORKS;
});

describe("showClaimFireworks", () => {
  it("presents the overlay and resolves on Escape", async () => {
    const { host, captured } = fakeHost();
    await showClaimFireworks(host, "ZCode claim: test");
    expect(captured.factories).toHaveLength(1);
    expect(captured.finished).toBe(1);
    expect(captured.rendered.length).toBeGreaterThan(0);
  });

  it("skips the overlay when ZCODE_CLAIM_FIREWORKS=0", async () => {
    const { host, captured } = fakeHost({ fireworksEnv: "0" });
    await showClaimFireworks(host, "ZCode claim: test");
    expect(captured.factories).toHaveLength(0);
    expect(captured.finished).toBe(0);
  });

  it("skips the overlay outside the TUI", async () => {
    const { host, captured } = fakeHost({ mode: "print" });
    await showClaimFireworks(host, "ZCode claim: test");
    expect(captured.factories).toHaveLength(0);
  });
});
