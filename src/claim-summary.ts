/**
 * Human summary of a successful claim.
 *
 * Mirrors what the ZCode desktop client shows on its success card: the grant
 * total in full ("100,000,000 TOKENS"), then the plan, each entitlement with
 * its short quota and period, the validity window, and the account it landed
 * on. The server's claim response wins over the preview for the window,
 * because activation may shift `starts_at`/`ends_at`.
 */
import type { ClaimablePlan, ClaimOutcome, PlanEntitlement } from "./claim.js";

export interface ClaimCelebrationInput {
  plan: ClaimablePlan;
  outcome: ClaimOutcome;
  /** Account email, or the account id when no email is known. */
  account: string;
}

export interface ClaimCelebration {
  /** Card headline: the total grant, or the plan name when nothing is countable. */
  headline: string;
  /** Detail lines, in display order. */
  lines: string[];
  /** Single-line form for logs and transcript entries. */
  notice: string;
}

/** `100000000` -> `100M`, `20000000` -> `20M`, `1500` -> `1.5K`. */
export function shortUnits(units: number): string {
  const scale = [
    { limit: 1_000_000_000, suffix: "B" },
    { limit: 1_000_000, suffix: "M" },
    { limit: 1_000, suffix: "K" },
  ];
  for (const { limit, suffix } of scale) {
    if (units >= limit) {
      const value = units / limit;
      const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
      return `${rounded}${suffix}`;
    }
  }
  return String(units);
}

/** Unit noun for display: the server's `unitType`, pluralised. */
function unitLabel(entitlement: PlanEntitlement): string {
  const unit = (entitlement.unitType || entitlement.meter || "unit").trim();
  return unit.endsWith("s") ? unit : `${unit}s`;
}
function validUntil(endsAtSec: number): string {
  const when = new Date(endsAtSec * 1000);
  const date = when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Valid until ${date}, ${time}`;
}

export function claimCelebration(input: ClaimCelebrationInput): ClaimCelebration {
  const { plan, outcome, account } = input;
  const entitlements = plan.entitlements;

  // Totals are grouped by unit, never summed across them. A plan mixing meters
  // (tokens + requests, say) would otherwise print one number under the first
  // entitlement's label - a quota the account never received. Insertion order
  // is preserved so the headline follows ZCode's own entitlement order.
  const totalsByUnit = new Map<string, number>();
  for (const entitlement of entitlements) {
    const unit = unitLabel(entitlement);
    totalsByUnit.set(unit, (totalsByUnit.get(unit) ?? 0) + entitlement.grantUnits);
  }

  const granted = [...totalsByUnit].filter(([, amount]) => amount > 0);
  const headline =
    granted.length > 0
      ? granted.map(([unit, amount]) => `${amount.toLocaleString("en-US")} ${unit.toUpperCase()}`).join(" + ")
      : plan.name;

  const lines: string[] = [];
  if (granted.length > 0) lines.push(plan.name);
  for (const entitlement of entitlements) {
    const period = entitlement.period.trim().replace(/_/g, "-");
    lines.push(
      `${entitlement.showName} · ${shortUnits(entitlement.grantUnits)} ${unitLabel(entitlement)} · ${period}`,
    );
  }
  const endsAt = (outcome.ok ? outcome.endsAt : undefined) ?? plan.endsAt;
  if (endsAt !== undefined && Number.isFinite(endsAt)) lines.push(validUntil(endsAt));
  lines.push(account);

  const quota =
    granted.length > 0 ? ` — ${granted.map(([unit, amount]) => `${shortUnits(amount)} ${unit}`).join(" + ")}` : "";
  return { headline, lines, notice: `Claimed ${plan.name}${quota} for ${account}` };
}

/**
 * Combine the claims of one pass into a single card.
 *
 * A scheduler tick (or one `/claim`) can claim for several accounts. The
 * celebration is a single widget with a single key, so showing one card per
 * account would overwrite the previous card and only the last account would
 * ever be visible. Merging keeps each account's detail lines and reports the
 * count in the headline.
 *
 * Returns `undefined` for an empty pass so callers can skip the widget instead
 * of rendering an empty celebration.
 */
export function mergeCelebrations(cards: ClaimCelebration[]): ClaimCelebration | undefined {
  if (cards.length === 0) return undefined;
  const only = cards[0];
  if (cards.length === 1 && only) return only;

  const lines: string[] = [];
  for (const card of cards) {
    if (lines.length > 0) lines.push("");
    lines.push(card.headline, ...card.lines);
  }

  return {
    headline: `${cards.length} PLANS CLAIMED`,
    lines,
    notice: cards.map((card) => card.notice).join("; "),
  };
}
