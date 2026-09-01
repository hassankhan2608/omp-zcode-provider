/**
 * Fireworks celebration component tests.
 * The component is the OMP-native analog of `tui.codexResetFireworks`
 * (Codex resets celebration): a transient TUI overlay shown when the ZCode
 * auto-claimer or /claim succeeds. Pure render parts are deterministic via a
 * seeded RNG so tests assert exact behavior without timing.
 */
import { describe, expect, it } from "bun:test";
import { createFireworksComponent, fireworksFrame } from "../src/claim-fireworks.js";

describe("fireworksFrame", () => {
  it("respects the visible width budget on every line", () => {
    for (const t of [0, 1, 7, 40]) {
      const frame = fireworksFrame(t, 60, 1234);
      for (const line of frame) {
        // SGR bytes do not count against the width; only visible cells do.
        expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(60);
      }
    }
  });

  it("is deterministic for the same seed and tick", () => {
    expect(fireworksFrame(12, 80, 99)).toEqual(fireworksFrame(12, 80, 99));
    expect(fireworksFrame(12, 80, 99)).not.toEqual(fireworksFrame(12, 80, 100));
  });

  it("shows the celebration line and burst glyphs once rising", () => {
    const frame = fireworksFrame(20, 80, 7);
    const plain = frame.join("\n");
    expect(plain).toContain("CLAIMED");
    expect(plain).toMatch(/[✦✧✶✷*]/);
  });

  it("keeps an empty sky before liftoff", () => {
    const frame = fireworksFrame(0, 80, 7);
    const plain = frame.join("\n");
    expect(plain).toContain("CLAIMED");
    expect(plain).not.toMatch(/[✦✧✶✷]/);
  });

  it("pads every sky row to the full width so bursts keep their columns", () => {
    const frame = fireworksFrame(6, 64, 7);
    // All rows except the trailing headline are sky rows: full-width canvas.
    for (const line of frame.slice(0, -1)) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBe(64);
    }
  });

  it("draws expanding rings, not solid bars", () => {
    // Across the animation, sparks on a row must appear as separated arms
    // (left and right of the burst centre), never one contiguous block.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8]
      .flatMap((tick) => fireworksFrame(tick, 64, 7).slice(0, -1))
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      .filter((line) => /[✦✧✶✷*]/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    const groups = (line: string): number => line.split(/ +/).filter((chunk) => chunk.length > 0).length;
    expect(rows.some((line) => groups(line) >= 2)).toBe(true);
  });

  it("never re-opens the same colour between adjacent glyphs", () => {
    for (const tick of [2, 5, 11]) {
      for (const line of fireworksFrame(tick, 64, 7).slice(0, -1)) {
        // A reset always closes a run that painted at least one glyph:
        // an empty `colour + reset` pair would mean per-glyph churn.
        expect(line).not.toMatch(/\x1b\[38;2;[0-9;]+m\x1b\[0m/);
        // Neighbouring glyphs of one colour must share a run, so a reset is
        // never immediately followed by the same colour again.
        for (const [, closed] of line.matchAll(/\x1b\[38;2;([0-9;]+)m[^\x1b]*\x1b\[0m(?=\x1b\[38;2;)/g)) {
          const next = line.slice(line.indexOf(closed) + closed.length);
          expect(next.startsWith(`\x1b[38;2;${closed}m`)).toBe(false);
        }
      }
    }
  });
});

describe("createFireworksComponent", () => {
  it("finishes on Escape input", () => {
    let finished = 0;
    const component = createFireworksComponent({
      line: "ZCode claim: test",
      width: 80,
      onFinish: () => {
        finished += 1;
      },
    });
    component.handleInput?.("\x1b");
    expect(finished).toBe(1);
  });

  it("ignores ordinary keys", () => {
    let finished = 0;
    const component = createFireworksComponent({
      line: "ZCode claim: test",
      width: 80,
      onFinish: () => {
        finished += 1;
      },
    });
    component.handleInput?.("x");
    expect(finished).toBe(0);
  });

  it("auto-finishes after the timeout measured by the injected clock", () => {
    let nowMs = 0;
    let finished = 0;
    const component = createFireworksComponent({
      line: "ZCode claim: test",
      width: 80,
      autoCloseMs: 15_000,
      now: () => nowMs,
      onFinish: () => {
        finished += 1;
      },
    });
    nowMs = 14_999;
    component.handleInput?.(""); // tick hook: empty data also drives expiry check
    expect(finished).toBe(0);
    nowMs = 15_001;
    component.handleInput?.("");
    expect(finished).toBe(1);
  });

  it("renders lines within the requested width", () => {
    const component = createFireworksComponent({
      line: "ZCode claim: test",
      width: 40,
      onFinish: () => {},
    });
    for (const line of component.render(40)) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});
