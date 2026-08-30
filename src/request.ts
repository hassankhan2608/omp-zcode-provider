/**
 * Start Plan request pipeline.
 *
 * This is the whole ZCode boundary, expressed as a `fetch` wrapper so OMP's
 * native Anthropic transport does the streaming, tool-call decoding, and abort
 * handling. Ported from zcode-api `src/proxy/upstream.ts` (URL + auth/identity/
 * trace headers) and `src/proxy/handler.ts` (captcha acquisition, captcha
 * challenge retry, 401 mapping, incomplete-stream detection).
 *
 * Per request, in order:
 *   1. Rewrite the URL to the Start Plan Anthropic gateway.
 *   2. `Authorization: Bearer {jwt}` + `anthropic-version` (never `x-api-key`:
 *      the Start Plan gateway authenticates the plan JWT).
 *   3. ZCode desktop identity headers with this account's stable device id.
 *   4. Fresh `x-request-id`/`x-zcode-trace-id` per request, `x-zcode-session-
 *      type: main`, and this account's sticky `x-session-id` for the
 *      conversation. Start Plan sends no `x-query-id` (zcode-api
 *      `buildTraceHeaders`).
 *   5. This account's cookies.
 *   6. A pre-solved Aliyun captcha token; the gateway answers 3007 without one.
 *   7. Body transforms (`transforms.ts`).
 *   8. Dispatch, absorb `set-cookie`, and on an explicit captcha challenge
 *      retry exactly once with a freshly pooled token.
 */
import type { CaptchaModule } from "./captcha-module.js";
import { loadCaptcha } from "./captcha-module.js";
import { accountState, type AccountState } from "./account-state.js";
import {
  ANTHROPIC_VERSION,
  identityHeaders,
  STARTPLAN_ANTHROPIC_BASE,
  ZCODE_APP_VERSION,
} from "./identity-context.js";
import { transformStartPlanBody } from "./transforms.js";

/** Aliyun captcha headers (zcode-api `captcha.ts` `RETRY_HEADERS`). */
const CAPTCHA_PARAM_HEADER = "x-aliyun-captcha-verify-param";
const CAPTCHA_REGION_HEADER = "x-aliyun-captcha-verify-region";

/** Start Plan messages endpoint. */
export const STARTPLAN_MESSAGES_URL = `${STARTPLAN_ANTHROPIC_BASE}/v1/messages`;

/**
 * The only inbound header forwarded upstream.
 *
 * zcode-api's `collectPassthroughHeaders` iterates the client request but
 * assigns into the result **only** for `anthropic-beta`; every other inbound
 * header is discarded and the upstream set is rebuilt from scratch. That is
 * load-bearing here: OMP's own Anthropic client emits `x-app: cli`,
 * `anthropic-dangerous-direct-browser-access`, `Connection: keep-alive`,
 * `Accept: text/event-stream` and a Claude-shaped `User-Agent`
 * (`buildAnthropicHeaders`), none of which the ZCode desktop client sends.
 * Forwarding them would put a Claude fingerprint on a ZCode request.
 */
const PASSTHROUGH_HEADER = "anthropic-beta";

/**
 * Transient connect-failure retry policy (upstream `0b0a4e0` + `7dd6818`):
 * three attempts total, linear backoff. The request never reached upstream,
 * so resending is side-effect-free.
 */
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_BACKOFF_MS = 500;

export interface RequestContext {
  /** ZCode `user_id` of the account making the request. */
  accountId: string;
  /** Plan JWT used as the gateway bearer token. */
  jwt: string;
  /** Injectable transport. Tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable captcha module. Tests pass a stub to avoid solving. */
  captcha?: CaptchaModule;
  appVersion?: string;
}

/**
 * Error surfaced when the gateway rejects the plan JWT.
 *
 * Carries a 401 so OMP's auth layer treats it as a credential problem and
 * moves on to the next stored account instead of failing the turn.
 */
export class StartPlanAuthError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "StartPlanAuthError";
  }
}

/** Detect an explicit captcha challenge (zcode-api `detectCaptchaChallenge`). */
function captchaChallenge(response: Response): boolean {
  const value = response.headers.get(CAPTCHA_PARAM_HEADER);
  return value !== null && value.trim().length > 0;
}

/**
 * Acquire a captcha token, tolerating an unavailable solver.
 *
 * A failed solve must not fail the request outright: the gateway is the
 * authority on whether captcha is currently required, and it answers 3007 when
 * it is. Returning `null` lets the request proceed and produce that real error
 * rather than a local one.
 *
 * A local solve failure deliberately does NOT touch the account's captcha
 * health. `AccountState.captchaFailures` counts *gateway* rejections, which is
 * the account-scoped signal; a solver outage is machine-wide and already has
 * its own storm detection and IP-reset escalation inside the token pool
 * (`captcha-pool.ts`). Conflating them would make one broken solver look like
 * every account being throttled.
 */
async function acquireCaptcha(
  captcha: CaptchaModule,
  appVersion: string,
): Promise<{ verifyParam: string; region: string } | null> {
  try {
    return await captcha.getCaptchaToken(appVersion);
  } catch {
    return null;
  }
}

/**
 * Build the full upstream header set for one attempt.
 *
 * Rebuilt from scratch in zcode-api's order
 * (`buildUpstreamHeaderPairs` → content-type, accept-encoding, passthrough,
 * auth+identity+trace, captcha extras), carrying nothing inbound except
 * {@link PASSTHROUGH_HEADER}. Three omissions are deliberate and load-bearing
 * on a gateway that inspects requests:
 *
 *   - **No inbound headers besides `anthropic-beta`.** See
 *     {@link PASSTHROUGH_HEADER}.
 *   - **No `x-query-id` / `x-session-id`.** zcode-api's `buildTraceHeaders`
 *     emits those two only when `plan !== "start-plan"`.
 *   - **No `Cookie`.** zcode-api sends no cookie jar on the LLM path. Cookies
 *     exist in this provider only where upstream has them: inside the captcha
 *     solver's own browser context, which primes `https://zcode.z.ai/` per
 *     solve (`captcha-happy.ts`, ported verbatim).
 */
function buildHeaders(
  ctx: RequestContext,
  state: AccountState,
  incoming: Headers,
  captchaToken: { verifyParam: string; region: string } | null,
): Headers {
  const headers = new Headers();

  headers.set("content-type", "application/json");
  // zcode-api forwards the calling client's negotiation verbatim, defaulting to
  // gzip, so the upstream never compresses with a coding the layer above cannot
  // decode.
  headers.set("accept-encoding", incoming.get("accept-encoding") ?? "gzip");

  const beta = incoming.get(PASSTHROUGH_HEADER);
  if (beta) headers.set(PASSTHROUGH_HEADER, beta);

  headers.set("authorization", `Bearer ${ctx.jwt}`);
  headers.set("anthropic-version", ANTHROPIC_VERSION);

  for (const [name, value] of Object.entries(identityHeaders(state.deviceMid))) {
    headers.set(name, value);
  }

  headers.set("x-request-id", crypto.randomUUID());
  headers.set("x-zcode-session-type", "main");
  headers.set("x-zcode-trace-id", crypto.randomUUID());

  if (captchaToken) {
    headers.set(CAPTCHA_PARAM_HEADER, captchaToken.verifyParam);
    if (captchaToken.region) headers.set(CAPTCHA_REGION_HEADER, captchaToken.region);
  }

  return headers;
}

/**
 * Dispatch one Start Plan request.
 *
 * `input`/`init` are whatever OMP's Anthropic transport produced; the URL it
 * chose is discarded in favor of the Start Plan gateway, and the body is
 * transformed on the way out. The returned `Response` is handed straight back
 * to the transport, streaming body included.
 *
 * Control flow mirrors zcode-api `src/proxy/handler.ts` (v4.5.0), in its order:
 *   1. First attempt. A failed captcha solve here is swallowed and the request
 *      goes out unsigned — the gateway is the authority on whether captcha is
 *      required right now.
 *   2. Transient connect failures (DNS blip, TLS reset) are retried up to
 *      `CONNECT_RETRY_ATTEMPTS` times with a short backoff — the request never
 *      reached upstream, so resending is side-effect-free. A fresh `Request`
 *      is built per attempt: a reused one has its body stream marked used
 *      after the first fetch.
 *   3. `401` → credential rejected. Checked BEFORE the captcha retry, because a
 *      dead JWT must not burn a second pooled captcha token.
 *   4. Captcha challenge → retry exactly once with the next pre-solved token.
 *      The challenge normally arrives as the `x-aliyun-captcha-verify-param`
 *      response header, but the gateway also emits it as HTTP 400 with
 *      `{"code":3007,...}` in the JSON body (observed 2026-08-29 upstream);
 *      both variants trigger the same retry. A solve failure on the *retry*
 *      is fatal (zcode-api answers 503 `captcha_solver_failed`); by then the
 *      gateway has proven captcha is mandatory, so proceeding unsigned would
 *      only produce a second guaranteed rejection.
 */
export async function dispatchStartPlanRequest(
  ctx: RequestContext,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const appVersion = ctx.appVersion ?? ZCODE_APP_VERSION;
  const state = accountState(ctx.accountId);

  const source = new Request(input, init);
  const rawBody = source.body === null ? undefined : await source.text();
  const body = transformStartPlanBody(rawBody);
  const captcha = ctx.captcha ?? (await loadCaptcha());

  const send = (token: { verifyParam: string; region: string } | null): Promise<Response> =>
    fetchImpl(STARTPLAN_MESSAGES_URL, {
      method: "POST",
      headers: buildHeaders(ctx, state, source.headers, token),
      ...(body !== undefined ? { body } : {}),
      ...(source.signal ? { signal: source.signal } : {}),
    });

  // Transient connect failures happen a few times a day against the gateway
  // (upstream 0b0a4e0 + 7dd6818). The request never reached upstream, so
  // resending is side-effect-free; a fresh Request per attempt keeps the body
  // stream usable. A client abort is never retried.
  let response: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    if (source.signal?.aborted) throw new Error("Client aborted before upstream connect.");
    try {
      response = await send(await acquireCaptcha(captcha, appVersion));
      break;
    } catch (error) {
      if (attempt >= CONNECT_RETRY_ATTEMPTS) throw error;
      const backoffMs = CONNECT_RETRY_BACKOFF_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  response = response!;

  if (response.status === 401) {
    state.lastAuthFailureAt = Date.now();
    throw new StartPlanAuthError("ZCode Start Plan credential was rejected. Run /login zcode.");
  }

  let challenged = captchaChallenge(response);

  // In-body challenge variant (upstream 0b0a4e0): the gateway sometimes
  // returns the challenge as HTTP 400 with {"code":3007,...} in the JSON body
  // instead of the captcha response header. Peek a clone of the body — error
  // responses are small, and the original body stays untouched for the retry
  // or the error path.
  if (!challenged && !response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      try {
        const peek = await response.clone().text();
        if (peek.includes('"code":3007') || peek.includes('"code": 3007')) {
          challenged = true;
        }
      } catch {
        // An unreadable error body is not a challenge.
      }
    }
  }

  if (challenged) {
    state.captchaFailures += 1;
    state.lastCaptchaFailureAt = Date.now();
    // The challenged token was consumed by the rejected request; drop its body
    // so the connection is released before the retry goes out.
    try {
      await response.body?.cancel();
    } catch {
      // A body that cannot be cancelled is already finished.
    }
    captcha.urgentCaptcha();
    response = await send(await captcha.getCaptchaToken(appVersion));

    if (response.status === 401) {
      state.lastAuthFailureAt = Date.now();
      throw new StartPlanAuthError("ZCode Start Plan credential was rejected. Run /login zcode.");
    }
  }

  // An accepted request clears the account's captcha health. A `200` that still
  // carries the challenge header is a rejection, not an acceptance.
  if (response.ok && !captchaChallenge(response)) state.captchaFailures = 0;
  return response;
}
