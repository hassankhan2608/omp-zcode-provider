/**
 * Native OMP provider `zcode` — ZCode Start Plan.
 *
 * Registration shape mirrors the Cline provider: one `pi.registerProvider`
 * call carrying models, OAuth, and usage. The only structural difference is the
 * transport: the Start Plan gateway needs per-request headers (captcha token,
 * fresh trace ids, this account's device id and cookies) and a rewritten body,
 * which a static `headers` map cannot express. So the provider declares a
 * custom `api` and a `streamSimple` that delegates to OMP's own
 * `streamAnthropic` with a wrapped `fetch` — OMP still owns streaming, tool
 * calls, aborts, and incomplete-stream detection; the wrapper owns only the
 * ZCode boundary.
 *
 * Everything user-facing stays native:
 *   /login zcode          → `oauth.login`
 *   /model zcode/<model>   → discovered catalog
 *   /usage                 → `usage`
 */
import { streamAnthropic } from "@oh-my-pi/pi-ai";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { CaptchaModule } from "./captcha-module.js";
import { createZCodeOAuth } from "./oauth.js";
import { dispatchStartPlanRequest } from "./request.js";
import { decodeJwtPayload } from "./credential.js";
import { cachedStartPlanModels, FALLBACK_MODELS, resolveStartPlanModels } from "./models.js";
import { STARTPLAN_ANTHROPIC_BASE } from "./identity-context.js";
import { zcodeUsageProvider } from "./usage.js";

/** Provider id registered with OMP. */
export const ZCODE_PROVIDER_ID = "zcode";

/**
 * Custom API id. Distinct from `anthropic-messages` so OMP routes requests
 * through this extension's `streamSimple` instead of the built-in transport.
 */
export const ZCODE_API_ID = "zcode-start-plan";

/**
 * Resolve the account the request belongs to.
 *
 * OMP hands `streamSimple` the resolved credential as `options.apiKey`, which
 * for this provider is the plan JWT. Its `user_id` claim is the account id, so
 * account-scoped state (device id, cookies, captcha, session affinity) follows
 * the credential automatically — including when OMP retries a turn on a
 * different stored account.
 */
function accountIdFor(jwt: string): string {
  const payload = decodeJwtPayload(jwt);
  const userId = typeof payload?.user_id === "string" ? payload.user_id : undefined;
  const subject = typeof payload?.sub === "string" ? payload.sub : undefined;
  const resolved = (userId ?? subject)?.trim();
  if (!resolved) throw new Error("ZCode Start Plan credential has no user_id");
  return resolved;
}

export interface ExtensionDependencies {
  /**
   * Catalog registered at load. Synchronous by contract: no network access, so
   * OMP's `loadExtensions` phase never waits on `client/configs`.
   */
  loadModels: () => readonly ProviderModelConfig[];
  /** Live discovery, run lazily by OMP through `fetchDynamicModels`. */
  discoverModels: () => Promise<readonly ProviderModelConfig[]>;
  createOAuth: () => NonNullable<ProviderConfig["oauth"]>;
  fetchImpl?: typeof fetch;
  /** Injectable captcha module; tests pass a stub so no solve is attempted. */
  captcha?: CaptchaModule;
}

const defaultDependencies: ExtensionDependencies = {
  loadModels: cachedStartPlanModels,
  discoverModels: resolveStartPlanModels,
  createOAuth: createZCodeOAuth,
};

/**
 * Stream one Start Plan turn.
 *
 * The model is re-declared as `anthropic-messages` because the wire format
 * *is* Anthropic Messages; only the transport differs. `fetch` is replaced with
 * the ZCode pipeline, so `streamAnthropic` never sees the gateway's URL,
 * headers, or captcha requirements.
 */
export function createStreamSimple(fetchImpl?: typeof fetch, captcha?: CaptchaModule) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const jwt = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
    if (jwt.length === 0) {
      throw new Error("ZCode Start Plan requires a credential. Run /login zcode.");
    }
    const accountId = accountIdFor(jwt);

    // `buildModel`, not a spread: OMP materializes `compat` and `thinking` from
    // the api at build time, and the model handed to a custom-api
    // `streamSimple` carries the compat of `zcode-start-plan` — i.e. nothing
    // `streamAnthropic` can use. Re-declaring the api on a spread copy leaves
    // `model.compat` undefined and the transport dies on
    // `model.compat.supportsEagerToolInputStreaming`. Same
    // synthesize-a-model-for-a-proxied-transport pattern pi-ai itself uses in
    // `providers/gitlab-duo.ts`.
    const anthropicModel = buildModel({
      ...model,
      api: "anthropic-messages",
      baseUrl: STARTPLAN_ANTHROPIC_BASE,
    } as ModelSpec<"anthropic-messages">);

    return streamAnthropic(anthropicModel, context, {
      ...options,
      apiKey: jwt,
      fetch: (input, init) =>
        dispatchStartPlanRequest(
          { accountId, jwt, ...(fetchImpl ? { fetchImpl } : {}), ...(captcha ? { captcha } : {}) },
          input as RequestInfo | URL,
          init as RequestInit | undefined,
        ),
    } as Parameters<typeof streamAnthropic>[2]);
  };
}

export function createExtension(deps: ExtensionDependencies = defaultDependencies) {
  return (pi: ExtensionAPI): void => {
    const models = deps.loadModels();
    // `cachedStartPlanModels` already guarantees this, but a caller-supplied
    // loader must not be able to register a provider with nothing selectable.
    const registered = models.length > 0 ? models : FALLBACK_MODELS;

    pi.registerProvider(ZCODE_PROVIDER_ID, {
      baseUrl: STARTPLAN_ANTHROPIC_BASE,
      api: ZCODE_API_ID,
      streamSimple: createStreamSimple(deps.fetchImpl, deps.captcha),
      models: [...registered],
      fetchDynamicModels: async () => [...(await deps.discoverModels())],
      oauth: deps.createOAuth(),
      usage: zcodeUsageProvider,
    });
  };
}

export default createExtension();
