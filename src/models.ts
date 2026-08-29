/**
 * Start Plan model discovery.
 *
 * The catalog is whatever the live ZCode client-config endpoint returns:
 * `GET https://zcode.z.ai/api/v1/client/configs` → `data.builtinModels` for
 * model metadata and `data.configs.startPlanPreview.entitlements` for the set
 * of models the Start Plan actually grants. This is the same endpoint
 * zcode-api reads its captcha config from (`src/proxy/captcha.ts`), so there is
 * one discovery surface rather than two.
 *
 * Failure policy, in order of precedence:
 *   1. A successful response with at least one model replaces the catalog.
 *   2. A successful but empty response NEVER replaces a valid catalog.
 *   3. Any failure NEVER replaces a valid catalog.
 *   4. With no catalog ever fetched, the pinned fallback below is used so the
 *      provider is always selectable. Its values are the current GLM-5.3
 *      family limits (1M context, 128K output, low/high/max effort).
 */
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { GLM53_DEFAULT_EFFORT, GLM53_EFFORT_LEVELS, isGlm53Model } from "./reasoning.js";
import { ZCODE_APP_VERSION, ZCODE_ORIGIN, zcodePlatform } from "./identity-context.js";

/** Catalog freshness window. Matches zcode-api's client-config cache intent. */
export const CATALOG_TTL_MS = 3_600_000;

/**
 * Ceiling on one discovery request. Same value zcode-api uses for its own
 * `GET /api/v1/agent/configs` probe (`endpoint-routing.ts REQUEST_TIMEOUT_MS`).
 */
export const REQUEST_TIMEOUT_MS = 3_000;

/** Raw `data.builtinModels[]` entry. */
interface RawModel {
  modelId?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  maxCompletionTokens?: unknown;
  capabilities?: { vision?: unknown } | null;
  reasoning?: { levels?: Record<string, unknown> | null; defaultLevel?: unknown } | null;
  modalities?: { input?: unknown } | null;
  priority?: unknown;
}

/** Raw `data.configs.startPlanPreview` entry. */
interface RawStartPlanPreview {
  planId?: unknown;
  name?: unknown;
  entitlements?: Array<{ showName?: unknown; show_name?: unknown }> | null;
}

interface RawClientConfigs {
  code?: unknown;
  data?: {
    builtinModels?: RawModel[] | null;
    configs?: { startPlanPreview?: RawStartPlanPreview | null } | null;
  } | null;
}

/**
 * Start Plan models are free of charge, so every cost bucket is zero. Declared
 * once because `ProviderModelConfig.cost` is required per model.
 */
const FREE: ProviderModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Pinned catalog used only before the first successful discovery.
 *
 * These are the live GLM-5.3-family values returned by the current client
 * config: 1,000,000-token context, 128,000-token completion ceiling, three
 * effort levels defaulting to `max`, vision on Flash only.
 */
export const FALLBACK_MODELS: readonly ProviderModelConfig[] = [
  {
    id: "GLM-5.3",
    name: "GLM-5.3",
    reasoning: true,
    thinking: glm53Thinking(),
    input: ["text"],
    cost: FREE,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    thinking: glm53Thinking(),
    input: ["text", "image"],
    cost: FREE,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
];

/**
 * The GLM-5.3 effort ladder as OMP thinking metadata.
 *
 * `mode: "budget"` is deliberate: OMP emits `thinking.budget_tokens`, and
 * `transforms.ts` converts that budget into the pair ZCode's gateway actually
 * honors (`output_config.effort` + `thinking.budget_tokens`). Encoding the
 * effort label directly would put it in Anthropic's `thinking.effort` field,
 * which this gateway ignores. The cast is the single boundary where the
 * catalog's `Effort` string enum meets plain literals.
 */
function glm53Thinking(): ProviderModelConfig["thinking"] {
  return {
    mode: "budget",
    efforts: GLM53_EFFORT_LEVELS,
    defaultLevel: GLM53_DEFAULT_EFFORT,
  } as ProviderModelConfig["thinking"];
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Convert one raw catalog entry into an OMP model registration.
 *
 * `modelId` is registered verbatim — the gateway matches model ids
 * case-sensitively, so `GLM-5.3` must stay `GLM-5.3`. Reasoning metadata is
 * taken from the entry's own `reasoning.levels`/`defaultLevel` when ZCode
 * supplies them; the GLM-5.3 ladder is used for that family so the effort
 * values stay in lockstep with `reasoning.ts`.
 */
function toProviderModel(raw: RawModel): ProviderModelConfig | null {
  const id = trimmed(raw.modelId);
  if (!id) return null;

  const contextWindow = positiveInt(raw.contextWindow);
  const maxTokens = positiveInt(raw.maxCompletionTokens);
  if (contextWindow === undefined || maxTokens === undefined) return null;

  const levels = Object.keys(raw.reasoning?.levels ?? {});
  const reasoning = levels.length > 0;
  const modalityInput = Array.isArray(raw.modalities?.input) ? raw.modalities.input : [];
  const vision = raw.capabilities?.vision === true || modalityInput.includes("image");

  return {
    id,
    name: trimmed(raw.name) ?? id,
    reasoning,
    ...(reasoning
      ? {
          thinking: isGlm53Model(id)
            ? glm53Thinking()
            : ({
                mode: "budget",
                efforts: levels,
                ...(trimmed(raw.reasoning?.defaultLevel) ? { defaultLevel: trimmed(raw.reasoning?.defaultLevel) } : {}),
              } as ProviderModelConfig["thinking"]),
        }
      : {}),
    input: vision ? ["text", "image"] : ["text"],
    cost: FREE,
    contextWindow,
    maxTokens,
  };
}

/**
 * Names of the models the Start Plan grants, lowercased.
 *
 * Drawn from `startPlanPreview.entitlements[].showName`. An empty result means
 * "no entitlement information", which must widen to the whole catalog rather
 * than narrow it to nothing.
 */
function entitledModelNames(preview: RawStartPlanPreview | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const entitlement of preview?.entitlements ?? []) {
    const name = trimmed(entitlement.showName) ?? trimmed(entitlement.show_name);
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

/** In-process catalog cache. Survives for the life of the OMP process. */
interface CatalogCache {
  models: readonly ProviderModelConfig[];
  fetchedAt: number;
}

let cache: CatalogCache | null = null;

/** Discard the cached catalog. Test seam. */
export function resetModelCatalog(): void {
  cache = null;
}

/**
 * The catalog to register right now, without any network access.
 *
 * Extension load must not block on I/O — OMP's startup sits in
 * `loadExtensions` until every extension factory resolves, so a slow or
 * unreachable `client/configs` would stall the whole CLI. Registration takes
 * this value; `fetchDynamicModels` performs the live discovery afterwards,
 * through OMP's own model-cache path.
 */
export function cachedStartPlanModels(): readonly ProviderModelConfig[] {
  return cache?.models ?? FALLBACK_MODELS;
}

/**
 * Map a ZCode model id to the exact casing this provider registered.
 *
 * The catalog registers ids verbatim (`GLM-5.3`), but the billing endpoint
 * names the same models lowercased inside `capabilities` (`model:glm-5.3`).
 * OMP matches usage scopes to models with `limit.scope.modelId === modelId`
 * (`AuthStorage`), an exact comparison — so a lowercased scope would silently
 * detach every limit from its model. Resolving through the live catalog (or
 * the pinned fallback before first discovery) keeps both sides on one spelling.
 * Unknown ids pass through untouched rather than being guessed at.
 */
export function canonicalModelId(raw: string): string {
  const needle = raw.trim().toLowerCase();
  if (needle.length === 0) return raw;
  for (const model of cache?.models ?? FALLBACK_MODELS) {
    if (model.id.toLowerCase() === needle) return model.id;
  }
  return raw;
}

export interface DiscoverOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  appVersion?: string;
  signal?: AbortSignal;
}

/**
 * Fetch the live Start Plan catalog.
 *
 * Returns the parsed model list, or `null` when the endpoint failed or carried
 * no usable model — the caller keeps whatever catalog it already had.
 *
 * The request is bounded by `REQUEST_TIMEOUT_MS`, matching zcode-api's own
 * config-fetch precedent (`endpoint-routing.ts`). Discovery is an optimization
 * over the pinned catalog, so a slow or hanging endpoint must degrade rather
 * than stall the caller.
 */
export async function fetchStartPlanCatalog(
  options: DiscoverOptions = {},
): Promise<readonly ProviderModelConfig[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const appVersion = options.appVersion ?? ZCODE_APP_VERSION;
  const url = `${ZCODE_ORIGIN}/api/v1/client/configs?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(zcodePlatform())}`;

  let payload: RawClientConfigs;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    payload = (await response.json()) as RawClientConfigs;
  } catch {
    return null;
  }
  if (payload.code !== 0) return null;

  const parsed: ProviderModelConfig[] = [];
  for (const raw of payload.data?.builtinModels ?? []) {
    const model = toProviderModel(raw);
    if (model) parsed.push(model);
  }
  if (parsed.length === 0) return null;

  const entitled = entitledModelNames(payload.data?.configs?.startPlanPreview);
  if (entitled.size === 0) return parsed;
  const granted = parsed.filter((model) => entitled.has(model.id.toLowerCase()));
  // An entitlement list that matches nothing in the catalog is a server-side
  // naming drift, not a signal that the plan has zero models.
  return granted.length > 0 ? granted : parsed;
}

/**
 * Resolve the Start Plan catalog, refreshing it when stale.
 *
 * This is the function wired to `ProviderConfig.fetchDynamicModels`. It never
 * returns an empty list and never downgrades a valid catalog on failure.
 */
export async function resolveStartPlanModels(
  options: DiscoverOptions = {},
): Promise<readonly ProviderModelConfig[]> {
  const now = options.now ?? Date.now;
  const at = now();
  if (cache && at - cache.fetchedAt < CATALOG_TTL_MS) return cache.models;

  const fresh = await fetchStartPlanCatalog(options);
  if (fresh) {
    cache = { models: fresh, fetchedAt: at };
    return fresh;
  }
  return cache?.models ?? FALLBACK_MODELS;
}
