/**
 * Claim client tests.
 * Ports zcode-api `src/claim/client.test.ts` (v4.5.3) onto the OMP boundary:
 * mock fetch asserts request shape (URL, query, identity headers, captcha
 * headers, auth) and canned responses verify preview parsing and claim
 * biz-code mapping.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  ClaimPreviewError,
  classifyClaimCode,
  createClaimClient,
  highestPriorityPlan,
  parseRetryAfterMs,
  selectClaimTarget,
} from "../src/claim.js";
import { accountState, resetAccountState } from "../src/account-state.js";
import { asFetch } from "./fetch-stub.js";
import type { FetchHandler } from "./fetch-stub.js";

const ACCOUNT = "u-claim";
const JWT = "jwt-claim";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  headers: Headers;
  body: string;
}

function recorder(handler: FetchHandler): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = asFetch(async (input, init) => {
    const request = new Request(input, init);
    const call: Call = {
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      headers: request.headers,
      body: await request.text(),
    };
    calls.push(call);
    return handler(input, init);
  });
  return { calls, fetchImpl };
}

const onePlanBody = {
  code: 0,
  data: {
    plans: [
      {
        plan_id: "weekend-free-1024",
        name: "Weekend Build",
        description: "trial",
        priority: 5,
        ends_at: 1900000000,
        entitlements: [
          {
            entitlement_id: "ent-1",
            show_name: "GLM-5.3",
            meter: "model_usage",
            unit_type: "token",
            capabilities: ["model:glm-5.3"],
            grant_units: 1024,
            period: "one_time",
            priority: 1,
          },
        ],
      },
    ],
  },
};

beforeAll(() => {
  // Warm the device id so identity headers are stable across assertions.
  accountState(ACCOUNT);
});

afterAll(() => {
  resetAccountState();
});

describe("preview", () => {
  it("fetches preview with app_version + platform query and parses plans", async () => {
    const { calls, fetchImpl } = recorder(async () => jsonResponse(onePlanBody));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    const plans = await client.getPreviews();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.10.1&platform=linux-x64",
    );
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.planId).toBe("weekend-free-1024");
    expect(plan.name).toBe("Weekend Build");
    expect(plan.entitlements[0]).toMatchObject({
      entitlementId: "ent-1",
      showName: "GLM-5.3",
      grantUnits: 1024,
      period: "one_time",
      capabilities: ["model:glm-5.3"],
    });
  });

  it("throws ClaimPreviewError with status and biz code on failure", async () => {
    const { fetchImpl } = recorder(async () => jsonResponse({ code: 3001, msg: "parameter error" }, 400));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    try {
      await client.getPreviews();
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).name).toBe("ClaimPreviewError");
      expect((error as Error).message).toContain("3001");
    }
  });

  it("preserves Retry-After seconds from a 429 so the scheduler can honour it", async () => {
    const { fetchImpl } = recorder(async () => new Response("HTTP 429", { status: 429, headers: { "retry-after": "120" } }));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    try {
      await client.getPreviews();
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimPreviewError);
      expect((error as ClaimPreviewError).status).toBe(429);
      expect((error as ClaimPreviewError).retryAfterMs).toBe(120_000);
    }
  });

  it("leaves retryAfterMs unset when the gateway sends no Retry-After", async () => {
    const { fetchImpl } = recorder(async () => new Response("HTTP 429", { status: 429 }));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    try {
      await client.getPreviews();
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as ClaimPreviewError).retryAfterMs).toBeUndefined();
    }
  });
});

describe("identity header set", () => {
  it("carries UUID device id and full identity minus X-ZCode-Agent on both calls", async () => {
    const seen: Array<{ path: string; deviceMid: string | null; agent: string | null; version: string | null }> = [];
    const { fetchImpl } = recorder(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      seen.push({
        path: url.pathname,
        deviceMid: request.headers.get("x-device-mid"),
        agent: request.headers.get("x-zcode-agent"),
        version: request.headers.get("x-zcode-app-version"),
      });
      return jsonResponse(onePlanBody);
    });
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    await client.getPreviews();
    await client.claim("weekend-free-1024", { verifyParam: "cap-token", region: "cn-hangzhou" });

    expect(seen).toHaveLength(2);
    expect(seen[0].path).toBe("/api/v1/zcode-plan/billing/preview");
    expect(seen[1].path).toBe("/api/v1/zcode-plan/billing/claim");
    for (const entry of seen) {
      // UUID-format device identity is server-required (biz 3001 otherwise).
      expect(entry.deviceMid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(entry.deviceMid).toBe(accountState(ACCOUNT).deviceMid);
      // Control-plane precedent: no agent header on billing calls.
      expect(entry.agent).toBeNull();
      expect(entry.version).toBe("3.10.1");
    }
  });

  it("gives different accounts different device ids", async () => {
    const seen: string[] = [];
    const { fetchImpl } = recorder(async (input, init) => {
      const request = new Request(input, init);
      seen.push(request.headers.get("x-device-mid") ?? "");
      return jsonResponse(onePlanBody);
    });
    await createClaimClient({ account: { jwt: JWT, accountId: "u-a" }, fetchImpl }).getPreviews();
    await createClaimClient({ account: { jwt: JWT, accountId: "u-b" }, fetchImpl }).getPreviews();
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("claim", () => {
  async function capture(request: Request) {
    return {
      url: request.url,
      auth: request.headers.get("authorization"),
      captchaParam: request.headers.get("x-aliyun-captcha-verify-param"),
      captchaRegion: request.headers.get("x-aliyun-captcha-verify-region"),
      body: await request.text(),
    };
  }

  it("posts plan_id with captcha headers and parses success window", async () => {
    let captured: Awaited<ReturnType<typeof capture>> | undefined;
    const { fetchImpl } = recorder(async (input, init) => {
      captured = await capture(new Request(input, init));
      return jsonResponse({
        code: 0,
        data: { plan: { plan_id: "weekend-free-1024", starts_at: 1000, ends_at: 2000 } },
      });
    });
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    const outcome = await client.claim("weekend-free-1024", { verifyParam: "cap-token", region: "cn-hangzhou" });

    expect(captured!.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/claim");
    expect(captured!.auth).toBe(`Bearer ${JWT}`);
    expect(captured!.captchaParam).toBe("cap-token");
    expect(captured!.captchaRegion).toBe("cn-hangzhou");
    expect(JSON.parse(captured!.body)).toEqual({ plan_id: "weekend-free-1024" });
    expect(outcome).toEqual({ ok: true, planId: "weekend-free-1024", startsAt: 1000, endsAt: 2000 });
  });

  it("omits the region header when the captcha has none", async () => {
    let region: string | null = null;
    const { fetchImpl } = recorder(async (input, init) => {
      region = new Request(input, init).headers.get("x-aliyun-captcha-verify-region");
      return jsonResponse({ code: 0, data: { plan: { plan_id: "p1" } } });
    });
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    await client.claim("p1", { verifyParam: "t" });
    expect(region).toBeNull();
  });

  it.each([
    [1001, "not_found"],
    [1002, "unavailable"],
    [1003, "already_claimed"],
    [1004, "ineligible"],
    [1005, "quota_exhausted"],
    [3001, "invalid_request"],
    [3007, "captcha"],
  ] as const)("maps biz code %i to %s", async (code, kind) => {
    const { fetchImpl } = recorder(async () => jsonResponse({ code, msg: "failure" }));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    const outcome = await client.claim("p1", { verifyParam: "t" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failureKind).toBe(kind);
      expect(outcome.code).toBe(code);
    }
  });

  it("derives http_error and login_required from HTTP status alone", async () => {
    const serverError = recorder(async () => jsonResponse({ msg: "boom" }, 500));
    const c1 = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl: serverError.fetchImpl });
    const out1 = await c1.claim("p1", { verifyParam: "t" });
    expect(out1.ok).toBe(false);
    if (!out1.ok) expect(out1.failureKind).toBe("http_error");

    const unauthorized = recorder(async () => jsonResponse({ msg: "nope" }, 401));
    const c2 = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl: unauthorized.fetchImpl });
    const out2 = await c2.claim("p1", { verifyParam: "t" });
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.failureKind).toBe("login_required");
  });

  it("never places the JWT in a failure message", async () => {
    const { fetchImpl } = recorder(async () => jsonResponse({ msg: "denied" }, 403));
    const client = createClaimClient({ account: { jwt: JWT, accountId: ACCOUNT }, fetchImpl });
    const outcome = await client.claim("p1", { verifyParam: "t" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).not.toContain(JWT);
  });
});

describe("classification and selection helpers", () => {
  it("classifies unknown codes as unknown", () => {
    expect(classifyClaimCode(4999)).toBe("unknown");
    expect(classifyClaimCode("garbage")).toBe("unknown");
  });

  it("selects the configured planId before priority", () => {
    const plans = [
      { planId: "low", name: "L", description: "", priority: 1, entitlements: [] },
      { planId: "high", name: "H", description: "", priority: 9, entitlements: [] },
    ];
    expect(highestPriorityPlan(plans)?.planId).toBe("high");
    expect(selectClaimTarget(plans)?.planId).toBe("high");
    expect(selectClaimTarget(plans, "low")?.planId).toBe("low");
    expect(selectClaimTarget(plans, "missing")).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  // RFC 9110 allows both forms; the ZCode gateway has been observed sending
  // neither, so "absent/garbage → undefined" is the load-bearing case: the
  // scheduler then falls back to its own cooldown instead of a bogus 0ms.
  it("reads delay-seconds", () => {
    expect(parseRetryAfterMs("30", 1_000)).toBe(30_000);
  });

  it("reads an HTTP-date relative to now", () => {
    const nowMs = Date.parse("2026-09-03T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 03 Sep 2026 00:02:00 GMT", nowMs)).toBe(120_000);
  });

  it("ignores a past HTTP-date, empty, and unparseable values", () => {
    const nowMs = Date.parse("2026-09-03T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 03 Sep 2026 00:00:00 GMT", nowMs)).toBeUndefined();
    expect(parseRetryAfterMs("Wed, 02 Sep 2026 23:59:00 GMT", nowMs)).toBeUndefined();
    expect(parseRetryAfterMs("", nowMs)).toBeUndefined();
    expect(parseRetryAfterMs("soon", nowMs)).toBeUndefined();
    expect(parseRetryAfterMs(null, nowMs)).toBeUndefined();
  });

  it("clamps an absurd delay to a day so one bad header cannot park claiming forever", () => {
    expect(parseRetryAfterMs("999999999", 0)).toBe(24 * 60 * 60 * 1000);
  });
});
