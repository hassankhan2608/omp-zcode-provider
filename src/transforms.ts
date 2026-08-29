/**
 * Start Plan request-body transforms.
 *
 * Ported from zcode-api `src/proxy/body-transformer.ts`, reduced to the single
 * route this provider uses: an Anthropic-shaped body going to the Start Plan
 * gateway. The OpenAI-format branches, the coding-plan `metadata.user_id`
 * injection, and `stream_options.include_usage` are all unreachable here and
 * are therefore not carried over.
 *
 * Applied, in order:
 *   1. Prepend the ZCode gateway system blocks. The gateway inspects request
 *      content and answers 3012 "request has been blocked due to unusual
 *      activity" when they are absent.
 *   2. GLM-5.3 reasoning: rewrite `thinking:{type:"disabled"}` to the
 *      enabled/low form Z.AI documents, and pair every thinking budget with
 *      the matching `output_config.effort` — the only channel this gateway
 *      honors for effort.
 *   3. `cache_control: {type:"ephemeral"}` on the last content block of the
 *      last non-system message (ZCode's `HLr`).
 *
 * Every transform is a no-op on a body that fails to parse, so a malformed
 * body loses the optimization instead of breaking the request.
 */
import { buildStartPlanSystem } from "./system-prompt.js";
import {
  buildGlm53Reasoning,
  fitGlm53Budget,
  GLM53_DISABLED_REPLACEMENT_EFFORT,
  GLM53_EFFORT_LEVELS,
  GLM53_THINKING_BUDGETS,
  isGlm53Model,
  type Glm53Effort,
} from "./reasoning.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Apply every Start Plan transform to a serialized Anthropic request body.
 *
 * Returns the original string when parsing failed, otherwise the re-serialized
 * body. Ported from `transformRequestBody(body, { format: "anthropic",
 * startPlan: true })`.
 */
export function transformStartPlanBody(body: string | undefined): string | undefined {
  if (body === undefined || body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isPlainObject(parsed)) return body;

  applyStartPlanSystem(parsed);
  applyGlm53Reasoning(parsed);
  applyCacheControl(parsed);

  return JSON.stringify(parsed);
}

/**
 * Prepend the official ZCode system blocks, preserving the caller's own.
 * `body.model` drives the dynamic "powered by the model named X" block.
 */
function applyStartPlanSystem(body: Record<string, unknown>): void {
  body.system = buildStartPlanSystem(body.system, typeof body.model === "string" ? body.model : undefined);
}

/**
 * Nearest GLM-5.3 effort level for a thinking budget.
 *
 * OMP encodes the user's effort as `thinking.budget_tokens`; the gateway reads
 * `output_config.effort`. `GLM53_THINKING_BUDGETS` is the authoritative pairing
 * (low 8K, high 16K, max 32K), so the closest budget recovers the level the
 * user asked for without a second source of truth.
 */
export function effortForBudget(budget: number): Glm53Effort {
  let best: Glm53Effort = GLM53_EFFORT_LEVELS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of GLM53_EFFORT_LEVELS) {
    const distance = Math.abs(GLM53_THINKING_BUDGETS[level] - budget);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

/**
 * Put GLM-5.3 reasoning into the exact shape the gateway honors.
 *
 * Three cases, all ported from zcode-api:
 *   - `thinking:{type:"disabled"}` → enabled at `low` effort with its paired,
 *     `max_tokens`-fitted budget. Z.AI documents `"disabled"` as unsupported
 *     for this family.
 *   - an explicit budget → keep it, and add the `output_config.effort` that
 *     matches it, because the label alone (and the budget alone) each produce
 *     near-zero thinking.
 *   - no thinking field at all → leave the body alone; the gateway applies its
 *     catalog default.
 * A caller-supplied `output_config` is never overwritten.
 */
function applyGlm53Reasoning(body: Record<string, unknown>): void {
  if (!isGlm53Model(typeof body.model === "string" ? body.model : undefined)) return;

  const thinking = isPlainObject(body.thinking) ? body.thinking : undefined;
  if (!thinking) return;

  if (thinking.type === "disabled") {
    const legal = buildGlm53Reasoning(GLM53_DISABLED_REPLACEMENT_EFFORT);
    const budget = fitGlm53Budget(legal.thinking.budget_tokens, body.max_tokens);
    body.thinking = budget === undefined ? { type: "enabled" } : { type: "enabled", budget_tokens: budget };
    if (!isPlainObject(body.output_config)) body.output_config = legal.output_config;
    return;
  }

  const requested = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined;
  if (requested === undefined) return;

  const fitted = fitGlm53Budget(requested, body.max_tokens);
  body.thinking = fitted === undefined ? { type: "enabled" } : { ...thinking, type: "enabled", budget_tokens: fitted };
  if (!isPlainObject(body.output_config)) {
    body.output_config = { effort: effortForBudget(fitted ?? requested) };
  }
}

/**
 * Add `cache_control: {type:"ephemeral"}` to the last content block of the last
 * non-system message. Verbatim port of zcode-api `applyAnthropicCacheControl`:
 * idempotent, and it stops at the first non-system message it finds.
 */
function applyCacheControl(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (!isPlainObject(message)) continue;
    if (message.role === "system") continue;

    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
      return;
    }
    if (Array.isArray(message.content) && message.content.length > 0) {
      const lastBlock: unknown = message.content[message.content.length - 1];
      if (isPlainObject(lastBlock) && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
      }
    }
    return;
  }
}
