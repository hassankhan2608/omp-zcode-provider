/**
 * /claim command + auto-claim wiring tests.
 * Drives the real createExtension with a fake pi/ctx: stubbed auth storage,
 * transport, and captcha; asserts preview → selection → confirmation → claim
 * flow, print-mode safety, and scheduler opt-out.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { createExtension, ZCODE_PROVIDER_ID } from "../src/extension.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { resetAccountState } from "../src/account-state.js";
import { asFetch, type FetchHandler } from "./fetch-stub.js";

const oauthStub: NonNullable<ProviderConfig["oauth"]> = {
  name: "ZCode (Start Plan)",
  async login() {
    return "jwt";
  },
};

interface Registration {
  name: string;
  config: ProviderConfig;
}

interface FakePi {
  registrations: Registration[];
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
  entries: Array<{ customType: string; data: unknown }>;
  sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void>;
  api: ExtensionAPI;
}

function fakePi(): FakePi {
  const registrations: Registration[] = [];
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void> = [];
  const api = {
    registerProvider(name: string, config: ProviderConfig) {
      registrations.push({ name, config });
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }) {
      commands.set(name, options);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  return { registrations, commands, entries, sessionStartHandlers, api };
}

interface StoredRow {
  id: number;
  provider: string;
  credential: { type: "oauth"; access: string; accountId?: string; email?: string; orgId?: string; orgName?: string };
  disabledCause: string | null;
}

function authStorageWith(rows: StoredRow[]) {
  return { listStoredCredentials: (provider: string) => (provider === ZCODE_PROVIDER_ID ? rows : []) };
}

interface UiSpy {
  notifications: string[];
  selectResult?: string;
  confirmResult?: boolean;
  selections: Array<{ title: string; labels: string[] }>;
  confirmations: string[];
}

interface FakeCtxOptions {
  rows: StoredRow[];
  ui: UiSpy;
  hasUI?: boolean;
  intervals?: number[];
}

function fakeCtx(options: FakeCtxOptions): unknown {
  const { rows, ui, intervals = [] } = options;
  return {
    hasUI: options.hasUI ?? true,
    ui: {
      notify: (message: string) => ui.notifications.push(message),
      async select(_title: string, options: Array<{ label: string }>) {
        ui.selections.push({ title: _title, labels: options.map((option) => option.label) });
        return ui.selectResult ?? options[0]?.label;
      },
      async confirm(_title: string, message: string) {
        ui.confirmations.push(`${_title} ${message}`);
        return ui.confirmResult ?? true;
      },
    },
    modelRegistry: { authStorage: authStorageWith(rows) },
    setInterval: (_callback: () => void, ms: number) => {
      intervals.push(ms);
      return 0 as unknown as NodeJS.Timeout;
    },
  };
}

function activeRow(id: number, email: string, accountId: string): StoredRow {
  return {
    id,
    provider: ZCODE_PROVIDER_ID,
    credential: {
      type: "oauth",
      access: `jwt-${id}`,
      accountId,
      email,
      orgId: "zai",
      orgName: "ZCode Start Plan (zai)",
    },
    disabledCause: null,
  };
}

const captchaStub = {
  async getCaptchaToken() {
    return { verifyParam: "cap-token", region: "sgp" };
  },
  urgentCaptcha() {},
  async startCaptchaPool() {},
  shutdownCaptcha() {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const availableBody = {
  code: 0,
  data: {
    plans: [
      {
        plan_id: "zcode-v3-start-plan-0901-2",
        name: "ZCode Global Build",
        priority: 110,
        entitlements: [
          { entitlement_id: "e1", show_name: "GLM-5.3-Flash", grant_units: 100_000_000, unit_type: "token", period: "one_time" },
        ],
      },
    ],
  },
};

const claimedBody = { code: 0, data: { plan: { plan_id: "zcode-v3-start-plan-0901-2", starts_at: 1, ends_at: 2 } } };

let handlers: FetchHandler[] = [];
let handlerIndex = 0;

function sequentialFetch(): typeof fetch {
  handlerIndex = 0;
  return asFetch(async (input, init) => {
    const handler = handlers[Math.min(handlerIndex, handlers.length - 1)]!;
    handlerIndex += 1;
    return handler(input, init);
  });
}

beforeEach(() => {
  resetAccountState();
  handlers = [];
  handlerIndex = 0;
});

afterAll(() => {
  resetAccountState();
});

function build(rows: StoredRow[], fetchImpl?: typeof fetch): FakePi {
  const fake = fakePi();
  void createExtension({
    loadModels: () => FALLBACK_MODELS,
    discoverModels: async () => FALLBACK_MODELS,
    createOAuth: () => oauthStub,
    captcha: captchaStub,
    ...(fetchImpl ? { fetchImpl } : {}),
  })(fake.api);
  return fake;
}

async function runCommand(fake: FakePi, ctx: unknown, args = ""): Promise<void> {
  const command = fake.commands.get("claim");
  if (!command) throw new Error("/claim not registered");
  await command.handler(args, ctx);
}

describe("/claim command", () => {
  it("registers a claim command", () => {
    const fake = build([activeRow(1, "a@x.dev", "u-1")]);
    expect(fake.commands.has("claim")).toBe(true);
  });

  it("reports when no ZCode accounts are stored", async () => {
    const fake = build([]);
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };
    await runCommand(fake, fakeCtx({ rows: [], ui }));
    expect(ui.notifications[0]).toContain("No stored ZCode accounts");
  });

  it("reports when previews are empty", async () => {
    handlers = [async () => jsonResponse({ code: 0, data: { plans: [] } })];
    const fake = build([activeRow(1, "a@x.dev", "u-1")], sequentialFetch());
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };
    await runCommand(fake, fakeCtx({ rows: [activeRow(1, "a@x.dev", "u-1")], ui }));
    expect(ui.notifications[0]).toContain("No claimable");
  });

  it("claims the available plan immediately, without selection or confirmation", async () => {
    let claimPosts = 0;
    handlers = [
      async () => jsonResponse(availableBody),
      async () => {
        claimPosts += 1;
        return jsonResponse(claimedBody);
      },
    ];
    const fake = build([activeRow(1, "a@x.dev", "u-1")], sequentialFetch());
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };
    await runCommand(fake, fakeCtx({ rows: [activeRow(1, "a@x.dev", "u-1")], ui }));

    expect(ui.selections).toHaveLength(0);
    expect(ui.confirmations).toHaveLength(0);
    expect(claimPosts).toBe(1);
    expect(ui.notifications.some((n) => n.toLowerCase().includes("claimed"))).toBe(true);
  });

  it("claims every account that has something available", async () => {
    let claimPosts = 0;
    handlers = [
      async () => jsonResponse(availableBody),
      async () => jsonResponse(availableBody),
      async () => {
        claimPosts += 1;
        return jsonResponse(claimedBody);
      },
      async () => {
        claimPosts += 1;
        return jsonResponse(claimedBody);
      },
    ];
    const rows = [activeRow(1, "a@x.dev", "u-1"), activeRow(2, "b@x.dev", "u-2")];
    const fake = build(rows, sequentialFetch());
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };

    await runCommand(fake, fakeCtx({ rows, ui }));

    expect(ui.selections).toHaveLength(0);
    expect(ui.confirmations).toHaveLength(0);
    expect(claimPosts).toBe(2);
  });

  it("claims in print mode too, since the scheduler already claims unattended", async () => {
    let claimPosts = 0;
    handlers = [
      async () => jsonResponse(availableBody),
      async () => {
        claimPosts += 1;
        return jsonResponse(claimedBody);
      },
    ];
    const fake = build([activeRow(1, "a@x.dev", "u-1")], sequentialFetch());
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };
    await runCommand(fake, fakeCtx({ rows: [activeRow(1, "a@x.dev", "u-1")], ui, hasUI: false }));

    expect(claimPosts).toBe(1);
    expect(ui.notifications.some((n) => n.toLowerCase().includes("claimed"))).toBe(true);
  });

  it("surfaces a per-account claim failure without stopping the other accounts", async () => {
    let claimPosts = 0;
    handlers = [
      async () => jsonResponse(availableBody),
      async () => jsonResponse(availableBody),
      async () => {
        claimPosts += 1;
        return jsonResponse({ code: 1003, msg: "already claimed" });
      },
      async () => {
        claimPosts += 1;
        return jsonResponse(claimedBody);
      },
    ];
    const rows = [activeRow(1, "a@x.dev", "u-1"), activeRow(2, "b@x.dev", "u-2")];
    const fake = build(rows, sequentialFetch());
    const ui: UiSpy = { notifications: [], selections: [], confirmations: [] };

    await runCommand(fake, fakeCtx({ rows, ui }));

    expect(claimPosts).toBe(2);
    expect(ui.notifications.some((n) => n.includes("Claim failed"))).toBe(true);
    expect(ui.notifications.some((n) => n.toLowerCase().includes("claimed"))).toBe(true);
  });
});

describe("auto-claim scheduler wiring", () => {
  function sessionCtx(rows: StoredRow[], intervals: number[]): unknown {
    return {
      hasUI: false,
      modelRegistry: { authStorage: authStorageWith(rows) },
      setInterval: (_callback: () => void, ms: number) => {
        intervals.push(ms);
        return 0 as unknown as NodeJS.Timeout;
      },
      ui: { notify: () => {} },
    };
  }

  it("starts a contained 5-minute interval on session_start by default", () => {
    const fake = build([activeRow(1, "a@x.dev", "u-1")]);
    const intervals: number[] = [];
    const ctx = sessionCtx([activeRow(1, "a@x.dev", "u-1")], intervals);
    for (const handler of fake.sessionStartHandlers) void handler({}, ctx);
    expect(intervals).toEqual([300_000]);
  });

  it("does not schedule when ZCODE_CLAIM_AUTO=0", () => {
    const fake = build([activeRow(1, "a@x.dev", "u-1")]);
    process.env.ZCODE_CLAIM_AUTO = "0";
    try {
      const intervals: number[] = [];
      const ctx = sessionCtx([activeRow(1, "a@x.dev", "u-1")], intervals);
      for (const handler of fake.sessionStartHandlers) void handler({}, ctx);
      expect(intervals).toEqual([]);
    } finally {
      delete process.env.ZCODE_CLAIM_AUTO;
    }
  });

  it("skips an interval tick while the previous one is still running", async () => {
    // A multi-account tick can outlive the 5-minute cadence (each account may
    // mint a captcha). Without a guard the second tick would preview and claim
    // the same plans concurrently.
    const firstPreview = Promise.withResolvers<void>();
    const releasePreview = Promise.withResolvers<void>();
    let previews = 0;
    handlers = [
      async () => {
        previews += 1;
        firstPreview.resolve();
        await releasePreview.promise;
        return jsonResponse({ code: 0, data: { plans: [] } });
      },
      async () => {
        previews += 1;
        return jsonResponse({ code: 0, data: { plans: [] } });
      },
    ];
    const row = activeRow(1, "a@x.dev", "u-1");
    const fake = build([row], sequentialFetch());
    const ticks: Array<() => void> = [];
    const ctx = {
      hasUI: false,
      modelRegistry: { authStorage: authStorageWith([row]) },
      setInterval: (callback: () => void) => {
        ticks.push(callback);
        return 0 as unknown as NodeJS.Timeout;
      },
      ui: { notify: () => {} },
    };

    for (const handler of fake.sessionStartHandlers) void handler({}, ctx);
    await firstPreview.promise;
    // Fire the interval while the session-start tick is still in flight.
    for (const tick of ticks) tick();
    releasePreview.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(previews).toBe(1);
  });

  it("immediately auto-claims on session start and shows the rich fireworks card", async () => {
    let claimPosts = 0;
    const claimSeen = Promise.withResolvers<void>();
    const widgetShown = Promise.withResolvers<void>();
    handlers = [
      async () => jsonResponse(availableBody),
      async () => {
        claimPosts += 1;
        claimSeen.resolve();
        return jsonResponse(claimedBody);
      },
    ];
    const row = activeRow(1, "a@x.dev", "u-1");
    const fake = build([row], sequentialFetch());
    const intervals: number[] = [];
    const rendered: string[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      modelRegistry: { authStorage: authStorageWith([row]) },
      setInterval: (_callback: () => void, ms: number) => {
        intervals.push(ms);
        return 0 as unknown as NodeJS.Timeout;
      },
      ui: {
        notify: () => {},
        setWidget: (_key: string, content: unknown) => {
          if (typeof content !== "function") return;
          const component = content({ requestRender() {} }, {});
          if (component && typeof component === "object" && "render" in component && typeof component.render === "function") {
            rendered.push(...component.render(80));
          }
          widgetShown.resolve();
        },
      },
    };

    for (const handler of fake.sessionStartHandlers) void handler({}, ctx);
    await claimSeen.promise;
    await widgetShown.promise;

    expect(claimPosts).toBe(1);
    expect(intervals).toEqual([300_000]);
    const plain = rendered.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("100,000,000 TOKENS");
    expect(plain).toContain("GLM-5.3-Flash · 100M tokens · one-time");
  });
});
