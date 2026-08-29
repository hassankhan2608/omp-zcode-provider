/**
 * Start Plan usage provider.
 *
 * Source of truth: `GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
 * ?app_version={v}` with the plan JWT in a **raw** `Authorization` header (no
 * `Bearer` prefix) plus the full ZCode desktop identity headers. Both are
 * load-bearing — the gateway answers `3001 parameter error` when the identity
 * headers are missing, regardless of the query string.
 *
 * The response carries two arrays:
 *   - `data.plans[]`    — subscribed plans and their entitlement definitions.
 *   - `data.balances[]` — one live bucket per (plan, entitlement) with
 *     `total_units` / `used_units` / `available_units` and the period window.
 * Each bucket names the models it covers in `capabilities` as `model:{id}`,
 * which becomes the limit's `scope.modelId` so `/usage` attributes quota to
 * the right model.
 *
 * OMP calls this once per stored credential, so per-account isolation is
 * automatic. On failure the last successful report for that account is served
 * and flagged stale rather than reporting a zero quota.
 */
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type {
  UsageFetchContext,
  UsageFetchParams,
  UsageLimit,
  UsageProvider,
  UsageReport,
  UsageStatus,
} from "@oh-my-pi/pi-ai";
import { accountState } from "./account-state.js";
import { identityHeaders, ZCODE_APP_VERSION, ZCODE_ORIGIN } from "./identity-context.js";
import { canonicalModelId } from "./models.js";

/** Provider id this usage fetcher is registered under. */
export const ZCODE_PROVIDER_ID = "zcode";

const BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`;

/** Raw `data.balances[]` bucket. */
interface RawBalance {
  bucket_id?: unknown;
  plan_id?: unknown;
  entitlement_id?: unknown;
  show_name?: unknown;
  meter?: unknown;
  unit_type?: unknown;
  capabilities?: unknown;
  total_units?: unknown;
  used_units?: unknown;
  remaining_units?: unknown;
  available_units?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  expires_at?: unknown;
}

/** Raw `data.plans[]` entry. */
interface RawPlan {
  plan_id?: unknown;
  name?: unknown;
  status?: unknown;
  ends_at?: unknown;
  entitlements?: Array<{ entitlement_id?: unknown; period?: unknown }> | null;
}

interface RawBalanceEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: { server_time?: unknown; plans?: RawPlan[] | null; balances?: RawBalance[] | null } | null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch seconds → epoch ms; `0`/absent means "no boundary". */
function secondsToMs(value: unknown): number | undefined {
  const seconds = num(value);
  return seconds !== undefined && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

/**
 * Model ids a bucket covers, from `capabilities: ["model:glm-5.3", ...]`.
 *
 * Ported from the desktop bundle's `resolveZaiStartPlanBalanceModelIds`, which
 * strips the `model:` prefix and falls back to `show_name`. Each id is then
 * resolved to the catalog's registered casing so `scope.modelId` matches the
 * model OMP actually has selected — the billing endpoint lowercases these while
 * the catalog registers `GLM-5.3`, and OMP compares the two exactly.
 */
function coveredModels(balance: RawBalance): string[] {
  const capabilities = Array.isArray(balance.capabilities) ? balance.capabilities : [];
  const ids: string[] = [];
  for (const capability of capabilities) {
    const raw = text(capability);
    if (!raw) continue;
    const bare = raw.toLowerCase().startsWith("model:") ? raw.slice(6).trim() : raw;
    if (bare.length > 0) ids.push(canonicalModelId(bare));
  }
  if (ids.length > 0) return ids;
  const fallback = text(balance.show_name);
  return fallback ? [canonicalModelId(fallback)] : [];
}

/**
 * Classify a bucket.
 *
 * `exhausted` at zero available units so OMP's credential ranking can route to
 * another account; `warning` from 90% consumed.
 */
function statusFor(used: number | undefined, total: number | undefined, available: number | undefined): UsageStatus {
  if (available !== undefined && available <= 0) return "exhausted";
  if (used === undefined || total === undefined || total <= 0) return "unknown";
  const fraction = used / total;
  if (fraction >= 1) return "exhausted";
  return fraction >= 0.9 ? "warning" : "ok";
}

/** Last good report per account, so a failed refresh degrades to stale data. */
const lastGood = new Map<string, UsageReport>();

/** Drop cached usage reports. Test seam. */
export function resetUsageCache(): void {
  lastGood.clear();
}

/**
 * Convert one balance bucket into an OMP usage limit.
 *
 * `planName` and the entitlement's `period` come from `data.plans[]`, which is
 * where the human-readable plan title and window cadence live.
 */
function toLimit(
  balance: RawBalance,
  accountId: string | undefined,
  plans: readonly RawPlan[],
): UsageLimit | null {
  const id = text(balance.bucket_id) ?? text(balance.entitlement_id);
  if (!id) return null;

  const planId = text(balance.plan_id);
  const plan = plans.find((candidate) => text(candidate.plan_id) === planId);
  const planName = text(plan?.name);
  const entitlementId = text(balance.entitlement_id);
  const period =
    text(plan?.entitlements?.find((entry) => text(entry.entitlement_id) === entitlementId)?.period) ?? "period";

  const showName = text(balance.show_name);
  const models = coveredModels(balance);
  const used = num(balance.used_units);
  const total = num(balance.total_units);
  const available = num(balance.available_units) ?? num(balance.remaining_units);
  const periodEnd = secondsToMs(balance.period_end) ?? secondsToMs(balance.expires_at);

  return {
    id,
    label: planName ? `${showName ?? "Quota"} · ${planName}` : (showName ?? id),
    scope: {
      provider: ZCODE_PROVIDER_ID,
      ...(accountId ? { accountId } : {}),
      ...(models.length === 1 ? { modelId: models[0] } : {}),
      ...(planId ? { tier: planId } : {}),
      windowId: period,
    },
    window: {
      id: period,
      label: period === "one_time" ? "One-time" : period.charAt(0).toUpperCase() + period.slice(1),
      ...(periodEnd !== undefined ? { resetsAt: periodEnd } : {}),
    },
    amount: {
      ...(used !== undefined ? { used } : {}),
      ...(total !== undefined ? { limit: total } : {}),
      ...(available !== undefined ? { remaining: available } : {}),
      unit: text(balance.unit_type) === "token" ? "tokens" : "unknown",
    },
    status: statusFor(used, total, available),
    ...(models.length > 1 ? { notes: [`Models: ${models.join(", ")}`] } : {}),
  };
}

/**
 * Fetch one account's Start Plan entitlements.
 *
 * Returns a report built from the live balance, or the previous report for the
 * same account marked stale. Returns `null` only when there is no credential
 * and nothing cached — OMP then shows the account as unknown rather than empty.
 */
async function fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
  const jwt = params.credential.accessToken?.trim() || params.credential.apiKey?.trim();
  const accountId = params.credential.accountId?.trim();
  const cacheKey = accountId ?? params.accountKey ?? ZCODE_PROVIDER_ID;
  const cached = lastGood.get(cacheKey);

  if (!jwt) return staleOr(cached, "No ZCode Start Plan credential stored for this account.");

  const url = `${BALANCE_URL}?app_version=${encodeURIComponent(ZCODE_APP_VERSION)}`;
  const deviceMid = accountId ? accountState(accountId).deviceMid : undefined;

  let envelope: RawBalanceEnvelope;
  try {
    const response = await ctx.fetch(url, {
      method: "GET",
      headers: {
        ...identityHeaders(deviceMid),
        // Raw token, no `Bearer` — matches the desktop client's
        // `fetchZaiStartPlanBalanceEnvelope`.
        authorization: jwt,
        accept: "application/json",
      },
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok) {
      // 401/403 is a definitive credential verdict, not a transient refresh
      // failure. `validatesCredentials: true` promises OMP that this fetcher can
      // authenticate a credential, so a revoked plan JWT MUST throw — returning
      // stale data would report a dead account as healthy and keep it in the
      // rotation. Mirrors `usage/opencode-go.ts`. Every other status stays soft.
      if (response.status === 401 || response.status === 403) {
        throw new ProviderHttpError(`ZCode balance endpoint returned ${response.status}`, response.status);
      }
      ctx.logger?.warn("zcode balance request failed", { status: response.status });
      return staleOr(cached, `ZCode balance request failed with HTTP ${response.status}.`);
    }
    envelope = (await response.json()) as RawBalanceEnvelope;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    ctx.logger?.warn("zcode balance request threw", { error: String(error) });
    return staleOr(cached, "ZCode balance request could not be completed.");
  }

  if (num(envelope.code) !== 0) {
    return staleOr(cached, `ZCode balance rejected the request: ${text(envelope.msg) ?? "unknown error"}.`);
  }

  const plans = envelope.data?.plans ?? [];
  const limits: UsageLimit[] = [];
  for (const balance of envelope.data?.balances ?? []) {
    const limit = toLimit(balance, accountId, plans);
    if (limit) limits.push(limit);
  }

  // A valid envelope with no buckets means the plan genuinely grants nothing
  // right now, which is different from a failed refresh — but it still must not
  // silently overwrite a known-good report with zeros.
  if (limits.length === 0 && cached) {
    return staleOr(cached, "ZCode reported no active Start Plan entitlements.");
  }

  const activePlans = plans
    .map((plan) => text(plan.name))
    .filter((name): name is string => name !== undefined);

  const report: UsageReport = {
    provider: ZCODE_PROVIDER_ID,
    fetchedAt: secondsToMs(envelope.data?.server_time) ?? Date.now(),
    limits,
    ...(activePlans.length > 0 ? { notes: [`Plans: ${activePlans.join(", ")}`] } : {}),
  };
  lastGood.set(cacheKey, report);
  return report;
}

/**
 * Serve the previous report, annotated with why it is stale.
 *
 * The limits themselves are preserved verbatim so `/usage` shows the last known
 * remaining quota instead of a misleading zero.
 */
function staleOr(cached: UsageReport | undefined, reason: string): UsageReport | null {
  if (!cached) return null;
  return {
    ...cached,
    limits: cached.limits.map((limit) => ({ ...limit, status: "unknown" as UsageStatus })),
    notes: [...(cached.notes ?? []), `Stale — ${reason}`],
  };
}

/** OMP usage provider for `zcode`. */
export const zcodeUsageProvider: UsageProvider = {
  id: ZCODE_PROVIDER_ID,
  fetchUsage,
  validatesCredentials: true,
  retainLastGoodOnFailure: true,
};
