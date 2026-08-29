/**
 * Provider registration contract: the shape OMP needs for `/login zcode`,
 * `/model zcode/<model>`, and `/usage`.
 */
import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { createExtension, ZCODE_API_ID, ZCODE_PROVIDER_ID } from "../src/extension.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { zcodeUsageProvider } from "../src/usage.js";
import { asFetch } from "./fetch-stub.js";

/** Unsigned JWT carrying the `user_id` the provider keys accounts on. */
const PLAN_JWT = (() => {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ user_id: "u-stream", iat: 1 })).toString("base64url");
  return `${head}.${body}.c2ln`;
})();

interface Registration {
  name: string;
  config: ProviderConfig;
}

function fakePi(): { registrations: Registration[]; pi: ExtensionAPI } {
  const registrations: Registration[] = [];
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      registrations.push({ name, config });
    },
  } as unknown as ExtensionAPI;
  return { registrations, pi };
}

const oauthStub: NonNullable<ProviderConfig["oauth"]> = {
  name: "ZCode (Start Plan)",
  async login() {
    return "jwt";
  },
};

async function register(
  models: readonly ProviderModelConfig[] = FALLBACK_MODELS,
): Promise<Registration> {
  const { registrations, pi } = fakePi();
  await createExtension({ loadModels: () => models, discoverModels: async () => models, createOAuth: () => oauthStub })(pi);
  expect(registrations).toHaveLength(1);
  return registrations[0]!;
}

describe("registration", () => {
  it("registers under the provider id `zcode`", async () => {
    expect((await register()).name).toBe(ZCODE_PROVIDER_ID);
    expect(ZCODE_PROVIDER_ID).toBe("zcode");
  });

  it("points at the Start Plan Anthropic gateway", async () => {
    expect((await register()).config.baseUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  });

  it("declares a custom api backed by its own streamSimple", async () => {
    const { config } = await register();
    expect(config.api).toBe(ZCODE_API_ID);
    expect(typeof config.streamSimple).toBe("function");
  });

  it("exposes the discovered catalog and a dynamic refresher", async () => {
    const { config } = await register();
    expect(config.models!.map((model) => model.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(typeof config.fetchDynamicModels).toBe("function");
  });

  it("wires OAuth for /login and the usage provider for /usage", async () => {
    const { config } = await register();
    expect(config.oauth).toBe(oauthStub);
    expect(config.usage).toBe(zcodeUsageProvider);
    expect(config.usage!.id).toBe("zcode");
  });

  it("never registers an empty model list", async () => {
    const { config } = await register([]);
    expect(config.models!.length).toBeGreaterThan(0);
    expect(config.models!.map((model) => model.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
  });

  it("sends no static API key: the credential comes from OAuth", async () => {
    const { config } = await register();
    expect(config.apiKey).toBeUndefined();
    expect(config.authHeader).toBeUndefined();
  });
});

describe("streamSimple guard", () => {
  it("refuses to stream without a credential", async () => {
    const { config } = await register();
    const model = { id: "GLM-5.3", api: ZCODE_API_ID } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
    const context = { messages: [] } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
    expect(() => config.streamSimple!(model, context, {})).toThrow(/\/login zcode/);
  });

  it("refuses a credential that is not a plan JWT", async () => {
    const { config } = await register();
    const model = { id: "GLM-5.3", api: ZCODE_API_ID } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
    const context = { messages: [] } as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];
    expect(() => config.streamSimple!(model, context, { apiKey: "not-a-jwt" })).toThrow(/user_id/);
  });
});

describe("streamSimple transport", () => {
  /**
   * The model OMP hands a custom-api `streamSimple` carries the compat of
   * `zcode-start-plan` — which materializes nothing `streamAnthropic` can read.
   * Spreading it and relabelling `api` left `model.compat` undefined and the
   * transport died on `model.compat.supportsEagerToolInputStreaming`.
   */
  const CUSTOM_API_MODEL = {
    id: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    api: ZCODE_API_ID,
    provider: "zcode",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];

  it("materializes anthropic compat instead of inheriting the custom api's", async () => {
    const { registrations, pi } = fakePi();
    let requested = false;
    const fetchImpl = asFetch(async () => {
      requested = true;
      return new Response('{"type":"error","error":{"message":"stub"}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    await createExtension({
      loadModels: () => FALLBACK_MODELS,
      discoverModels: async () => FALLBACK_MODELS,
      createOAuth: () => oauthStub,
      fetchImpl,
      captcha: {
        async getCaptchaToken() {
          return { verifyParam: "stub-param", region: "sgp" };
        },
        urgentCaptcha() {},
        async startCaptchaPool() {},
        shutdownCaptcha() {},
      },
    })(pi);

    const streamSimple = registrations[0]!.config.streamSimple!;
    const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as Parameters<
      NonNullable<ProviderConfig["streamSimple"]>
    >[1];

    // Must not throw synchronously: the crash was a TypeError raised while
    // building the request, before any network call.
    const stream = streamSimple(CUSTOM_API_MODEL, context, { apiKey: PLAN_JWT });
    expect(stream).toBeDefined();

    // Drain so the transport actually builds and dispatches the request.
    try {
      for await (const _event of stream) {
        // The stub upstream answers 400; only reaching it matters here.
      }
    } catch {
      // An upstream error is expected; a compat TypeError would surface above.
    }
    expect(requested).toBe(true);
  });
});
