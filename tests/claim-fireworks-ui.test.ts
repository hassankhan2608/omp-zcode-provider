/**
 * Fireworks presentation tests.
 *
 * The celebration is an editor widget, never `ui.custom`: a widget takes no
 * keyboard focus, so the editor keeps receiving input (including Ctrl-C)
 * while it animates, and a real timer removes it.
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
}

type WidgetContent =
  | readonly string[]
  | ((tui: ClaimFireworksTui, theme: unknown) => FireworksComponent)
  | undefined;

/** Includes `custom` only to prove the presenter never calls it. */
interface FakeUi {
  setWidget(
    key: string,
    content: WidgetContent,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  custom(): void;
}

function fakeHost(options: { mode?: string; fireworksEnv?: string } = {}): {
  host: ClaimFireworksHost;
  captured: Captured;
} {
  const captured: Captured = { calls: [], pumps: 0, customCalls: 0 };
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

  return { host: { mode: options.mode ?? "tui", hasUI: true, ui }, captured };
}

afterEach(() => {
  delete process.env.ZCODE_CLAIM_FIREWORKS;
});

describe("showClaimFireworks", () => {
  it("shows a centered widget above the editor and removes it after the real timer", async () => {
    const { host, captured } = fakeHost();
    await showClaimFireworks(host, MESSAGE, { durationMs: 30 });

    expect(captured.calls[0]!.cleared).toBe(false);
    expect(captured.calls[0]!.placement).toBe("aboveEditor");
    expect(captured.calls[0]!.rendered.join("\n")).toContain("100,000,000 TOKENS");
    const last = captured.calls[captured.calls.length - 1]!;
    expect(last.cleared).toBe(true);
    expect(last.key).toBe(captured.calls[0]!.key);
  });

  it("survives a stale string payload from a scheduler created before hot reload", async () => {
    const { host, captured } = fakeHost();
    const stalePayload = "ZCode claim: ZCode Global Build claimed for a@b.dev";
    await showClaimFireworks(host, stalePayload, { durationMs: 10 });
    expect(captured.calls[0]!.rendered.join("\n")).toContain(stalePayload);
    expect(captured.calls[captured.calls.length - 1]!.cleared).toBe(true);
  });

  it("never calls the focus-stealing custom UI", async () => {
    const { host, captured } = fakeHost();
    await showClaimFireworks(host, MESSAGE, { durationMs: 10 });
    expect(captured.customCalls).toBe(0);
  });

  it("animates by asking the host to re-render while visible", async () => {
    const { host, captured } = fakeHost();
    await showClaimFireworks(host, MESSAGE, { durationMs: 200 });
    expect(captured.pumps).toBeGreaterThan(0);
  });

  it("skips the celebration when ZCODE_CLAIM_FIREWORKS=0", async () => {
    const { host, captured } = fakeHost({ fireworksEnv: "0" });
    await showClaimFireworks(host, MESSAGE, { durationMs: 10 });
    expect(captured.calls).toHaveLength(0);
  });

  it("skips the celebration outside the TUI", async () => {
    const { host, captured } = fakeHost({ mode: "print" });
    await showClaimFireworks(host, MESSAGE, { durationMs: 10 });
    expect(captured.calls).toHaveLength(0);
  });
});
