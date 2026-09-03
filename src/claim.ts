/**
 * ZCode manual-claim ("weekend / trial plan") client.
 *
 * Ported from zcode-api `src/claim/client.ts` + `types.ts` (v4.5.3). Mirrors
 * the ZCode desktop client's `getManualClaimPlanPreviews` / `claimManualPlan`:
 *
 *   GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=
 *   POST {origin}/api/v1/zcode-plan/billing/claim   body {plan_id}
 *
 * Both calls carry the ZCode desktop identity set MINUS `X-ZCode-Agent`
 * (zcode.z.ai control-plane precedent) including the server-required
 * UUID-format `X-Device-Mid`; without it the gateway answers biz `3001`.
 * Claim adds `Authorization: Bearer {jwt}` and Aliyun captcha headers from
 * the same token pool the Start Plan gateway uses. Preview is read-only and
 * never mints a captcha.
 */
import { accountState } from "./account-state.js";
import { identityHeaders, ZCODE_APP_VERSION, ZCODE_ORIGIN, zcodePlatform } from "./identity-context.js";

/** Server biz codes → failure kinds, matching the desktop client's mapper. */
export type ClaimFailureKind =
  | "not_found"
  | "unavailable"
  | "already_claimed"
  | "ineligible"
  | "quota_exhausted"
  | "invalid_request"
  | "captcha"
  | "login_required"
  | "http_error"
  | "unknown";

/** One entitlement inside a claimable plan (normalized from snake_case). */
export interface PlanEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  effectiveAt?: number;
}

/** A claimable trial plan from the preview endpoint. */
export interface ClaimablePlan {
  planId: string;
  name: string;
  description: string;
  priority: number;
  startsAt?: number;
  endsAt?: number;
  entitlements: PlanEntitlement[];
}

export type ClaimOutcome =
  | { ok: true; planId: string; startsAt?: number; endsAt?: number }
  | {
      ok: false;
      planId: string;
      failureKind: ClaimFailureKind;
      code: number | string;
      message: string;
      failureEndsAt?: number;
      /** `Retry-After` from a 429, in ms; only set when the gateway sent one. */
      retryAfterMs?: number;
    };

export function classifyClaimCode(code: number | string): ClaimFailureKind {
  const numeric = typeof code === "number" ? code : Number.parseInt(code, 10);
  switch (numeric) {
    case 1001:
      return "not_found";
    case 1002:
      return "unavailable";
    case 1003:
      return "already_claimed";
    case 1004:
      return "ineligible";
    case 1005:
      return "quota_exhausted";
    case 3001:
      return "invalid_request";
    case 3007:
      return "captcha";
    case 401:
      return "login_required";
    default:
      return "unknown";
  }
}

/**
 * Preview failure with the HTTP status preserved (404 = campaign not deployed,
 * 429 = client-wide rate limit) plus the parsed `Retry-After` when present, so
 * the scheduler can pause for exactly as long as the gateway asked.
 */
export class ClaimPreviewError extends Error {
  readonly status: number;
  readonly code: number | string;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number, code: number | string, retryAfterMs?: number) {
    super(message);
    this.name = "ClaimPreviewError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Upper bound on any server-requested pause: one bad header must not park claiming forever. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an RFC 9110 `Retry-After` value (delay-seconds or HTTP-date) into ms.
 *
 * Exported because it is the one piece of 429 handling worth pinning directly:
 * the ZCode gateway has been observed answering 429 with no header at all, and
 * `undefined` (not `0`) is what makes the scheduler fall back to its cooldown.
 */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const delta = dateMs - nowMs;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : undefined;
}

interface RawEntitlement {
  entitlement_id?: unknown;
  show_name?: unknown;
  meter?: unknown;
  unit_type?: unknown;
  capabilities?: unknown;
  grant_units?: unknown;
  period?: unknown;
  priority?: unknown;
  effective_at?: unknown;
}

interface RawPlan {
  plan_id?: unknown;
  name?: unknown;
  description?: unknown;
  priority?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
  entitlements?: unknown;
}

export interface ClaimAccount {
  /** ZCode plan JWT; preview works without it, claim does not. */
  jwt: string;
  /** ZCode `user_id` — keys the account-scoped device identity. */
  accountId: string;
}

export interface ClaimClientOptions {
  account: ClaimAccount;
  appVersion?: string;
  origin?: string;
  platform?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ClaimClient {
  getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]>;
  claim(planId: string, captcha: { verifyParam: string; region?: string }, signal?: AbortSignal): Promise<ClaimOutcome>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseEntitlement(raw: RawEntitlement): PlanEntitlement | null {
  const entitlementId = text(raw.entitlement_id);
  if (!entitlementId) return null;
  const entitlement: PlanEntitlement = {
    entitlementId,
    showName: text(raw.show_name),
    meter: text(raw.meter),
    unitType: text(raw.unit_type),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map((entry) => text(entry)).filter(Boolean) : [],
    grantUnits: num(raw.grant_units) ?? 0,
    period: text(raw.period),
    priority: num(raw.priority) ?? 0,
  };
  const effectiveAt = num(raw.effective_at);
  if (effectiveAt !== undefined) entitlement.effectiveAt = effectiveAt;
  return entitlement;
}

function parsePlan(raw: RawPlan): ClaimablePlan | null {
  const planId = text(raw.plan_id);
  if (!planId) return null;
  const plan: ClaimablePlan = {
    planId,
    name: text(raw.name) || planId,
    description: text(raw.description),
    priority: num(raw.priority) ?? 0,
    entitlements: Array.isArray(raw.entitlements)
      ? raw.entitlements.flatMap((entry) => {
          const entitlement = parseEntitlement(entry as RawEntitlement);
          return entitlement ? [entitlement] : [];
        })
      : [],
  };
  const startsAt = num(raw.starts_at);
  if (startsAt !== undefined) plan.startsAt = startsAt;
  const endsAt = num(raw.ends_at);
  if (endsAt !== undefined) plan.endsAt = endsAt;
  return plan;
}

/**
 * Build the client for one account. The identity set deliberately excludes
 * `X-ZCode-Agent` (control-plane precedent) and uses this account's stable
 * device id, so two accounts never share a fingerprint.
 */
export function createClaimClient(options: ClaimClientOptions): ClaimClient {
  const origin = (options.origin ?? ZCODE_ORIGIN).replace(/\/+$/, "");
  const appVersion = options.appVersion ?? ZCODE_APP_VERSION;
  const platform = options.platform ?? zcodePlatform();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const claimIdentityHeaders: Record<string, string> = (() => {
    const all = identityHeaders(accountState(options.account.accountId).deviceMid);
    const filtered: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) {
      if (name !== "X-ZCode-Agent") filtered[name] = value;
    }
    return filtered;
  })();

  async function request(
    method: string,
    path: string,
    init: { body?: unknown; headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<{ status: number; json: Record<string, unknown> | undefined; bodyText: string; retryAfterMs?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      let json: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
      } catch {
        // non-JSON body surfaced via bodyText
      }
      // Only 429/503 carry a meaningful Retry-After; parsing unconditionally
      // keeps this hot path branch-free and costs nothing when absent.
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      return { status: response.status, json, bodyText, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function unwrapError(
    json: Record<string, unknown> | undefined,
    status: number,
    bodyText: string,
  ): { code: number | string; message: string } {
    const code = json?.code !== undefined ? (json.code as number | string) : status >= 400 ? status : -1;
    const rawMessage = json?.msg ?? json?.message;
    const message =
      typeof rawMessage === "string" && rawMessage.trim()
        ? rawMessage.trim()
        : bodyText.length > 0 && bodyText.length < 200
          ? bodyText
          : `HTTP ${status}`;
    return { code, message };
  }

  return {
    async getPreviews(signal?: AbortSignal): Promise<ClaimablePlan[]> {
      const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`;
      const headers: Record<string, string> = { ...claimIdentityHeaders, authorization: `Bearer ${options.account.jwt}` };
      const { status, json, bodyText, retryAfterMs } = await request("GET", url, { headers, signal });
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
        const { code, message } = unwrapError(json, status, bodyText);
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code, retryAfterMs);
      }
      const data = json.data as { plans?: RawPlan[] };
      return (data.plans ?? []).flatMap((raw) => {
        const plan = parsePlan(raw);
        return plan ? [plan] : [];
      });
    },

    async claim(
      planId: string,
      captcha: { verifyParam: string; region?: string },
      signal?: AbortSignal,
    ): Promise<ClaimOutcome> {
      const headers: Record<string, string> = {
        ...claimIdentityHeaders,
        authorization: `Bearer ${options.account.jwt}`,
        "content-type": "application/json",
        "X-Aliyun-Captcha-Verify-Param": captcha.verifyParam,
      };
      if (captcha.region) headers["X-Aliyun-Captcha-Verify-Region"] = captcha.region;
      const { status, json, bodyText, retryAfterMs } = await request("POST", "/api/v1/zcode-plan/billing/claim", {
        body: { plan_id: planId },
        headers,
        signal,
      });

      const data = json?.data as { plan?: RawPlan } | undefined;
      const bizCode = json?.code !== undefined ? (json.code as number) : undefined;
      const plan = data?.plan;
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        const outcome: ClaimOutcome = { ok: true, planId };
        const startsAt = num(plan.starts_at);
        if (startsAt !== undefined) outcome.startsAt = startsAt;
        const endsAt = num(plan.ends_at);
        if (endsAt !== undefined) outcome.endsAt = endsAt;
        return outcome;
      }
      const { code, message } = unwrapError(json, status, bodyText);
      const failureEndsAt = num(plan?.ends_at);
      const httpDerived = status >= 400 && bizCode === undefined;
      return {
        ok: false,
        planId,
        failureKind: httpDerived ? (status === 401 ? "login_required" : "http_error") : classifyClaimCode(code),
        code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    },
  };
}

/** The plan a scheduler should target: configured id wins, else highest priority. */
export function selectClaimTarget(plans: ClaimablePlan[], configuredPlanId?: string): ClaimablePlan | undefined {
  if (configuredPlanId) return plans.find((plan) => plan.planId === configuredPlanId);
  return [...plans].sort((a, b) => b.priority - a.priority)[0];
}

/** Highest-priority plan from a preview list. */
export function highestPriorityPlan(plans: ClaimablePlan[]): ClaimablePlan | undefined {
  return [...plans].sort((a, b) => b.priority - a.priority)[0];
}
