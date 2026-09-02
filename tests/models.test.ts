/**
 * Model discovery from the live ZCode client-config endpoint, plus the
 * stale-catalog fallback policy.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  CATALOG_TTL_MS,
  FALLBACK_MODELS,
  fetchStartPlanCatalog,
  resetModelCatalog,
  resolveStartPlanModels,
} from "../src/models.js";
import { asFetch } from "./fetch-stub.js";

/** The GLM-5.3 effort ladder as it appears on a registered model. */
const GLM53_THINKING = { mode: "budget", efforts: ["low", "high", "max"], defaultLevel: "max" };

/** Shape of the live `data.builtinModels[]` entries, as observed 2026-08-29. */
function builtinModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: "GLM-5.3",
    name: "GLM-5.3",
    contextWindow: 1_000_000,
    maxCompletionTokens: 128_000,
    capabilities: {},
    reasoning: { levels: { low: {}, high: {}, max: {} }, defaultLevel: "max" },
    modalities: {},
    ...overrides,
  };
}

function configResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function payload(models: unknown[], entitlements?: unknown[]): unknown {
  return {
    code: 0,
    data: {
      builtinModels: models,
      configs: entitlements ? { startPlanPreview: { planId: "zcode-v3-start-plan", entitlements } } : {},
    },
  };
}

/** A stub that always answers with `body`. */
function always(body: unknown, status = 200): typeof fetch {
  return asFetch(async () => configResponse(body, status));
}

interface Counted {
  calls: number;
  fetchImpl: typeof fetch;
}

function counted(body: () => unknown): Counted {
  const state: Counted = { calls: 0, fetchImpl: asFetch(async () => configResponse(null)) };
  state.fetchImpl = asFetch(async () => {
    state.calls += 1;
    return configResponse(body());
  });
  return state;
}

afterEach(() => {
  resetModelCatalog();
});

describe("fetchStartPlanCatalog", () => {
  it("requests the client-config endpoint with app version and platform", async () => {
    let seen = "";
    const fetchImpl = asFetch(async (input) => {
      seen = input instanceof Request ? input.url : String(input);
      return configResponse(payload([builtinModel()]));
    });

    await fetchStartPlanCatalog({ fetchImpl, appVersion: "3.10.1" });
    expect(seen).toStartWith("https://zcode.z.ai/api/v1/client/configs?");
    expect(seen).toContain("app_version=3.10.1");
    expect(seen).toContain("platform=");
  });

  it("registers the exact model id and metadata ZCode returns", async () => {
    const models = await fetchStartPlanCatalog({ fetchImpl: always(payload([builtinModel()])) });

    expect(models).toHaveLength(1);
    const model = models![0];
    // Case is preserved verbatim: the gateway matches model ids case-sensitively.
    expect(model.id).toBe("GLM-5.3");
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(128_000);
    expect(model.reasoning).toBe(true);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("carries the GLM-5.3 effort ladder and default level", async () => {
    const models = await fetchStartPlanCatalog({ fetchImpl: always(payload([builtinModel()])) });
    expect(models![0].thinking as unknown).toEqual(GLM53_THINKING);
  });

  it("marks vision from capabilities or modalities", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(
        payload([
          builtinModel({ modelId: "GLM-5.3-Flash", capabilities: { vision: true } }),
          builtinModel({ modelId: "GLM-5-Turbo", capabilities: { vision: false }, reasoning: {} }),
        ]),
      ),
    });

    expect(models!.find((model) => model.id === "GLM-5.3-Flash")!.input).toEqual(["text", "image"]);
    const turbo = models!.find((model) => model.id === "GLM-5-Turbo")!;
    expect(turbo.input).toEqual(["text"]);
    expect(turbo.reasoning).toBe(false);
    expect(turbo.thinking).toBeUndefined();
  });

  it("marks vision from modalities.input alone", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(payload([builtinModel({ modalities: { input: ["text", "image", "video"] } })])),
    });
    expect(models![0].input).toEqual(["text", "image"]);
  });

  it("narrows the catalog to the Start Plan entitlements", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(
        payload(
          [
            builtinModel({ modelId: "GLM-5.3" }),
            builtinModel({ modelId: "GLM-5.3-Flash" }),
            builtinModel({ modelId: "GLM-5-Turbo" }),
          ],
          [{ showName: "GLM-5.3" }, { showName: "GLM-5.3-Flash" }],
        ),
      ),
    });
    expect(models!.map((model) => model.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
  });

  it("accepts the snake_case entitlement field too", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(
        payload(
          [builtinModel({ modelId: "GLM-5.3" }), builtinModel({ modelId: "GLM-5-Turbo" })],
          [{ show_name: "GLM-5.3" }],
        ),
      ),
    });
    expect(models!.map((model) => model.id)).toEqual(["GLM-5.3"]);
  });

  it("keeps the whole catalog when entitlement names match nothing", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(payload([builtinModel({ modelId: "GLM-5.3" })], [{ showName: "Renamed-Thing" }])),
    });
    expect(models!.map((model) => model.id)).toEqual(["GLM-5.3"]);
  });

  it("skips entries without a usable id or limits", async () => {
    const models = await fetchStartPlanCatalog({
      fetchImpl: always(
        payload([
          builtinModel({ modelId: "  " }),
          builtinModel({ modelId: "GLM-X", contextWindow: 0 }),
          builtinModel({ modelId: "GLM-Y", maxCompletionTokens: null }),
          builtinModel({ modelId: "GLM-5.3" }),
        ]),
      ),
    });
    expect(models!.map((model) => model.id)).toEqual(["GLM-5.3"]);
  });

  it("returns null on a non-2xx response", async () => {
    expect(await fetchStartPlanCatalog({ fetchImpl: always({}, 503) })).toBeNull();
  });

  it("returns null on a non-zero business code", async () => {
    expect(await fetchStartPlanCatalog({ fetchImpl: always({ code: 3001, data: {} }) })).toBeNull();
  });

  it("returns null on a transport failure", async () => {
    const fetchImpl = asFetch(async () => {
      throw new Error("offline");
    });
    expect(await fetchStartPlanCatalog({ fetchImpl })).toBeNull();
  });

  it("returns null on an empty catalog rather than an empty list", async () => {
    expect(await fetchStartPlanCatalog({ fetchImpl: always(payload([])) })).toBeNull();
  });
});

describe("resolveStartPlanModels", () => {
  it("serves the pinned fallback before any successful discovery", async () => {
    const fetchImpl = asFetch(async () => {
      throw new Error("offline");
    });
    expect(await resolveStartPlanModels({ fetchImpl })).toEqual(FALLBACK_MODELS);
  });

  it("caches a successful catalog for the TTL", async () => {
    const state = counted(() => payload([builtinModel()]));
    let clock = 1_000;
    const now = () => clock;

    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    expect(state.calls).toBe(1);

    clock += CATALOG_TTL_MS - 1;
    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    expect(state.calls).toBe(1);
  });

  it("refreshes once the catalog is stale", async () => {
    const state = counted(() => payload([builtinModel()]));
    let clock = 1_000;
    const now = () => clock;

    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    clock += CATALOG_TTL_MS;
    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    expect(state.calls).toBe(2);
  });

  it("preserves the last valid catalog when a refresh fails", async () => {
    let mode: "ok" | "fail" = "ok";
    const fetchImpl = asFetch(async () => {
      if (mode === "fail") throw new Error("offline");
      return configResponse(payload([builtinModel({ modelId: "GLM-5.3-Flash" })]));
    });
    let clock = 1_000;
    const now = () => clock;

    const first = await resolveStartPlanModels({ fetchImpl, now });
    expect(first.map((model) => model.id)).toEqual(["GLM-5.3-Flash"]);

    mode = "fail";
    clock += CATALOG_TTL_MS;
    const second = await resolveStartPlanModels({ fetchImpl, now });
    expect(second.map((model) => model.id)).toEqual(["GLM-5.3-Flash"]);
  });

  it("never replaces a valid catalog with an empty response", async () => {
    let models: unknown[] = [builtinModel({ modelId: "GLM-5.3" })];
    const state = counted(() => payload(models));
    let clock = 1_000;
    const now = () => clock;

    await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    models = [];
    clock += CATALOG_TTL_MS;
    const after = await resolveStartPlanModels({ fetchImpl: state.fetchImpl, now });
    expect(after.map((model) => model.id)).toEqual(["GLM-5.3"]);
  });
});

describe("FALLBACK_MODELS", () => {
  it("pins the current GLM-5.3-family reasoning and output limits", () => {
    expect(FALLBACK_MODELS.map((model) => model.id)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    for (const model of FALLBACK_MODELS) {
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxTokens).toBe(128_000);
      expect(model.reasoning).toBe(true);
      expect(model.thinking as unknown).toEqual(GLM53_THINKING);
    }
    expect(FALLBACK_MODELS[1].input).toEqual(["text", "image"]);
  });
});
