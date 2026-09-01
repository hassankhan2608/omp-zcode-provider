/**
 * `/login zcode` behavior.
 *
 * Ports zcode-api `src/auth/oauth.test.ts` as of d5d6df1 ("Fix: oauth login
 * call back url"): Z.AI is the server-mediated CLI init+poll flow, Bigmodel is
 * the loopback auth-code flow. Adds the OMP-boundary cases — import, paste,
 * account insertion vs. update, duplicate prevention, and redaction.
 */
import { describe, expect, it } from "bun:test";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import type { ImportedCredential } from "../src/credential.js";
import {
  authorizeInBrowser,
  BigmodelLoginFlow,
  createLoginFlow,
  createZCodeOAuth,
  toOAuthCredentials,
  ZaiCliLoginFlow,
} from "../src/oauth.js";

function jwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  return `${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
}

const PLAN_JWT = jwt({ user_id: "u-live", sub: "u-live", iat: 1787924639 });

function envelope(data: unknown, code = 0, msg = ""): Response {
  return new Response(JSON.stringify({ code, msg, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

function stubFetch(handler: (call: Call) => Response): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: Call = {
      url: request.url,
      method: request.method,
      auth: request.headers.get("authorization"),
      body: await request.text(),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Scripted OMP login callbacks. Answers prompts in order. */
function callbacks(answers: string[]): OAuthLoginCallbacks & { authUrls: string[]; progress: string[]; prompts: string[] } {
  const queue = [...answers];
  const authUrls: string[] = [];
  const progress: string[] = [];
  const prompts: string[] = [];
  return {
    authUrls,
    progress,
    prompts,
    onAuth(info) {
      authUrls.push(info.url);
    },
    onProgress(message) {
      progress.push(message);
    },
    async onPrompt(prompt) {
      prompts.push(prompt.message);
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected prompt: ${prompt.message}`);
      return next;
    },
  };
}

const noSleep = async () => {};

describe("Z.AI CLI login flow", () => {
  it("initializes against /oauth/cli/init with a client bearer poll token", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      envelope({ flow_id: "f-1", authorize_url: "https://chat.z.ai/x", expires_at: 9e9, poll_interval_sec: 1 }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    const started = await flow.start();

    expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(JSON.parse(calls[0]!.body)).toEqual({ provider: "zai" });
    // The authorize URL is server-built; the client must never synthesize one.
    expect(started.authorizeUrl).toBe("https://chat.z.ai/x");
    expect(started.callbackUrl).toBe("");
    expect(started.state).toBe("f-1");
  });

  it("never builds a localhost redirect_uri for Z.AI", async () => {
    const { calls, fetchImpl } = stubFetch(() =>
      envelope({ flow_id: "f-1", authorize_url: "https://chat.z.ai/x", expires_at: 9e9, poll_interval_sec: 1 }),
    );
    const started = await new ZaiCliLoginFlow(fetchImpl, noSleep).start();
    expect(started.authorizeUrl).not.toContain("127.0.0.1");
    expect(started.authorizeUrl).not.toContain("redirect_uri");
    expect(calls).toHaveLength(1);
  });

  it("rejects an init response missing required fields", async () => {
    const { fetchImpl } = stubFetch(() => envelope({ flow_id: "f-1" }));
    await expect(new ZaiCliLoginFlow(fetchImpl, noSleep).start()).rejects.toThrow(/invalid response data/);
  });

  it("surfaces the server message when init fails", async () => {
    const { fetchImpl } = stubFetch(() => envelope(null, 4001, "nope"));
    await expect(new ZaiCliLoginFlow(fetchImpl, noSleep).start()).rejects.toThrow(/nope/);
  });

  it("polls until ready and returns the plan JWT", async () => {
    let polls = 0;
    const { calls, fetchImpl } = stubFetch((call) => {
      if (call.url.endsWith("/oauth/cli/init")) {
        return envelope({ flow_id: "f-1", authorize_url: "https://chat.z.ai/x", expires_at: 9e9, poll_interval_sec: 1 });
      }
      polls += 1;
      return polls < 3
        ? envelope({ status: "pending" })
        : envelope({ status: "ready", token: PLAN_JWT, user: { user_id: "u-live" }, zai: { access_token: "at" } });
    });

    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    const started = await flow.start();
    const credential = await flow.complete(started, 60_000);

    expect(polls).toBe(3);
    expect(calls[1]!.url).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll/f-1");
    expect(calls[1]!.method).toBe("GET");
    // Poll re-sends the same client bearer token that init used.
    expect(calls[1]!.auth).toBe(calls[0]!.auth);
    expect(credential).toEqual({
      jwt: PLAN_JWT,
      provider: "zai",
      userId: "u-live",
      issuedAt: 1787924639_000,
    });
  });

  it("fails when a ready poll carries no plan token", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "ready", zai: { access_token: "at" } }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    await expect(flow.complete(await flow.start(), 60_000)).rejects.toThrow(/no Start Plan token/);
  });

  it("throws on an explicit failed status", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "failed" }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    await expect(flow.complete(await flow.start(), 60_000)).rejects.toThrow(/Authorization failed/);
  });

  it("throws on an unrecognized status rather than polling forever", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "weird" }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    await expect(flow.complete(await flow.start(), 60_000)).rejects.toThrow(/unexpected status weird/);
  });

  it("stops at the server's own expiry even when asked to wait longer", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 1, poll_interval_sec: 1 })
        : envelope({ status: "pending" }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    await expect(flow.complete(await flow.start(), 600_000)).rejects.toThrow(/timed out/);
  });

  it("honors an abort signal", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "pending" }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    const started = await flow.start();
    const controller = new AbortController();
    controller.abort();
    await expect(flow.complete(started, 60_000, controller.signal)).rejects.toThrow(/cancelled/);
  });

  it("is what createLoginFlow selects for zai", () => {
    expect(createLoginFlow("zai")).toBeInstanceOf(ZaiCliLoginFlow);
    expect(createLoginFlow("bigmodel")).toBeInstanceOf(BigmodelLoginFlow);
  });
});

describe("Bigmodel auth-code flow", () => {
  it("serves a loopback callback and authorizes with appId/redirect/state", async () => {
    const flow = new BigmodelLoginFlow();
    try {
      const started = await flow.start();
      const url = new URL(started.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://bigmodel.cn/login");
      expect(url.searchParams.get("appId")).toBe("zcode");
      expect(url.searchParams.get("redirect")).toBe(started.callbackUrl);
      expect(url.searchParams.get("state")).toBe(started.state);
      expect(started.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/bigmodel$/);
    } finally {
      await flow.close();
    }
  });

  it("completes end-to-end through the loopback redirect and token exchange", async () => {
    const { calls, fetchImpl } = stubFetch(() => envelope({ token: PLAN_JWT, bigmodel: { access_token: "at" } }));
    const flow = new BigmodelLoginFlow(fetchImpl);
    try {
      const started = await flow.start();
      const pending = flow.complete(started, 10_000);
      await fetch(`${started.callbackUrl}?authCode=code-1&state=${started.state}`);
      const credential = await pending;

      expect(calls[0]!.url).toBe("https://zcode.z.ai/api/v1/oauth/token");
      expect(JSON.parse(calls[0]!.body)).toEqual({
        provider: "bigmodel",
        code: "code-1",
        redirect_uri: started.callbackUrl,
        state: started.state,
      });
      expect(credential.jwt).toBe(PLAN_JWT);
      expect(credential.provider).toBe("bigmodel");
    } finally {
      await flow.close();
    }
  });

  it("rejects a callback whose state does not match", async () => {
    const flow = new BigmodelLoginFlow();
    try {
      const started = await flow.start();
      // Capture the settlement before triggering the redirect: the server
      // settles the flow synchronously inside its request handler.
      const settled = flow.complete(started, 10_000).then(
        () => "resolved",
        (error: Error) => error.message,
      );
      const response = await fetch(`${started.callbackUrl}?authCode=code-1&state=wrong`);
      expect(response.status).toBe(400);
      expect(await settled).toMatch(/state mismatch/);
    } finally {
      await flow.close();
    }
  });
});

describe("authorizeInBrowser", () => {
  it("surfaces the server authorize URL through OMP's onAuth", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "https://chat.z.ai/go", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "ready", token: PLAN_JWT, zai: { access_token: "at" } }),
    );
    const cb = callbacks([]);
    const credential = await authorizeInBrowser("zai", cb, fetchImpl, noSleep);
    expect(cb.authUrls).toEqual(["https://chat.z.ai/go"]);
    expect(credential.jwt).toBe(PLAN_JWT);
  });
});

describe("toOAuthCredentials", () => {
  it("keys the account on the JWT user_id", () => {
    const credential = { jwt: PLAN_JWT, provider: "zai" as const, userId: "u-live", issuedAt: 1 };
    const stored = toOAuthCredentials(credential, 1_000);
    expect(stored.accountId).toBe("u-live");
    expect(stored.access).toBe(PLAN_JWT);
    expect(stored.orgId).toBe("zai");
    expect(stored.authorizedAt).toBe(1);
  });

  it("declares a far-future expiry when the token has none, since no refresh exists", () => {
    const stored = toOAuthCredentials({ jwt: PLAN_JWT, provider: "zai", userId: "u" }, 1_000);
    expect(stored.expires).toBeGreaterThan(1_000);
    expect(stored.refresh).toBe("");
  });

  it("captures an email when the poll response carries one", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "ready", token: PLAN_JWT, user: { user_id: "u-live", email: "dev@z.ai" } }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    const credential = await flow.complete(await flow.start(), 60_000);
    expect(credential.email).toBe("dev@z.ai");
    expect(toOAuthCredentials(credential, 1_000).email).toBe("dev@z.ai");
  });

  it("leaves email unset when ZCode returns none, so OMP shows the user_id", async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "u", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "ready", token: PLAN_JWT, user: { user_id: "u-live" } }),
    );
    const flow = new ZaiCliLoginFlow(fetchImpl, noSleep);
    const credential = await flow.complete(await flow.start(), 60_000);

    // zcode-api exposes `user: { user_id }` only — there is no email to show.
    expect(credential.email).toBeUndefined();
    const stored = toOAuthCredentials(credential, 1_000);
    expect(stored.email).toBeUndefined();
    expect(stored.accountId).toBe("u-live");
  });

  it("uses the token's own exp when present", () => {
    const stored = toOAuthCredentials({ jwt: PLAN_JWT, provider: "zai", userId: "u", expiresAt: 5_000 }, 1_000);
    expect(stored.expires).toBe(5_000);
  });
});

describe("account identity across repeated logins", () => {
  const installedFor = (token: string, provider: "zai" | "bigmodel" = "zai"): ImportedCredential[] => [
    { credential: { jwt: token, provider, userId: JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).user_id, issuedAt: 1 }, enabled: true },
  ];

  async function login(installed: ImportedCredential[], answers: string[]): Promise<OAuthCredentials> {
    const oauth = createZCodeOAuth({ readInstalled: () => installed, now: () => 1_000 });
    return oauth.login(callbacks(answers)) as Promise<OAuthCredentials>;
  }

  it("resolves the same accountId when the same user logs in twice, so OMP updates in place", async () => {
    const token = jwt({ user_id: "u-same", iat: 1 });
    const first = await login(installedFor(token), ["import"]);
    const second = await login(installedFor(token), ["import"]);
    expect(first.accountId).toBe("u-same");
    expect(second.accountId).toBe("u-same");
  });

  it("resolves a different accountId for a different user, so OMP inserts a new account", async () => {
    const a = await login(installedFor(jwt({ user_id: "u-a", iat: 1 })), ["import"]);
    const b = await login(installedFor(jwt({ user_id: "u-b", iat: 1 })), ["import"]);
    expect(a.accountId).not.toBe(b.accountId);
  });

  it("separates the same user id across provider families via orgId", async () => {
    const token = jwt({ user_id: "u-x", iat: 1 });
    const zai = await login(installedFor(token, "zai"), ["import"]);
    const big = await login(installedFor(token, "bigmodel"), ["import"]);
    expect(zai.orgId).toBe("zai");
    expect(big.orgId).toBe("bigmodel");
  });
});

describe("login menu", () => {
  const installed = (userId = "u-live"): ImportedCredential[] => [
    { credential: { jwt: PLAN_JWT, provider: "zai", userId, issuedAt: 1 }, enabled: true },
  ];

  const browserFetch = (): typeof fetch =>
    stubFetch((call) =>
      call.url.endsWith("/oauth/cli/init")
        ? envelope({ flow_id: "f-1", authorize_url: "https://chat.z.ai/go", expires_at: 9e9, poll_interval_sec: 1 })
        : envelope({ status: "ready", token: PLAN_JWT, zai: { access_token: "at" } }),
    ).fetchImpl;

  it("offers the browser flow first and numbers every option contiguously", async () => {
    const oauth = createZCodeOAuth({ readInstalled: installed, fetchImpl: browserFetch(), now: () => 1_000, sleep: noSleep });
    const cb = callbacks(["1"]);
    await oauth.login(cb);

    const menu = cb.prompts[0]!;
    const numbered = menu.split("\n").filter((line) => /^\d+\)/.test(line.trim()));
    expect(numbered[0]).toMatch(/^1\) browser/);
    expect(numbered.map((line) => Number(line.trim().split(")")[0]))).toEqual(
      numbered.map((_, index) => index + 1),
    );
  });

  it("labels the installed credential with the stored account email when known", async () => {
    const oauth = createZCodeOAuth({
      readInstalled: installed,
      lookupEmail: (userId, provider) => (userId === "u-live" && provider === "zai" ? "a@b.dev" : undefined),
      now: () => 1_000,
    });
    const cb = callbacks(["import"]);
    await oauth.login(cb);
    expect(cb.prompts[0]!).toContain("a@b.dev");
  });

  it("falls back to the account id when no stored email matches", async () => {
    const oauth = createZCodeOAuth({ readInstalled: installed, now: () => 1_000 });
    const cb = callbacks(["import"]);
    await oauth.login(cb);
    expect(cb.prompts[0]!).toContain("u-live");
  });

  it("never asks a follow-up question for a browser login", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], fetchImpl: browserFetch(), now: () => 1_000, sleep: noSleep });
    const cb = callbacks(["1"]);
    const stored = (await oauth.login(cb)) as OAuthCredentials;
    expect(cb.prompts).toHaveLength(1);
    expect(stored.orgId).toBe("zai");
    expect(cb.authUrls).toEqual(["https://chat.z.ai/go"]);
  });

  it("lists only the zai flows: bigmodel stays a backend capability, not a menu choice", async () => {
    const oauth = createZCodeOAuth({ readInstalled: installed, fetchImpl: browserFetch(), now: () => 1_000, sleep: noSleep });
    const cb = callbacks(["1"]);
    await oauth.login(cb);

    const menu = cb.prompts[0]!;
    expect(menu).toMatch(/^1\) browser/m);
    expect(menu).not.toContain("bigmodel");
    expect(menu.split("\n").filter((line) => /^\d+\)/.test(line))).toHaveLength(3);
  });

  it("echoes the chosen option so the transcript records the selection", async () => {
    const oauth = createZCodeOAuth({ readInstalled: installed, now: () => 1_000 });
    const cb = callbacks(["import"]);
    await oauth.login(cb);
    expect(cb.progress.join(" ")).toMatch(/Selected .*import/i);
  });

  it("imports the installed credential", async () => {
    const oauth = createZCodeOAuth({ readInstalled: installed, now: () => 1_000 });
    const cb = callbacks(["import"]);
    const stored = (await oauth.login(cb)) as OAuthCredentials;
    expect(stored.access).toBe(PLAN_JWT);
    expect(cb.progress.join(" ")).toContain("Imported");
  });

  it("still reaches the bigmodel backend when the answer names it explicitly", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], now: () => 1_000 });
    const cb = callbacks(["paste bigmodel", `  ${PLAN_JWT}  `]);
    const stored = (await oauth.login(cb)) as OAuthCredentials;
    expect(stored.access).toBe(PLAN_JWT);
    expect(stored.orgId).toBe("bigmodel");
    expect(cb.prompts).toHaveLength(2);
  });

  it("pastes into zai by default, with no family prompt", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], now: () => 1_000 });
    const cb = callbacks(["paste", PLAN_JWT]);
    const stored = (await oauth.login(cb)) as OAuthCredentials;
    expect(stored.orgId).toBe("zai");
    expect(cb.prompts).toHaveLength(2);
  });

  it("rejects a pasted credential that is not a plan JWT", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], now: () => 1_000 });
    await expect(oauth.login(callbacks(["paste", "garbage"]))).rejects.toThrow(/not a JWT/);
  });

  it("falls back to the browser flow when the answer matches nothing", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], fetchImpl: browserFetch(), now: () => 1_000, sleep: noSleep });
    const cb = callbacks(["???"]);
    const stored = (await oauth.login(cb)) as OAuthCredentials;
    expect(stored.access).toBe(PLAN_JWT);
  });
});

describe("getApiKey", () => {
  it("returns the plan JWT verbatim for the gateway bearer token", () => {
    const oauth = createZCodeOAuth();
    expect(oauth.getApiKey!({ access: PLAN_JWT, refresh: "", expires: 0 })).toBe(PLAN_JWT);
  });

  it("rejects an empty stored credential", () => {
    const oauth = createZCodeOAuth();
    expect(() => oauth.getApiKey!({ access: "   ", refresh: "", expires: 0 })).toThrow(/empty/);
  });

  it("declares no refreshToken, because this grant cannot be refreshed", () => {
    expect(createZCodeOAuth().refreshToken).toBeUndefined();
  });
});

describe("secret redaction", () => {
  it("keeps the credential out of init/poll failure messages", async () => {
    const { fetchImpl } = stubFetch(() => envelope(null, 4001, "server said no"));
    try {
      await new ZaiCliLoginFlow(fetchImpl, noSleep).start();
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("server said no");
      expect(String(error)).not.toContain(PLAN_JWT);
    }
  });

  it("keeps the credential out of paste validation errors", async () => {
    const oauth = createZCodeOAuth({ readInstalled: () => [], now: () => 1_000 });
    try {
      await oauth.login(callbacks(["paste", "abc.def", "zai"]));
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("abc.def");
    }
  });
});
