/**
 * Claim celebration summary: the lines shown after a successful claim, modelled
 * on the ZCode desktop success card (grant total, entitlement, validity).
 */
import { describe, expect, it } from "bun:test";
import { claimCelebration } from "../src/claim-summary.js";
import type { ClaimablePlan, ClaimOutcome } from "../src/claim.js";

const PLAN: ClaimablePlan = {
  planId: "zcode-v3-start-plan-0901-2",
  name: "ZCode Global Build",
  description: "",
  priority: 110,
  entitlements: [
    {
      entitlementId: "e-1",
      showName: "GLM-5.3-Flash",
      meter: "token",
      unitType: "token",
      capabilities: ["glm-5.3-flash"],
      grantUnits: 100_000_000,
      period: "one_time",
      priority: 0,
    },
  ],
};

// 2026-09-03T07:30:00+05:30 -> the "Valid until" the desktop card shows.
const ENDS_AT = 1788399000;

describe("claimCelebration", () => {
  it("leads with the grant total in full and short form, like the desktop card", () => {
    const { headline, lines } = claimCelebration({
      plan: PLAN,
      outcome: { ok: true, planId: PLAN.planId, endsAt: ENDS_AT },
      account: "asnknkajnsa@crowmail.sbs",
    });
    expect(headline).toBe("100,000,000 TOKENS");
    expect(lines[0]).toBe("ZCode Global Build");
  });

  it("names the entitlement with its short quota and period", () => {
    const { lines } = claimCelebration({
      plan: PLAN,
      outcome: { ok: true, planId: PLAN.planId, endsAt: ENDS_AT },
      account: "a@b.dev",
    });
    expect(lines.join("\n")).toContain("GLM-5.3-Flash · 100M tokens · one-time");
  });

  it("shows the validity window and the account it landed on", () => {
    const { lines } = claimCelebration({
      plan: PLAN,
      outcome: { ok: true, planId: PLAN.planId, endsAt: ENDS_AT },
      account: "asnknkajnsa@crowmail.sbs",
    });
    const text = lines.join("\n");
    expect(text).toMatch(/Valid until .*2026/);
    expect(text).toContain("asnknkajnsa@crowmail.sbs");
  });

  it("omits the validity line when the claim response carried no end date", () => {
    const { lines } = claimCelebration({
      plan: PLAN,
      outcome: { ok: true, planId: PLAN.planId },
      account: "a@b.dev",
    });
    expect(lines.join("\n")).not.toContain("Valid until");
  });

  it("prefers the outcome's window over the preview's, since the server decides", () => {
    const { lines } = claimCelebration({
      plan: { ...PLAN, endsAt: 1 },
      outcome: { ok: true, planId: PLAN.planId, endsAt: ENDS_AT },
      account: "a@b.dev",
    });
    expect(lines.join("\n")).toMatch(/Valid until .*2026/);
  });

  it("sums multiple entitlements and lists each one", () => {
    const { headline, lines } = claimCelebration({
      plan: {
        ...PLAN,
        entitlements: [
          PLAN.entitlements[0]!,
          { ...PLAN.entitlements[0]!, entitlementId: "e-2", showName: "GLM-5.3", grantUnits: 20_000_000, period: "daily" },
        ],
      },
      outcome: { ok: true, planId: PLAN.planId },
      account: "a@b.dev",
    });
    expect(headline).toBe("120,000,000 TOKENS");
    const text = lines.join("\n");
    expect(text).toContain("GLM-5.3-Flash · 100M tokens · one-time");
    expect(text).toContain("GLM-5.3 · 20M tokens · daily");
  });

  it("falls back to the plan name when a plan grants nothing countable", () => {
    const { headline, lines } = claimCelebration({
      plan: { ...PLAN, entitlements: [] },
      outcome: { ok: true, planId: PLAN.planId },
      account: "a@b.dev",
    });
    expect(headline).toBe("ZCode Global Build");
    expect(lines.join("\n")).toContain("a@b.dev");
  });

  it("provides a one-line form for logs and transcript entries", () => {
    const { notice } = claimCelebration({
      plan: PLAN,
      outcome: { ok: true, planId: PLAN.planId, endsAt: ENDS_AT },
      account: "a@b.dev",
    });
    expect(notice).toContain("ZCode Global Build");
    expect(notice).toContain("100M tokens");
    expect(notice).toContain("a@b.dev");
    expect(notice.split("\n")).toHaveLength(1);
  });
});
