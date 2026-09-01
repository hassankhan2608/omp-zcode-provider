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
import type { Api, AuthStorage, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { CaptchaModule } from "./captcha-module.js";
import { loadCaptcha } from "./captcha-module.js";
import { createZCodeOAuth } from "./oauth.js";
import { dispatchStartPlanRequest } from "./request.js";
import { decodeJwtPayload } from "./credential.js";
import { cachedStartPlanModels, FALLBACK_MODELS, resolveStartPlanModels } from "./models.js";
import { STARTPLAN_ANTHROPIC_BASE, ZCODE_APP_VERSION } from "./identity-context.js";
import { zcodeUsageProvider } from "./usage.js";
import { ClaimPreviewError, createClaimClient, selectClaimTarget, type ClaimablePlan } from "./claim.js";
import { ClaimScheduler, type SchedulerAccount } from "./claim-scheduler.js";
import { showClaimFireworks } from "./claim-fireworks.js";

/** Poll/cooldown defaults mirror zcode-api's `claim` config (v4.5.3). */
const CLAIM_POLL_MS = Number(process.env.ZCODE_CLAIM_POLL_MS || 300_000);
const CLAIM_COOLDOWN_MS = Number(process.env.ZCODE_CLAIM_COOLDOWN_MS || 600_000);
const autoClaimDisabled = (): boolean => process.env.ZCODE_CLAIM_AUTO === "0";

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

    wireClaimFeature(pi, deps);
  };
}

function storedAccounts(modelRegistry: { authStorage: AuthStorage }): SchedulerAccount[] {
  const rows = modelRegistry.authStorage.listStoredCredentials(ZCODE_PROVIDER_ID);
  const accounts: SchedulerAccount[] = [];
  for (const row of rows) {
    const credential = row.credential;
    if (row.disabledCause !== null || credential.type !== "oauth") continue;
    const jwt = credential.access?.trim();
    const accountId = credential.accountId?.trim();
    if (!jwt || !accountId) continue;
    const email = credential.email?.trim();
    accounts.push({ jwt, accountId, ...(email ? { email } : {}) });
  }
  return accounts;
}

/** One captcha token from the background pool (mints on demand). */
async function claimCaptcha(deps: ExtensionDependencies): Promise<{ verifyParam: string; region?: string }> {
  if (deps.captcha) return deps.captcha.getCaptchaToken(ZCODE_APP_VERSION);
  const captcha = await loadCaptcha();
  return captcha.getCaptchaToken(ZCODE_APP_VERSION);
}

function planLabel(plan: ClaimablePlan): string {
  const entitlement = plan.entitlements[0];
  const quota = entitlement ? `${(entitlement.grantUnits / 1_000_000).toFixed(0)}M ${entitlement.showName} (${entitlement.period})` : "";
  return `${plan.name}${quota ? ` — ${quota}` : ""}`;
}

/**
 * Native `/claim` command plus opt-out auto-claim scheduler.
 *
 * Anti-ban posture mirrors the desktop client's `manualClaimPlan`: preview
 * polls are plain GETs, captcha mints only on real claim attempts, and the
 * scheduler holds/cools down per zcode-api's state machine.
 */
function wireClaimFeature(pi: ExtensionAPI, deps: ExtensionDependencies): void {
  const appendNotice = (message: string): void => {
    console.log(`[claim] ${message}`);
    try {
      pi.appendEntry("zcode-claim", { message });
    } catch {
 // Entry append is best-effort; the console line above already informs.
    }
  };

  pi.registerCommand("claim", {
    description: "Claim available ZCode trial plans (preview, select, confirm)",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const accounts = storedAccounts(ctx.modelRegistry);
      if (accounts.length === 0) {
        ctx.ui.notify("No stored ZCode accounts. Run /login zcode first.");
        return;
      }

      const claimed = await Promise.all(
        accounts.map(async (account) => {
          const client = createClaimClient({ account, fetchImpl: deps.fetchImpl });
          try {
            return { account, plans: await client.getPreviews() };
          } catch (error) {
            const status = error instanceof ClaimPreviewError ? error.status : undefined;
            const hint = status === 404 ? " (campaign endpoint not active)" : "";
            return { account, plans: [] as ClaimablePlan[], error: `${(error as Error).message}${hint}` };
          }
        }),
      );

      const available = claimed.filter((entry) => entry.plans.length > 0);
      if (available.length === 0) {
        const errored = claimed.filter((entry) => "error" in entry && entry.error);
        const detail = errored.map((entry) => `${entry.account.email ?? entry.account.accountId}: ${entry.error}`).join("; ");
        ctx.ui.notify(detail ? `No claimable ZCode plans. ${detail}` : "No claimable ZCode plans right now.");
        return;
      }

      const choices = available.flatMap(({ account, plans }) =>
        plans.map((plan) => ({ account, plan, label: `${account.email ?? account.accountId} — ${planLabel(plan)}` })),
      );

      // Print mode has no selection/confirmation UI: report availability only.
      if (!ctx.hasUI) {
        for (const choice of choices) {
          const message = `Claimable: ${choice.label}`;
          ctx.ui.notify(message);
          appendNotice(message);
        }
        return;
      }

      const claimAll = args.trim().toLowerCase() === "all";
      let targets = choices;
      if (!claimAll) {
        const selected = await ctx.ui.select(
          "Claim ZCode plan",
          choices.map((choice) => ({ label: choice.label, description: choice.plan.description || undefined })),
        );
        if (!selected) return;
        targets = choices.filter((choice) => choice.label === selected);
      }

      const summary = targets.map((target) => `${target.account.email ?? target.account.accountId}: ${planLabel(target.plan)}`).join("\n");
      if (!(await ctx.ui.confirm("Claim ZCode plan(s)?", summary))) return;

      for (const target of targets) {
        const client = createClaimClient({ account: target.account, fetchImpl: deps.fetchImpl });
        try {
          const captcha = await claimCaptcha(deps);
          const outcome = await client.claim(target.plan.planId, captcha);
          if (outcome.ok) {
            const message = `Claimed ${target.plan.name} for ${target.account.email ?? target.account.accountId}.`;
            ctx.ui.notify(message);
            appendNotice(`claimed ${target.plan.planId} for ${target.account.email ?? target.account.accountId}`);
            void showClaimFireworks(ctx, message);
          } else {
            ctx.ui.notify(`Claim failed: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}`);
          }
        } catch (error) {
          ctx.ui.notify(`Claim failed: ${(error as Error).message}`);
        }
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (autoClaimDisabled()) return;
    const scheduler = new ClaimScheduler({
      listAccounts: () => storedAccounts(ctx.modelRegistry),
      createClient: (account) => createClaimClient({ account, fetchImpl: deps.fetchImpl }),
      getCaptcha: () => claimCaptcha(deps),
      config: { pollIntervalMs: CLAIM_POLL_MS, cooldownMs: CLAIM_COOLDOWN_MS },
      log: (message) => console.log(`[claim] ${message}`),
      notify: (message: string) => {
        appendNotice(message);
        // Auto-claims happen unattended: celebrate briefly, then self-dismiss.
        void showClaimFireworks(ctx, message, { autoCloseMs: 15_000 });
      },
    });
    // Contained timer: throws are isolated and the timer dies with the session.
    ctx.setInterval(() => {
      void scheduler.tick();
    }, CLAIM_POLL_MS);
  });
}

export default createExtension();
