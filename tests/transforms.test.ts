/**
 * Start Plan body transforms.
 * Ports zcode-api `src/proxy/body-transformer.test.ts` — the start-plan
 * Anthropic system blocks, GLM-5.3 reasoning compat, and cache_control.
 */
import { describe, expect, it } from "bun:test";
import { effortForBudget, transformStartPlanBody } from "../src/transforms.js";
import { GLM53_THINKING_BUDGETS } from "../src/reasoning.js";

interface Block {
  type: string;
  text: string;
  cache_control?: { type: string };
}

interface Body {
  model?: string;
  system?: Block[];
  messages?: Array<{ role: string; content: unknown }>;
  thinking?: Record<string, unknown>;
  output_config?: { effort?: string };
  max_tokens?: number;
}

function apply(body: unknown): Body {
  return JSON.parse(transformStartPlanBody(JSON.stringify(body))!) as Body;
}

describe("start-plan system blocks", () => {
  it("prepends the three official blocks plus the currentModel block", () => {
    const out = apply({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] });
    expect(out.system).toHaveLength(4);
    expect(out.system![0]!.text).toBe("You are ZCode, an interactive coding agent");
    expect(out.system![3]!.text).toBe("- You are powered by the model named GLM-5.3.");
    for (const block of out.system!) expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits the currentModel block when no model is set", () => {
    expect(apply({ messages: [] }).system).toHaveLength(3);
  });

  it("keeps the caller's system prompt after the official blocks", () => {
    const out = apply({ model: "GLM-5.3", system: "be terse", messages: [] });
    expect(out.system).toHaveLength(5);
    expect(out.system![4]).toEqual({ type: "text", text: "be terse" });
  });

  it("drops blank caller system blocks", () => {
    expect(apply({ system: ["  ", ""], messages: [] }).system).toHaveLength(3);
  });

  it("returns a malformed body unchanged", () => {
    expect(transformStartPlanBody("{{{")).toBe("{{{");
  });

  it("passes an empty body through", () => {
    expect(transformStartPlanBody(undefined)).toBeUndefined();
    expect(transformStartPlanBody("")).toBe("");
  });
});

describe("GLM-5.3 reasoning", () => {
  it("rewrites disabled thinking to enabled with a fitted budget and low effort", () => {
    const out = apply({ model: "GLM-5.3", max_tokens: 64_000, thinking: { type: "disabled" }, messages: [] });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.low });
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("drops the budget when max_tokens leaves no usable room", () => {
    const out = apply({ model: "GLM-5.3", max_tokens: 1_100, thinking: { type: "disabled" }, messages: [] });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("pairs an explicit budget with the matching effort", () => {
    const out = apply({
      model: "GLM-5.3",
      max_tokens: 128_000,
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.max },
      messages: [],
    });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.max });
    expect(out.output_config).toEqual({ effort: "max" });
  });

  it("never overwrites a caller-supplied output_config", () => {
    const out = apply({
      model: "GLM-5.3",
      max_tokens: 128_000,
      thinking: { type: "enabled", budget_tokens: 8_000 },
      output_config: { effort: "high" },
      messages: [],
    });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("leaves a body with no thinking field alone", () => {
    const out = apply({ model: "GLM-5.3", messages: [] });
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toBeUndefined();
  });

  it("does not touch reasoning on a non-GLM-5.3 model", () => {
    const out = apply({ model: "GLM-5-Turbo", thinking: { type: "disabled" }, messages: [] });
    expect(out.thinking).toEqual({ type: "disabled" });
  });
});

describe("effortForBudget", () => {
  it("recovers each catalog level from its paired budget", () => {
    expect(effortForBudget(GLM53_THINKING_BUDGETS.low)).toBe("low");
    expect(effortForBudget(GLM53_THINKING_BUDGETS.high)).toBe("high");
    expect(effortForBudget(GLM53_THINKING_BUDGETS.max)).toBe("max");
  });

  it("snaps an off-ladder budget to the nearest level", () => {
    expect(effortForBudget(1)).toBe("low");
    expect(effortForBudget(1_000_000)).toBe("max");
  });
});

describe("cache_control", () => {
  it("promotes string content on the last non-system message", () => {
    const out = apply({ model: "GLM-5.3", messages: [{ role: "user", content: "hello" }] });
    expect(out.messages![0]!.content).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("marks the last block of array content", () => {
    const out = apply({
      model: "GLM-5.3",
      messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
    });
    const blocks = out.messages![0]!.content as Block[];
    expect(blocks[0]!.cache_control).toBeUndefined();
    expect(blocks[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent when cache_control is already present", () => {
    const content = [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }];
    const out = apply({ model: "GLM-5.3", messages: [{ role: "user", content }] });
    expect(out.messages![0]!.content).toEqual(content);
  });

  it("skips trailing system messages", () => {
    const out = apply({
      model: "GLM-5.3",
      messages: [
        { role: "user", content: "u" },
        { role: "system", content: "s" },
      ],
    });
    expect(out.messages![1]!.content).toBe("s");
    expect(out.messages![0]!.content).toEqual([
      { type: "text", text: "u", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("is a no-op on an empty message list", () => {
    expect(apply({ model: "GLM-5.3", messages: [] }).messages).toEqual([]);
  });
});
