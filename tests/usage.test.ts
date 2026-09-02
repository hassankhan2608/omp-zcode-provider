/**
 * Per-account usage over the ZCode Start Plan balance endpoint.
 *
 * The fixture is the live response shape observed 2026-08-29 from
 * `GET /api/v1/zcode-plan/billing/balance` (two active plans, three buckets).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams, UsageReport } from "@oh-my-pi/pi-ai";
import { accountState, resetAccountState } from "../src/account-state.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { resetUsageCache, zcodeUsageProvider } from "../src/usage.js";

const JWT = "plan-jwt-value";

function liveBalance(): unknown {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1788004266,
      plans: [
        {
          user_plan_id: "upl_a",
          plan_id: "zcode-v3-start-plan-0828",
          name: "ZCode Weekend Build",
          status: "active",
          ends_at: 1788138000,
          entitlements: [{ entitlement_id: "ent_wk", period: "one_time" }],
        },
        {
          user_plan_id: "upl_b",
          plan_id: "zcode-v3-start-plan-0817",
          name: "ZCode Start Plan",
          status: "active",
          ends_at: 1788278399,
          entitlements: [
            { entitlement_id: "ent_53", period: "daily" },
            { entitlement_id: "ent_53f", period: "daily" },
          ],
        },
      ],
      balances: [
        {
          bucket_id: "bucket_wk",
          plan_id: "zcode-v3-start-plan-0828",
          entitlement_id: "ent_wk",
          show_name: "GLM-5.3-Flash",
          meter: "model_usage",
          unit_type: "token",
          capabilities: ["model:glm-5.3-flash"],
          total_units: 300_000_000,
          used_units: 20_196,
          remaining_units: 299_979_804,
          available_units: 299_979_804,
          period_end: 1788138000,
        },
        {
          bucket_id: "bucket_53",
          plan_id: "zcode-v3-start-plan-0817",
          entitlement_id: "ent_53",
          show_name: "GLM-5.3",
          meter: "model_usage",
          unit_type: "token",
          capabilities: ["model:glm-5.3"],
          total_units: 3_000_000,
          used_units: 15_222,
          available_units: 2_984_778,
          period_end: 1788019199,
        },
        {
          bucket_id: "bucket_53f",
          plan_id: "zcode-v3-start-plan-0817",
          entitlement_id: "ent_53f",
          show_name: "GLM-5.3-Flash",
          meter: "model_usage",
          unit_type: "token",
          capabilities: ["model:glm-5.3-flash"],
          total_units: 5_000_000,
          used_units: 0,
          available_units: 5_000_000,
          period_end: 1788019199,
        },
      ],
    },
  };
}

interface Call {
  url: string;
  auth: string | null;
  headers: Headers;
}

function ctxFor(handler: (call: Call) => Response): { calls: Call[]; ctx: UsageFetchContext } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: Call = { url: request.url, auth: request.headers.get("authorization"), headers: request.headers };
    calls.push(call);
    return handler(call);
  }) as UsageFetchContext["fetch"];
  return { calls, ctx: { fetch: fetchImpl } };
}

function params(accountId = "u-1", email?: string): UsageFetchParams {
  return {
    provider: "zcode",
    credential: { type: "oauth", accessToken: JWT, accountId, ...(email ? { email } : {}) },
    accountKey: `account:${accountId}`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  resetUsageCache();
  resetAccountState();
});

describe("request shape", () => {
  it("calls the balance endpoint with a raw Authorization header", async () => {
    const { calls, ctx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params(), ctx);

    expect(calls[0].url).toStartWith("https://zcode.z.ai/api/v1/zcode-plan/billing/balance?");
    expect(calls[0].url).toContain("app_version=");
    // No `Bearer` prefix — matches the desktop client's
    // `fetchZaiStartPlanBalanceEnvelope`.
    expect(calls[0].auth).toBe(JWT);
  });

  it("sends the ZCode identity headers, without which the gateway answers 3001", async () => {
    const { calls, ctx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params(), ctx);

    const headers = calls[0].headers;
    expect(headers.get("http-referer")).toBe("https://zcode.z.ai");
    expect(headers.get("user-agent")).toBe("ZCode/3.10.1");
    expect(headers.get("x-title")).toBe("Z Code@cli");
    expect(headers.get("x-device-mid")).toBe(accountState("u-1").deviceMid);
  });

  it("uses each account's own device id", async () => {
    const { calls, ctx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params("u-1"), ctx);
    await zcodeUsageProvider.fetchUsage(params("u-2"), ctx);
    expect(calls[0].headers.get("x-device-mid")).not.toBe(calls[1].headers.get("x-device-mid"));
  });
});

describe("report mapping", () => {
  it("surfaces every entitlement bucket", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;

    expect(report.provider).toBe("zcode");
    expect(report.fetchedAt).toBe(1788004266_000);
    expect(report.limits.map((limit) => limit.id)).toEqual(["bucket_wk", "bucket_53", "bucket_53f"]);
    expect(report.notes).toEqual(["Plans: ZCode Weekend Build, ZCode Start Plan"]);
  });

  it("scopes each limit to the account and the model it covers", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    const glm53 = report.limits.find((limit) => limit.id === "bucket_53")!;

    expect(glm53.scope.provider).toBe("zcode");
    expect(glm53.scope.accountId).toBe("u-1");
    // `capabilities: ["model:glm-5.3"]` → prefix stripped, then resolved to the
    // registered catalog casing. OMP matches `scope.modelId === model.id`
    // exactly, so a lowercase scope would detach the limit from the model.
    expect(glm53.scope.modelId).toBe("GLM-5.3");
    expect(FALLBACK_MODELS.some((model) => model.id === glm53.scope.modelId)).toBe(true);
    expect(glm53.scope.tier).toBe("zcode-v3-start-plan-0817");
    expect(glm53.scope.windowId).toBe("daily");
  });

  it("maps token amounts and the period window", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    const glm53 = report.limits.find((limit) => limit.id === "bucket_53")!;

    expect(glm53.amount).toEqual({ used: 15_222, limit: 3_000_000, remaining: 2_984_778, unit: "tokens" });
    expect(glm53.window).toEqual({ id: "daily", label: "Daily", resetsAt: 1788019199_000 });
    expect(glm53.status).toBe("ok");
    expect(glm53.label).toBe("GLM-5.3 · ZCode Start Plan");
  });

  it("labels a one-time window from the plan entitlement period", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits.find((limit) => limit.id === "bucket_wk")!.window!.label).toBe("One-time");
  });

  it("marks an emptied bucket exhausted so credential ranking can move on", async () => {
    const body = liveBalance() as { data: { balances: Array<Record<string, unknown>> } };
    body.data.balances[1].available_units = 0;
    body.data.balances[1].used_units = 3_000_000;
    const { ctx } = ctxFor(() => json(body));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits.find((limit) => limit.id === "bucket_53")!.status).toBe("exhausted");
  });

  it("warns from ninety percent consumed", async () => {
    const body = liveBalance() as { data: { balances: Array<Record<string, unknown>> } };
    body.data.balances[1].used_units = 2_800_000;
    body.data.balances[1].available_units = 200_000;
    const { ctx } = ctxFor(() => json(body));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits.find((limit) => limit.id === "bucket_53")!.status).toBe("warning");
  });

  it("lists every covered model when a bucket spans more than one", async () => {
    const body = liveBalance() as { data: { balances: Array<Record<string, unknown>> } };
    body.data.balances[1].capabilities = ["model:glm-5.3", "model:glm-5.3-flash"];
    const { ctx } = ctxFor(() => json(body));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    const limit = report.limits.find((entry) => entry.id === "bucket_53")!;
    expect(limit.scope.modelId).toBeUndefined();
    expect(limit.notes).toEqual(["Models: GLM-5.3, GLM-5.3-Flash"]);
  });

  it("passes an unrecognized capability id through unchanged", async () => {
    const body = liveBalance() as { data: { balances: Array<Record<string, unknown>> } };
    body.data.balances[1].capabilities = ["model:glm-9-experimental"];
    const { ctx } = ctxFor(() => json(body));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits.find((entry) => entry.id === "bucket_53")!.scope.modelId).toBe("glm-9-experimental");
  });

  it("falls back to show_name when a bucket names no capability", async () => {
    const body = liveBalance() as { data: { balances: Array<Record<string, unknown>> } };
    body.data.balances[1].capabilities = [];
    const { ctx } = ctxFor(() => json(body));
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits.find((entry) => entry.id === "bucket_53")!.scope.modelId).toBe("GLM-5.3");
  });
});

describe("account labeling", () => {
  it("carries the credential email in report metadata for OMP's usage rows", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params("u-1", "lunaris-knight@proton.me"), ctx))!;
    expect(report.metadata).toEqual({ accountId: "u-1", email: "lunaris-knight@proton.me" });
  });

  it("still sets accountId when the credential has no email", async () => {
    const { ctx } = ctxFor(() => json(liveBalance()));
    const report = (await zcodeUsageProvider.fetchUsage(params("u-1"), ctx))!;
    expect(report.metadata).toEqual({ accountId: "u-1" });
  });

  it("keeps the email on the stale report served after a failed refresh", async () => {
    const { ctx: goodCtx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params("u-1", "lunaris-knight@proton.me"), goodCtx);
    const { ctx: badCtx } = ctxFor(() => json({}, 503));
    const report = (await zcodeUsageProvider.fetchUsage(params("u-1", "lunaris-knight@proton.me"), badCtx))!;
    expect(report.metadata?.email).toBe("lunaris-knight@proton.me");
    expect(report.notes!.some((note) => note.startsWith("Stale —"))).toBe(true);
  });
});

describe("per-account isolation", () => {
  it("fetches independently for each stored account", async () => {
    const { calls, ctx } = ctxFor(() => json(liveBalance()));
    const first = (await zcodeUsageProvider.fetchUsage(params("u-1"), ctx))!;
    const second = (await zcodeUsageProvider.fetchUsage(params("u-2"), ctx))!;

    expect(calls).toHaveLength(2);
    expect(first.limits[0].scope.accountId).toBe("u-1");
    expect(second.limits[0].scope.accountId).toBe("u-2");
  });

  it("keeps one account's stale data out of another's report", async () => {
    const { ctx: goodCtx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params("u-1"), goodCtx);

    const { ctx: badCtx } = ctxFor(() => json({ code: 3001, msg: "parameter error" }));
    expect(await zcodeUsageProvider.fetchUsage(params("u-2"), badCtx)).toBeNull();
  });
});

describe("failure policy", () => {
  async function primeThenFail(failure: () => Response): Promise<UsageReport | null> {
    const { ctx: goodCtx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params(), goodCtx);
    const { ctx: badCtx } = ctxFor(failure);
    return zcodeUsageProvider.fetchUsage(params(), badCtx);
  }

  it("serves the last-known usage marked stale on an HTTP failure", async () => {
    const report = (await primeThenFail(() => json({}, 503)))!;
    expect(report.limits.map((limit) => limit.id)).toEqual(["bucket_wk", "bucket_53", "bucket_53f"]);
    // Amounts survive verbatim; only the status is downgraded.
    expect(report.limits[1].amount.remaining).toBe(2_984_778);
    expect(report.limits.every((limit) => limit.status === "unknown")).toBe(true);
    expect(report.notes!.some((note) => note.startsWith("Stale —"))).toBe(true);
  });

  it("serves the last-known usage on a business-code rejection", async () => {
    const report = (await primeThenFail(() => json({ code: 3001, msg: "parameter error" })))!;
    expect(report.notes!.join(" ")).toContain("parameter error");
    expect(report.limits).toHaveLength(3);
  });

  it("serves the last-known usage on a transport failure", async () => {
    const { ctx: goodCtx } = ctxFor(() => json(liveBalance()));
    await zcodeUsageProvider.fetchUsage(params(), goodCtx);
    const ctx: UsageFetchContext = {
      fetch: (async () => {
        throw new Error("offline");
      }),
    };
    const report = (await zcodeUsageProvider.fetchUsage(params(), ctx))!;
    expect(report.limits).toHaveLength(3);
    expect(report.notes!.join(" ")).toContain("could not be completed");
  });

  it("never reports a zero quota in place of an unavailable refresh", async () => {
    const report = (await primeThenFail(() => json({ code: 0, data: { plans: [], balances: [] } })))!;
    expect(report.limits).toHaveLength(3);
    expect(report.limits[1].amount.limit).toBe(3_000_000);
  });

  it("returns null when nothing was ever fetched and the refresh fails", async () => {
    const { ctx } = ctxFor(() => json({}, 503));
    expect(await zcodeUsageProvider.fetchUsage(params(), ctx)).toBeNull();
  });

  it("returns null when the account has no stored credential", async () => {
    const { calls, ctx } = ctxFor(() => json(liveBalance()));
    const result = await zcodeUsageProvider.fetchUsage(
      { provider: "zcode", credential: { type: "oauth" }, accountKey: "account:u-1" },
      ctx,
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("declares itself a credential validator that retains last-good data", () => {
    expect(zcodeUsageProvider.validatesCredentials).toBe(true);
    expect(zcodeUsageProvider.retainLastGoodOnFailure).toBe(true);
  });
});
