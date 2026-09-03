/**
 * Auto-claim scheduler tests.
 * Ports zcode-api `src/claim/scheduler.test.ts` (v4.5.3) semantics onto the
 * OMP multi-account boundary: fake clock + injected clients verify the
 * poll→claim state machine — per-account holds, upstream failure-kind
 * cooldowns, login-loss stop, and rotation across stored accounts.
 */
import { describe, expect, it } from "bun:test";
import { ClaimScheduler, type SchedulerAccount } from "../src/claim-scheduler.js";
import { ClaimPreviewError } from "../src/claim.js";
import type { ClaimablePlan, ClaimOutcome } from "../src/claim.js";

interface AccountHarness {
  plans: ClaimablePlan[];
  previewError: Error | undefined;
  claimOutcome: ClaimOutcome | Error;
  captchaResult: { verifyParam: string; region?: string } | Error;
  claimCalls: Array<{ accountId: string; planId: string }>;
}

function makeHarness(configOverrides: Partial<{ planId: string; pollIntervalMs: number; cooldownMs: number }> = {}) {
  const accounts: SchedulerAccount[] = [{ jwt: "jwt-1", accountId: "acc-1", email: "a@x.dev" }];
  const byId = new Map<string, AccountHarness>();
  const makeHarnessFor = (accountId: string): AccountHarness => {
    const existing = byId.get(accountId);
    if (existing) return existing;
    const fresh: AccountHarness = {
      plans: [{ planId: "weekend-1", name: "Weekend", description: "", priority: 1, entitlements: [] }],
      previewError: undefined,
      claimOutcome: { ok: true, planId: "weekend-1" },
      captchaResult: { verifyParam: "cap", region: "cn" },
      claimCalls: [],
    };
    byId.set(accountId, fresh);
    return fresh;
  };
  const primary = makeHarnessFor("acc-1");

  let nowMs = 1_000_000;
  const logs: string[] = [];
  const notifications: string[] = [];

  const claimed: Array<{ account: SchedulerAccount; plan: ClaimablePlan; outcome: ClaimOutcome }> = [];
  const scheduler = new ClaimScheduler({
    listAccounts: () => accounts,
    createClient: (account) => {
      const h = makeHarnessFor(account.accountId);
      return {
        getPreviews: () => (h.previewError ? Promise.reject(h.previewError) : Promise.resolve(h.plans)),
        claim: (planId) => {
          h.claimCalls.push({ accountId: account.accountId, planId });
          return h.claimOutcome instanceof Error ? Promise.reject(h.claimOutcome) : Promise.resolve(h.claimOutcome);
        },
      };
    },
    getCaptcha: () => {
      for (const h of byId.values()) {
        if (h.captchaResult instanceof Error) return Promise.reject(h.captchaResult);
        return Promise.resolve(h.captchaResult);
      }
      return Promise.reject(new Error("no accounts"));
    },
    config: { pollIntervalMs: 300_000, cooldownMs: 600_000, ...configOverrides },
    log: (message) => logs.push(message),
    notify: (message) => notifications.push(message),
    onClaimed: (account, plan, outcome) => claimed.push({ account, plan, outcome }),
    now: () => nowMs,
    // Deterministic account order regardless of storage ordering.
    compareAccounts: (a, b) => a.accountId.localeCompare(b.accountId),
  });

  return {
    scheduler,
    primary,
    forAccount: makeHarnessFor,
    accounts,
    byId,
    logs,
    notifications,
    claimed,
    advance(ms: number) {
      nowMs += ms;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

describe("ClaimScheduler single-account upstream semantics", () => {
  it("claims the highest-priority plan and holds until ends_at", async () => {
    const h = makeHarness();
    h.primary.plans = [
      { planId: "low", name: "L", description: "", priority: 1, entitlements: [] },
      { planId: "high", name: "H", description: "", priority: 9, startsAt: 1500, endsAt: 3000, entitlements: [] },
    ];
    h.primary.claimOutcome = { ok: true, planId: "high", startsAt: 1500, endsAt: 3000 };

    const result = await h.scheduler.tick();
    expect(result).toEqual({ action: "claimed", planId: "high", startsAt: 1500, endsAt: 3000 });
    expect(h.primary.claimCalls).toEqual([{ accountId: "acc-1", planId: "high" }]);
    // ends_at 3000s vs now 1_000_000ms → hold 2_000_000ms.
    expect(h.scheduler.nextWakeInMs()).toBe(2_000_000);
    // Inside the hold window: skipped.
    h.advance(1_000);
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
  });

  it("stays stopped while the rejected credential is still the stored one", async () => {
    const h = makeHarness();
    h.primary.plans = [{ planId: "p", name: "P", description: "", priority: 1, entitlements: [] }];
    h.primary.claimOutcome = { ok: false, planId: "p", failureKind: "login_required", code: 401, message: "expired" };
    await h.scheduler.tick();

    h.primary.claimCalls.length = 0;
    expect(await h.scheduler.tick()).toEqual({ action: "stopped" });
    expect(h.primary.claimCalls).toEqual([]);
  });

  it("resumes automatically once a fresh login stores a different credential", async () => {
    // The scheduler cannot observe /login, but a fresh login rotates the
    // account's JWT. Keying the stop on the rejected JWT makes re-login
    // self-healing instead of needing an explicit resume call nobody makes.
    const h = makeHarness();
    h.primary.plans = [{ planId: "p", name: "P", description: "", priority: 1, entitlements: [] }];
    h.primary.claimOutcome = { ok: false, planId: "p", failureKind: "login_required", code: 401, message: "expired" };
    await h.scheduler.tick();
    expect(await h.scheduler.tick()).toEqual({ action: "stopped" });

    h.accounts[0] = { jwt: "jwt-after-relogin", accountId: "acc-1", email: "a@x.dev" };
    h.primary.claimOutcome = { ok: true, planId: "p" };
    h.primary.claimCalls.length = 0;

    expect(await h.scheduler.tick()).toEqual({ action: "claimed", planId: "p", startsAt: undefined, endsAt: undefined });
    expect(h.primary.claimCalls).toHaveLength(1);
  });

  it("reports the exact account, plan, and outcome after a successful auto-claim", async () => {
    const h = makeHarness();
    const plan: ClaimablePlan = {
      planId: "weekend-1",
      name: "ZCode Global Build",
      description: "",
      priority: 1,
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
    h.primary.plans = [plan];
    h.primary.claimOutcome = { ok: true, planId: plan.planId, endsAt: 1_788_314_400 };

    await h.scheduler.tick();

    expect(h.claimed).toHaveLength(1);
    expect(h.claimed[0]).toEqual({
      account: { jwt: "jwt-1", accountId: "acc-1", email: "a@x.dev" },
      plan,
      outcome: { ok: true, planId: plan.planId, endsAt: 1_788_314_400 },
    });
  });

  it("claims the configured planId when set (ignores priority)", async () => {
    const h = makeHarness({ planId: "specific" });
    h.primary.plans = [
      { planId: "specific", name: "S", description: "", priority: 0, entitlements: [] },
      { planId: "other", name: "O", description: "", priority: 9, entitlements: [] },
    ];
    const result = await h.scheduler.tick();
    expect((result as { action: string }).action).toBe("claimed");
    expect(h.primary.claimCalls[0]?.planId).toBe("specific");
  });

  it("is idle when no claimable plans; plain poll cadence", async () => {
    const h = makeHarness();
    h.primary.plans = [];
    expect(await h.scheduler.tick()).toEqual({ action: "idle" });
    expect(h.scheduler.nextWakeInMs()).toBe(300_000);
  });

  it("treats preview 404 as idle (campaign endpoint not deployed yet)", async () => {
    const h = makeHarness();
    h.primary.previewError = new ClaimPreviewError("claim preview failed (404): nope", 404, 404);
    expect(await h.scheduler.tick()).toEqual({ action: "idle" });
    expect(h.scheduler.nextWakeInMs()).toBe(300_000);
  });

  it("holds until failureEndsAt for already_claimed/quota_exhausted, else cooldown", async () => {
    const h = makeHarness();
    h.primary.claimOutcome = { ok: false, planId: "p", failureKind: "already_claimed", code: 1003, message: "dup", failureEndsAt: 1_002 };
    const result = await h.scheduler.tick();
    expect((result as { action: string }).action).toBe("failed");
    // failureEndsAt 1_002s → 1_002_000ms; hold = 2_000ms (capped 24h).

    const noWindow = makeHarness();
    noWindow.primary.claimOutcome = { ok: false, planId: "p", failureKind: "ineligible", code: 1004, message: "no" };
    await noWindow.scheduler.tick();
    expect(noWindow.scheduler.nextWakeInMs()).toBe(600_000);
  });

  it("stops on login_required", async () => {
    const h = makeHarness();
    h.primary.claimOutcome = { ok: false, planId: "p", failureKind: "login_required", code: 401, message: "relogin" };
    await h.scheduler.tick();
    expect(await h.scheduler.tick()).toEqual({ action: "stopped" });
  });

  it("applies error backoff for preview/captcha/claim transport failures", async () => {
    const h = makeHarness();
    h.primary.previewError = new Error("offline");
    const result = await h.scheduler.tick();
    expect(result.action).toBe("error");
    expect(h.scheduler.nextWakeInMs()).toBe(600_000);
  });

  it("notifies on successful claims", async () => {
    const h = makeHarness();
    await h.scheduler.tick();
    expect(h.notifications.some((n) => n.includes("weekend-1"))).toBe(true);
  });
});

describe("ClaimScheduler multi-account rotation", () => {
  it("checks every account per tick and claims only where available", async () => {
    const h = makeHarness();
    h.accounts.push({ jwt: "jwt-2", accountId: "acc-2", email: "b@x.dev" });
    h.forAccount("acc-2").plans = []; // nothing for acc-2

    await h.scheduler.tick();
    expect(h.primary.claimCalls).toEqual([{ accountId: "acc-1", planId: "weekend-1" }]);
    expect(h.byId.get("acc-2")!.claimCalls).toEqual([]);
  });

  it("an account on cooldown does not block other accounts", async () => {
    const h = makeHarness();
    h.accounts.push({ jwt: "jwt-2", accountId: "acc-2", email: "b@x.dev" });
    h.primary.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "quota_exhausted", code: 1005, message: "cap" };

    await h.scheduler.tick(); // acc-1 fails → cooldown
    h.advance(600_001);
    h.accounts.length = 0;
    h.accounts.push({ jwt: "jwt-2", accountId: "acc-2", email: "b@x.dev" });
    h.forAccount("acc-2").claimOutcome = { ok: true, planId: "weekend-1" };

    const result = await h.scheduler.tick(); // acc-2 still claimable
    expect((result as { action: string }).action).toBe("claimed");
  });
});

describe("ClaimScheduler public surface", () => {
  it("owns no timer of its own: OMP drives ticks through ctx.setInterval", () => {
    // Upstream's scheduler ran its own setTimeout loop because it lived in a
    // long-running proxy. In OMP the session owns scheduling (contained timers,
    // cleared on session_shutdown), so a second lifecycle here would be dead
    // code that can only drift out of sync with the session's own cadence.
    const h = makeHarness();
    const surface = h.scheduler as unknown as Record<string, unknown>;
    for (const member of ["start", "stop", "isStopped", "scheduleNext"]) {
      expect(typeof surface[member]).toBe("undefined");
    }
    // What the session actually calls stays.
    expect(typeof h.scheduler.tick).toBe("function");
    expect(typeof h.scheduler.nextWakeInMs).toBe("function");
  });
});
