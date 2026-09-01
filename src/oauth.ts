/**
 * `/login zcode` — native OMP OAuth for the ZCode Start Plan.
 *
 * Three ways in, offered through OMP's own `onPrompt` callback so no custom
 * slash command is needed:
 *   1. `import`  — read the plan JWT out of the installed ZCode configuration.
 *                  Equivalent to `bun run src/index.ts auth login zai --import`.
 *   2. `paste`   — paste a Start Plan credential directly.
 *   3. `browser` — run the current ZCode desktop login flow.
 *
 * The browser flow is a port of zcode-api `src/auth/oauth.ts` as of
 * `d5d6df1` ("Fix: oauth login call back url"). The two providers use
 * **different** flows:
 *
 *   - **Z.AI — server-mediated CLI login.** `POST /api/v1/oauth/cli/init` with
 *     a client-generated bearer poll token returns a server-built
 *     `authorize_url` whose redirect_uri is zcode.z.ai's own
 *     `/oauth/cli/callback/zai`. There is no local callback server; the client
 *     polls `/api/v1/oauth/cli/poll/{flow_id}` until `status:"ready"`.
 *     Building the old 3.1.x direct `chat.z.ai/api/oauth/authorize` URL with a
 *     localhost redirect_uri is rejected upstream with
 *     `{"detail":"Redirect URI not registered for this client"}`.
 *   - **Bigmodel — classic auth-code.** Loopback callback server, authorize at
 *     `bigmodel.cn/login?appId&redirect&state`, then exchange the code at the
 *     shared `zcode.z.ai/api/v1/oauth/token`.
 *
 * Both flows return the plan JWT in `data.token`; that is the Start Plan
 * credential. The provider access token belongs to the coding plan and is not
 * used here.
 *
 * The credential OMP persists is that JWT with `accountId` set to the ZCode
 * `user_id` decoded from it. That is what makes repeated logins converge: a new
 * user id inserts a new account, a known user id updates that account in place,
 * and every other stored account is untouched.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import {
  importFromZCodeConfig,
  ZCODE_PROVIDER_IDS,
  parseStartPlanCredential,
  zcodeConfigPath,
  type ImportedCredential,
  type StartPlanCredential,
  type ZCodeProviderId,
} from "./credential.js";
import { ZCODE_ORIGIN } from "./identity-context.js";

/** zcode.z.ai API base (zcode-api `ZCODE_API_BASE`). */
const ZCODE_API_BASE = `${ZCODE_ORIGIN}/api/v1`;

/** Token-exchange endpoint used by the Bigmodel auth-code flow. */
const TOKEN_ENDPOINT = `${ZCODE_API_BASE}/oauth/token`;

/** Bigmodel authorize host and app id (bundle `ed`). */
const BIGMODEL_HOST = "https://bigmodel.cn";
const BIGMODEL_APP_ID = "zcode";
const BIGMODEL_CALLBACK_PATH = "/oauth/callback/bigmodel";

/** Overall login timeout shared by both flows (bundle `tln`). */
const LOGIN_TIMEOUT_MS = 300_000;

/**
 * Plan tokens carry `iat` but no `exp`. OMP treats `expires <= now` as "refresh
 * me", and there is no refresh endpoint for this grant, so a far-future expiry
 * is the honest encoding of "valid until the gateway says otherwise".
 */
const NO_EXPIRY_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** Where the browser must be sent, plus the bookkeeping that completes the flow. */
export interface OAuthFlowStart {
  authorizeUrl: string;
  /** Loopback callback URL (Bigmodel); empty for the Z.AI CLI flow. */
  callbackUrl: string;
  /** CSRF state (auth-code) or server `flow_id` (Z.AI CLI flow). */
  state: string;
}

/** Outcome of the loopback callback: an auth code, or the reason it failed. */
interface CallbackResult {
  code: string;
  error: string | null;
}

interface ZcodeEnvelope {
  code?: number;
  data?: unknown;
  msg?: string;
}

/**
 * POST/GET a zcode.z.ai endpoint and unwrap the `{code, data, msg}` envelope.
 * Mirrors the bundle's `H2r`: a numeric `code` is required, and a non-2xx or
 * `code !== 0` surfaces the server `msg`.
 */
async function requestZcodeEnvelope(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  label: string,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let raw: ZcodeEnvelope | null;
  try {
    raw = JSON.parse(text) as ZcodeEnvelope;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw.code !== "number") {
    throw new Error(`${label}: invalid response envelope (status=${response.status})`);
  }
  if (!response.ok || raw.code !== 0) {
    throw new Error(`${label} failed: status=${response.status} msg=${raw.msg ?? "(none)"}`);
  }
  return raw.data;
}

/** Trimmed non-empty string, or undefined. Used for optional wire fields. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Common lifecycle for both login flows. */
export interface ZCodeLoginFlow {
  readonly provider: ZCodeProviderId;
  start(): Promise<OAuthFlowStart>;
  complete(started: OAuthFlowStart, timeoutMs?: number, signal?: AbortSignal): Promise<StartPlanCredential>;
  close(): Promise<void>;
}

/** `data` of a successful `/oauth/cli/init` call (bundle `D3o`). */
interface ZaiCliInitData {
  flow_id: string;
  authorize_url: string;
  /** Unix seconds. */
  expires_at: number;
  poll_interval_sec: number;
}

/**
 * `data` of an `/oauth/cli/poll/{flow_id}` call (bundle `N3o`/`L3o`).
 *
 * Remote master declares `user` as `{ user_id }` only. `email` is read
 * defensively so OMP's account list can show a human identity if the gateway
 * ever starts returning one; absent it, the `user_id` UUID is the identity.
 */
interface ZaiCliPollData {
  status?: unknown;
  token?: unknown;
  user?: { user_id?: unknown; email?: unknown } | null;
  zai?: { access_token?: unknown } | null;
}

/**
 * Z.AI login: server-mediated CLI init + poll (ZCode 3.10 `loginZCodeCli`).
 *
 * The poll token is client-generated and sent as `Authorization: Bearer` on
 * BOTH init and poll — it is what binds the polling client to the flow the
 * browser is authorizing.
 */
export class ZaiCliLoginFlow implements ZCodeLoginFlow {
  readonly provider: ZCodeProviderId = "zai";
  private flow: ZaiCliInitData | null = null;
  private pollToken = "";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    /** Injectable pause between polls; tests pass a no-op. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async start(): Promise<OAuthFlowStart> {
    this.flow = null;
    this.pollToken = randomBytes(32).toString("hex");

    const data = (await requestZcodeEnvelope(
      this.fetchImpl,
      `${ZCODE_API_BASE}/oauth/cli/init`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.pollToken}`, "content-type": "application/json" },
        body: JSON.stringify({ provider: this.provider }),
      },
      "Z.AI login init",
    )) as Partial<ZaiCliInitData> | null;

    if (
      !data ||
      typeof data.flow_id !== "string" ||
      typeof data.authorize_url !== "string" ||
      typeof data.expires_at !== "number" ||
      typeof data.poll_interval_sec !== "number"
    ) {
      throw new Error("Z.AI login init: invalid response data");
    }
    this.flow = data as ZaiCliInitData;
    return { authorizeUrl: this.flow.authorize_url, callbackUrl: "", state: this.flow.flow_id };
  }

  async complete(
    _started: OAuthFlowStart,
    timeoutMs: number = LOGIN_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<StartPlanCredential> {
    const flow = this.flow;
    if (!flow) throw new Error("Z.AI login not started");

    // The server's own expiry bounds the wait even when the caller asks for
    // longer — polling a dead flow can only 4xx.
    const deadlineMs = Math.min(Date.now() + timeoutMs, flow.expires_at * 1000);
    const intervalMs = Math.max(1_000, flow.poll_interval_sec * 1000);

    for (;;) {
      if (signal?.aborted) throw new Error("ZCode authorization was cancelled.");
      if (Date.now() >= deadlineMs) {
        throw new Error("Authorization timed out. Please retry /login zcode.");
      }

      const data = (await requestZcodeEnvelope(
        this.fetchImpl,
        `${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(flow.flow_id)}`,
        { method: "GET", headers: { authorization: `Bearer ${this.pollToken}` } },
        "Z.AI login poll",
      )) as ZaiCliPollData | null;

      if (data?.status === "ready") {
        const jwt = typeof data.token === "string" ? data.token.trim() : "";
        if (!jwt) throw new Error("Z.AI login poll: response carried no Start Plan token");
        return parseStartPlanCredential(jwt, this.provider, stringOrUndefined(data.user?.email));
      }
      if (data?.status === "failed") {
        throw new Error("Authorization failed. Please retry /login zcode.");
      }
      if (data?.status !== "pending") {
        throw new Error(`Z.AI login poll: unexpected status ${String(data?.status ?? "(none)")}`);
      }
      await this.sleep(Math.min(intervalMs, Math.max(0, deadlineMs - Date.now())));
    }
  }

  async close(): Promise<void> {
    this.flow = null;
  }
}

/**
 * Bigmodel login: classic auth-code with a loopback callback server
 * (ZCode 3.10 `loginBigmodelCodingPlan`).
 */
export class BigmodelLoginFlow implements ZCodeLoginFlow {
  readonly provider: ZCodeProviderId = "bigmodel";
  private server: Server | null = null;
  private settled: CallbackResult | null = null;
  private waiters: Array<(result: CallbackResult) => void> = [];

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly host: string = BIGMODEL_HOST,
    private readonly appId: string = BIGMODEL_APP_ID,
  ) {}

  start(): Promise<OAuthFlowStart> {
    const state = randomBytes(32).toString("hex");
    const requestedPort = Number(process.env.ZCODE_OAUTH_CALLBACK_PORT ?? 0) || 0;
    const { promise, resolve, reject } = Promise.withResolvers<OAuthFlowStart>();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.handleCallback(req, res, state);
    });
    this.server = server;
    server.on("error", (error) => {
      this.server = null;
      reject(error);
    });
    server.listen(requestedPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Failed to bind the ZCode OAuth callback server"));
        return;
      }
      const callbackUrl = `http://127.0.0.1:${address.port}${BIGMODEL_CALLBACK_PATH}`;
      const params = new URLSearchParams({ appId: this.appId, redirect: callbackUrl, state });
      resolve({ authorizeUrl: `${this.host}/login?${params.toString()}`, callbackUrl, state });
    });

    return promise;
  }

  private handleCallback(req: IncomingMessage, res: ServerResponse, expectedState: string): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== BIGMODEL_CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";

    if (state !== expectedState || !code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed: state mismatch or missing code.");
      this.settle({ code: "", error: "ZCode OAuth callback state mismatch or missing code." });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Authorization successful. You may close this window and return to OMP.");
    this.settle({ code, error: null });
  }

  private settle(result: CallbackResult): void {
    if (this.settled) return;
    this.settled = result;
    for (const waiter of this.waiters) waiter(result);
  }

  /** Wait for the browser redirect. Resolves with the auth code. */
  waitForCallback(timeoutMs = LOGIN_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
    if (this.settled?.code) return Promise.resolve(this.settled.code);
    if (this.settled?.error) return Promise.reject(new Error(this.settled.error));

    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      reject(new Error("Authorization timed out. Please retry /login zcode."));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("ZCode authorization was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.waiters.push((result) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (result.error) reject(new Error(result.error));
      else resolve(result.code);
    });

    return promise;
  }

  /**
   * Exchange the auth code at the shared zcode.z.ai token endpoint. ZCode holds
   * the app secret and answers `{code:0, data:{token, bigmodel:{access_token},
   * user:{user_id}}}`; `data.token` is the Start Plan credential.
   */
  async exchangeCode(authCode: string, redirectUri: string, state: string): Promise<StartPlanCredential> {
    const data = (await requestZcodeEnvelope(
      this.fetchImpl,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: this.provider, code: authCode, redirect_uri: redirectUri, state }),
      },
      "bigmodel token exchange",
    )) as { token?: unknown; user?: { user_id?: unknown; email?: unknown } | null } | null;

    const jwt = typeof data?.token === "string" ? data.token.trim() : "";
    if (!jwt) throw new Error("bigmodel token response carried no Start Plan token");
    return parseStartPlanCredential(jwt, this.provider, stringOrUndefined(data?.user?.email));
  }

  async complete(
    started: OAuthFlowStart,
    timeoutMs: number = LOGIN_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<StartPlanCredential> {
    const code = await this.waitForCallback(timeoutMs, signal);
    return this.exchangeCode(code, started.callbackUrl, started.state);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // Drop idle keep-alive connections so the port is released immediately.
    server.closeAllConnections?.();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
}

/** Build the login flow for one provider family. */
export function createLoginFlow(
  provider: ZCodeProviderId,
  fetchImpl: typeof fetch = fetch,
  sleep?: (ms: number) => Promise<void>,
): ZCodeLoginFlow {
  return provider === "bigmodel"
    ? new BigmodelLoginFlow(fetchImpl)
    : new ZaiCliLoginFlow(fetchImpl, sleep);
}

/** Run the full browser flow, surfacing the authorize URL through OMP. */
export async function authorizeInBrowser(
  provider: ZCodeProviderId,
  callbacks: OAuthLoginCallbacks,
  fetchImpl: typeof fetch = fetch,
  sleep?: (ms: number) => Promise<void>,
): Promise<StartPlanCredential> {
  const flow = createLoginFlow(provider, fetchImpl, sleep);
  const started = await flow.start();
  try {
    callbacks.onAuth({
      url: started.authorizeUrl,
      instructions: `Authorize ZCode (${provider}) in the browser, then return here.`,
    });
    callbacks.onProgress?.("Waiting for ZCode authorization…");
    return await flow.complete(started, LOGIN_TIMEOUT_MS, callbacks.signal);
  } finally {
    await flow.close();
  }
}

/** Encode a Start Plan credential as OMP OAuth credentials. */
export function toOAuthCredentials(credential: StartPlanCredential, now: number = Date.now()): OAuthCredentials {
  return {
    access: credential.jwt,
    // No refresh grant exists for a ZCode plan token; the empty string is the
    // honest encoding and `refreshToken` is deliberately not implemented.
    refresh: "",
    expires: credential.expiresAt ?? now + NO_EXPIRY_HORIZON_MS,
    accountId: credential.userId,
    // Distinguishes which upstream family the plan is attached to in the
    // account list, since one OMP install can hold both.
    orgId: credential.provider,
    orgName: `ZCode Start Plan (${credential.provider})`,
    // Only ever set by a browser login that returned one; ZCode's Start Plan
    // responses and plan JWTs carry no email, so OMP falls back to displaying
    // `accountId` (the ZCode `user_id`).
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.issuedAt !== undefined ? { authorizedAt: credential.issuedAt } : {}),
  };
}

/** One fully-specified menu entry: the family is part of the choice. */
interface LoginOption {
  kind: "browser" | "import" | "paste";
  provider: ZCodeProviderId;
  label: string;
  /** Installed credential behind an `import` entry. */
  installed?: ImportedCredential;
}

/** The only family the menu offers; `bigmodel` stays typed-answer only. */
const MENU_PROVIDER: ZCodeProviderId = "zai";

/**
 * Build the menu: browser first — it is the only option that works on a
 * machine without the desktop client — then any installed credential, then
 * paste. Every entry is a complete choice, so the flow never asks a second
 * question. Only `zai` is listed; `bigmodel` remains reachable by typing it.
 */
function buildLoginOptions(installed: ImportedCredential[], lookupEmail?: EmailLookup): LoginOption[] {
  const options: LoginOption[] = [
    { kind: "browser", provider: MENU_PROVIDER, label: "browser — sign in with the ZCode browser flow" },
  ];

  // Installed credentials are listed whatever their family: the credential
  // exists on this machine, so hiding it would strand it. Only the browser and
  // paste flows are pinned to `zai`.
  for (const entry of installed) {
    const { provider, userId } = entry.credential;
    const who = lookupEmail?.(userId, provider) ?? userId;
    const family = provider === MENU_PROVIDER ? "" : ` [${provider}]`;
    options.push({
      kind: "import",
      provider,
      installed: entry,
      label: `import — use the credential in ${zcodeConfigPath()} (${who})${family}`,
    });
  }

  options.push({ kind: "paste", provider: MENU_PROVIDER, label: "paste — paste a ZCode Start Plan credential" });
  return options;
}

/**
 * Resolve a free-text answer: a 1-based menu number, or keywords (`import`,
 * `paste`, `b`). Naming `bigmodel` explicitly reaches that backend even though
 * it is not listed. Anything unrecognised falls back to the first option.
 */
function selectLoginOption(answer: string, options: LoginOption[]): LoginOption {
  const trimmed = answer.trim().toLowerCase();
  const numbered = Number.parseInt(trimmed, 10);
  if (Number.isInteger(numbered) && numbered >= 1 && numbered <= options.length) return options[numbered - 1]!;

  const kind: LoginOption["kind"] | undefined = trimmed.startsWith("i")
    ? "import"
    : trimmed.startsWith("pa")
      ? "paste"
      : trimmed.startsWith("b") && !trimmed.startsWith("big")
        ? "browser"
        : trimmed.startsWith("l") || trimmed.startsWith("s")
          ? "browser"
          : undefined;

  // Unlisted family: honour it against whichever kind was named.
  if (trimmed.includes("bigmodel") || trimmed.includes("big")) {
    const wanted = kind ?? "browser";
    const installed = options.find((option) => option.kind === "import" && option.provider === "bigmodel");
    if (wanted === "import") return installed ?? options[0]!;
    return {
      kind: wanted,
      provider: "bigmodel",
      label: wanted === "paste" ? "paste — paste a ZCode Start Plan credential (bigmodel)" : "browser — sign in with the ZCode browser flow (bigmodel)",
    };
  }

  return (kind !== undefined ? options.find((option) => option.kind === kind) : undefined) ?? options[0]!;
}

/** Resolve a display name for an installed credential's account. */
export type EmailLookup = (userId: string, provider: ZCodeProviderId) => string | undefined;

export interface OAuthDependencies {
  fetchImpl?: typeof fetch;
  /** Override the installed-config scan. Test seam. */
  readInstalled?: () => ImportedCredential[];
  /** Map an installed credential's user id to a known account email. */
  lookupEmail?: EmailLookup;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the `oauth` half of the provider registration.
 *
 * `getApiKey` returns the plan JWT verbatim — the request pipeline puts it in
 * `Authorization: Bearer {jwt}`. `refreshToken` is intentionally absent: this
 * grant has no refresh endpoint, and declaring one would make OMP attempt an
 * impossible renewal.
 */
export function createZCodeOAuth(deps: OAuthDependencies = {}): NonNullable<ProviderConfig["oauth"]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readInstalled = deps.readInstalled ?? importFromZCodeConfig;
  const now = deps.now ?? Date.now;

  return {
    name: "ZCode (Start Plan)",
    async login(callbacks): Promise<OAuthCredentials> {
      const options = buildLoginOptions(readInstalled(), deps.lookupEmail);
      const menu = options.map((option, index) => `${index + 1}) ${option.label}`).join("\n");

      const answer = await callbacks.onPrompt({
        message: `ZCode Start Plan login:\n${menu}\n\nChoose`,
        placeholder: "1",
      });
      const chosen = selectLoginOption(answer, options);
      callbacks.onProgress?.(`Selected ${chosen.label}.`);

      if (chosen.kind === "import") {
        const entry = chosen.installed;
        if (!entry) throw new Error(`No ZCode Start Plan credential found in ${zcodeConfigPath()}`);
        callbacks.onProgress?.(`Imported ZCode Start Plan credential for ${entry.credential.provider}.`);
        return toOAuthCredentials(entry.credential, now());
      }

      if (chosen.kind === "paste") {
        const pasted = await callbacks.onPrompt({
          message: `Paste the ZCode Start Plan credential (JWT) for ${chosen.provider}`,
        });
        return toOAuthCredentials(parseStartPlanCredential(pasted, chosen.provider), now());
      }

      const credential = await authorizeInBrowser(chosen.provider, callbacks, fetchImpl, deps.sleep);
      return toOAuthCredentials(credential, now());
    },
    getApiKey(credentials) {
      const jwt = credentials.access.trim();
      if (jwt.length === 0) throw new Error("ZCode Start Plan credential is empty");
      return jwt;
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
