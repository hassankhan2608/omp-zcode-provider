/**
 * Start Plan request pipeline.
 *
 * Asserts wire parity with zcode-api: `src/proxy/upstream.ts`
 * (`buildUpstreamURL` / `buildAuthHeaders` / `buildTraceHeaders` with
 * `plan === "start-plan"`) and `src/proxy/handler.ts` (captcha acquisition,
 * single captcha retry, 401 handling, ordering between the two).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { CaptchaModule } from "../src/captcha-module.js";
import { accountState, resetAccountState } from "../src/account-state.js";
import {
  dispatchStartPlanRequest,
  STARTPLAN_MESSAGES_URL,
  StartPlanAuthError,
} from "../src/request.js";
import { asFetch } from "./fetch-stub.js";

const JWT = "jwt-token-value";
const ACCOUNT = "u-1";

interface Capture {
  url: string;
  headers: Headers;
  body: string;
}

interface CaptchaStub extends CaptchaModule {
  urgent: number;
  solves: number;
}

/** Captcha stub: hands out a deterministic token, records urgent refills. */
function captchaStub(overrides: Partial<CaptchaModule> = {}): CaptchaStub {
  const stub: CaptchaStub = {
    solves: 0,
    urgent: 0,
    async getCaptchaToken(): Promise<{ verifyParam: string; region: string }> {
      stub.solves += 1;
      return { verifyParam: `param-${stub.solves}`, region: "sgp" };
    },
    urgentCaptcha() {
      stub.urgent += 1;
    },
    async startCaptchaPool() {},
    shutdownCaptcha() {},
    ...overrides,
  };
  return stub;
}

function recorder(responses: Response[]): { calls: Capture[]; fetchImpl: typeof fetch } {
  const calls: Capture[] = [];
  let index = 0;
  const fetchImpl = asFetch(async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: request.headers, body: await request.text() });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return response;
  });
  return { calls, fetchImpl };
}

function ok(body = '{"id":"msg"}', headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });
}

function challenged(): Response {
  return ok("{}", { "x-aliyun-captcha-verify-param": "challenge" });
}

function messagesBody(): string {
  return JSON.stringify({ model: "GLM-5.3", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
}

async function dispatch(
  responses: Response[],
  captcha: CaptchaModule,
  extraHeaders: Record<string, string> = {},
  accountId = ACCOUNT,
): Promise<{ calls: Capture[]; response: Response }> {
  const { calls, fetchImpl } = recorder(responses);
  const response = await dispatchStartPlanRequest(
    { accountId, jwt: JWT, fetchImpl, captcha },
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      body: messagesBody(),
      headers: { "x-api-key": "leaked", "content-type": "application/json", ...extraHeaders },
    },
  );
  return { calls, response };
}

afterEach(() => {
  resetAccountState();
});

describe("upstream target", () => {
  it("targets the Start Plan Anthropic gateway regardless of the caller's URL", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.url).toBe(STARTPLAN_MESSAGES_URL);
    expect(STARTPLAN_MESSAGES_URL).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");
  });
});

describe("auth headers", () => {
  it("authenticates with the plan JWT as a bearer token", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("never forwards an inbound x-api-key", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
  });
});

describe("identity headers", () => {
  it("sends the ZCode desktop fingerprint with this account's device id", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    const headers = calls[0]!.headers;
    expect(headers.get("http-referer")).toBe("https://zcode.z.ai");
    expect(headers.get("user-agent")).toBe("ZCode/3.10.1");
    expect(headers.get("x-zcode-app-version")).toBe("3.10.1");
    expect(headers.get("x-title")).toBe("Z Code@cli");
    expect(headers.get("x-zcode-agent")).toBe("glm");
    expect(headers.get("x-release-channel")).toBe("production");
    expect(headers.get("x-device-mid")).toBe(accountState(ACCOUNT).deviceMid);
  });

  it("gives each account a different device id", async () => {
    const first = await dispatch([ok()], captchaStub(), {}, "u-1");
    const second = await dispatch([ok()], captchaStub(), {}, "u-2");
    expect(first.calls[0]!.headers.get("x-device-mid")).not.toBe(second.calls[0]!.headers.get("x-device-mid"));
  });
});

describe("trace headers", () => {
  it("emits fresh trace ids per request", async () => {
    const first = await dispatch([ok()], captchaStub());
    const second = await dispatch([ok()], captchaStub());
    expect(first.calls[0]!.headers.get("x-zcode-session-type")).toBe("main");
    expect(first.calls[0]!.headers.get("x-request-id")).not.toBe(second.calls[0]!.headers.get("x-request-id"));
    expect(first.calls[0]!.headers.get("x-zcode-trace-id")).not.toBe(
      second.calls[0]!.headers.get("x-zcode-trace-id"),
    );
  });

  it("omits x-query-id and x-session-id, which start-plan does not send", async () => {
    // zcode-api `buildTraceHeaders` emits both only when plan !== "start-plan".
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("x-query-id")).toBeNull();
    expect(calls[0]!.headers.get("x-session-id")).toBeNull();
  });

  it("sends no cookie jar, matching zcode-api's start-plan path", async () => {
    const { calls } = await dispatch([ok("{}", { "set-cookie": "acw_tc=abc; Path=/" })], captchaStub());
    expect(calls[0]!.headers.get("cookie")).toBeNull();

    // A gateway set-cookie must not start being replayed on the next request.
    const next = await dispatch([ok()], captchaStub());
    expect(next.calls[0]!.headers.get("cookie")).toBeNull();
  });
});

describe("inbound header passthrough", () => {
  // zcode-api `collectPassthroughHeaders` forwards ONLY anthropic-beta; the rest
  // of the upstream set is rebuilt. OMP's Anthropic client emits a Claude-shaped
  // fingerprint that must not reach a ZCode gateway.
  const CLAUDE_FINGERPRINT = {
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    accept: "text/event-stream",
    connection: "keep-alive",
    "x-client-request-id": "claude-req-1",
    "user-agent": "claude-cli/1.2.3",
  };

  it("drops every Claude-shaped header OMP's anthropic client adds", async () => {
    const { calls } = await dispatch([ok()], captchaStub(), CLAUDE_FINGERPRINT);
    const headers = calls[0]!.headers;
    expect(headers.get("x-app")).toBeNull();
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBeNull();
    expect(headers.get("accept")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("x-client-request-id")).toBeNull();
    // User-Agent is rebuilt as the ZCode desktop client, never forwarded.
    expect(headers.get("user-agent")).toBe("ZCode/3.10.1");
  });

  it("forwards anthropic-beta, the one header zcode-api passes through", async () => {
    const { calls } = await dispatch([ok()], captchaStub(), { "anthropic-beta": "effort-2025-11-24" });
    expect(calls[0]!.headers.get("anthropic-beta")).toBe("effort-2025-11-24");
  });

  it("drops inbound trace ids instead of forwarding client-supplied ones", async () => {
    const { calls } = await dispatch([ok()], captchaStub(), {
      "x-query-id": "spoofed",
      "x-session-id": "spoofed",
      "x-request-id": "spoofed",
      "x-zcode-trace-id": "spoofed",
    });
    const headers = calls[0]!.headers;
    expect(headers.get("x-query-id")).toBeNull();
    expect(headers.get("x-session-id")).toBeNull();
    expect(headers.get("x-request-id")).not.toBe("spoofed");
    expect(headers.get("x-zcode-trace-id")).not.toBe("spoofed");
  });

  it("emits exactly the reference header set", async () => {
    const { calls } = await dispatch([ok()], captchaStub(), CLAUDE_FINGERPRINT);
    // Verbatim from zcode-api `serve debug` for the same request.
    expect([...calls[0]!.headers.keys()].sort()).toEqual([
      "accept-encoding",
      "anthropic-version",
      "authorization",
      "content-type",
      "http-referer",
      "user-agent",
      "x-aliyun-captcha-verify-param",
      "x-aliyun-captcha-verify-region",
      "x-client-language",
      "x-client-timezone",
      "x-device-mid",
      "x-os-category",
      "x-os-version",
      "x-platform",
      "x-release-channel",
      "x-request-id",
      "x-title",
      "x-zcode-agent",
      "x-zcode-app-version",
      "x-zcode-session-type",
      "x-zcode-trace-id",
    ]);
  });
});

describe("content negotiation", () => {
  it("defaults accept-encoding to gzip", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("accept-encoding")).toBe("gzip");
  });

  it("forwards the caller's accept-encoding when it set one", async () => {
    const { calls } = await dispatch([ok()], captchaStub(), { "accept-encoding": "identity" });
    expect(calls[0]!.headers.get("accept-encoding")).toBe("identity");
  });

  it("sends json content-type", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  });
});

describe("body transforms", () => {
  it("prepends the ZCode system blocks and marks cache_control", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    const sent = JSON.parse(calls[0]!.body) as {
      system: Array<{ text: string }>;
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
    };
    expect(sent.system[0]!.text).toBe("You are ZCode, an interactive coding agent");
    expect(sent.system.at(-1)!.text).toBe("- You are powered by the model named GLM-5.3.");
    expect(sent.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("captcha", () => {
  it("attaches the pooled verify param and region", async () => {
    const { calls } = await dispatch([ok()], captchaStub());
    expect(calls[0]!.headers.get("x-aliyun-captcha-verify-param")).toBe("param-1");
    expect(calls[0]!.headers.get("x-aliyun-captcha-verify-region")).toBe("sgp");
  });

  it("retries exactly once with a fresh token on an explicit challenge", async () => {
    const captcha = captchaStub();
    const { calls } = await dispatch([challenged(), ok()], captcha);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("x-aliyun-captcha-verify-param")).toBe("param-1");
    expect(calls[1]!.headers.get("x-aliyun-captcha-verify-param")).toBe("param-2");
    expect(captcha.urgent).toBe(1);
  });

  it("does not retry a second time when the retry is also challenged", async () => {
    const { calls } = await dispatch([challenged(), challenged(), ok()], captchaStub());
    expect(calls).toHaveLength(2);
  });

  it("proceeds without a token when the first solve fails, letting the gateway decide", async () => {
    const captcha = captchaStub({
      async getCaptchaToken() {
        throw new Error("solver unavailable");
      },
    });
    const { calls, response } = await dispatch([ok()], captcha);
    expect(calls[0]!.headers.get("x-aliyun-captcha-verify-param")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("fails the request when the retry solve fails, as zcode-api does", async () => {
    let first = true;
    const captcha = captchaStub({
      async getCaptchaToken() {
        if (first) {
          first = false;
          return { verifyParam: "param-1", region: "sgp" };
        }
        throw new Error("solver unavailable");
      },
    });
    // By this point the gateway has proven captcha is mandatory, so an unsigned
    // retry could only be rejected again.
    await expect(dispatch([challenged(), ok()], captcha)).rejects.toThrow(/solver unavailable/);
  });

  it("counts gateway rejections, not local solver failures", async () => {
    const solverDown = captchaStub({
      async getCaptchaToken() {
        throw new Error("solver unavailable");
      },
    });
    await dispatch([ok()], solverDown);
    // A machine-wide solver outage is not an account-health signal.
    expect(accountState(ACCOUNT).captchaFailures).toBe(0);

    await dispatch([challenged(), challenged()], captchaStub());
    expect(accountState(ACCOUNT).captchaFailures).toBe(1);
    expect(accountState(ACCOUNT).lastCaptchaFailureAt).toBeDefined();
  });

  it("clears the failure counter after an accepted request", async () => {
    accountState(ACCOUNT).captchaFailures = 3;
    await dispatch([ok()], captchaStub());
    expect(accountState(ACCOUNT).captchaFailures).toBe(0);
  });

  it("treats a challenged 200 as a rejection, not an acceptance", async () => {
    accountState(ACCOUNT).captchaFailures = 0;
    await dispatch([challenged(), challenged()], captchaStub());
    expect(accountState(ACCOUNT).captchaFailures).toBe(1);
  });
});

describe("gateway resilience (upstream v4.5.0)", () => {

  it("treats an in-body code:3007 rejection as a captcha challenge (upstream 0b0a4e0)", async () => {
    const captcha = captchaStub();
    const inBodyChallenge = new Response(
      JSON.stringify({ code: 3007, msg: "captcha verify failed" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const { calls } = await dispatch([inBodyChallenge, ok()], captcha);
    // The gateway did not set the challenge header; the JSON body is the signal.
    expect(calls[0]!.headers.get("x-aliyun-captcha-verify-param")).toBe("param-1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("x-aliyun-captcha-verify-param")).toBe("param-2");
    expect(captcha.urgent).toBe(1);
  });

  it("accepts the spaced code: 3007 body variant too", async () => {
    const inBodyChallenge = new Response(
      JSON.stringify({ code: 3007, msg: "captcha verify failed" }).replace('"code":3007', '"code": 3007'),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const { calls } = await dispatch([inBodyChallenge, ok()], captchaStub());
    expect(calls).toHaveLength(2);
  });

  it("does not retry on an ordinary non-ok error body", async () => {
    const blocked = new Response(JSON.stringify({ code: 3012, msg: "blocked" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
    const { calls } = await dispatch([blocked], captchaStub());
    expect(calls).toHaveLength(1);
  });

  it("never retries an in-body challenge on the SSE error path", async () => {
    const sseChallenge = new Response('{"code":3007,"msg":"captcha"}', {
      status: 400,
      headers: { "content-type": "text/event-stream" },
    });
    const { calls } = await dispatch([sseChallenge], captchaStub());
    expect(calls).toHaveLength(1);
  });

  it("retries transient connect failures up to three attempts (upstream 7dd6818)", async () => {
    const calls: Array<{ body: string }> = [];
    const captcha = captchaStub();
    let attempt = 0;
    const fetchImpl = asFetch(async (input, init) => {
      const request = new Request(input, init);
      calls.push({ body: await request.text() });
      attempt += 1;
      if (attempt < 3) throw new Error("Unable to connect");
      return ok();
    });
    const response = await dispatchStartPlanRequest(
      { accountId: ACCOUNT, jwt: JWT, fetchImpl, captcha },
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: messagesBody() },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    // The request never reached upstream, so the same captcha token is valid
    // across all connect retries; only a gateway challenge consumes it.
    expect(captcha.solves).toBe(1);
  });

  it("exhausts connect retries and surfaces the last error", async () => {
    const fetchImpl = asFetch(async () => {
      throw new Error("Unable to connect");
    });
    const attempt = dispatchStartPlanRequest(
      { accountId: ACCOUNT, jwt: JWT, fetchImpl, captcha: captchaStub() },
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: messagesBody() },
    );
    await expect(attempt).rejects.toThrow(/Unable to connect/);
  });

  it("does not retry after the client already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetchImpl = asFetch(async () => {
      calls += 1;
      controller.abort();
      throw new Error("Unable to connect");
    });
    const attempt = dispatchStartPlanRequest(
      { accountId: ACCOUNT, jwt: JWT, fetchImpl, captcha: captchaStub() },
      "https://api.anthropic.com/v1/messages",
      { method: "POST", body: messagesBody(), signal: controller.signal },
    );
    await expect(attempt).rejects.toThrow(/Unable to connect|aborted/);
    expect(calls).toBe(1);
  });
});


describe("errors", () => {
  it("raises a 401 auth error so OMP can try the next account", async () => {
    const attempt = dispatch([new Response("unauthorized", { status: 401 })], captchaStub());
    await expect(attempt).rejects.toBeInstanceOf(StartPlanAuthError);
    expect(accountState(ACCOUNT).lastAuthFailureAt).toBeDefined();
  });

  it("checks 401 before spending a second captcha token", async () => {
    const captcha = captchaStub();
    const unauthorized = new Response("unauthorized", { status: 401 });
    await expect(dispatch([unauthorized, ok()], captcha)).rejects.toBeInstanceOf(StartPlanAuthError);
    expect(captcha.solves).toBe(1);
  });

  it("raises a 401 seen on the captcha retry too", async () => {
    const attempt = dispatch([challenged(), new Response("unauthorized", { status: 401 })], captchaStub());
    await expect(attempt).rejects.toBeInstanceOf(StartPlanAuthError);
  });

  it("returns non-401 upstream errors verbatim for OMP to surface", async () => {
    const { response } = await dispatch(
      [new Response('{"code":3012,"msg":"blocked"}', { status: 405 })],
      captchaStub(),
    );
    expect(response.status).toBe(405);
    expect(await response.text()).toContain("3012");
  });

  it("never puts the credential in an error message", async () => {
    try {
      await dispatch([new Response("nope", { status: 401 })], captchaStub());
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain(JWT);
    }
  });
});
