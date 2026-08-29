/**
 * Live Start Plan smoke test through this extension's own request pipeline.
 * Uses the real captcha solver and the credential from the installed ZCode
 * configuration. Not part of the test suite; run manually with `bun run`.
 */
import { readFileSync } from "node:fs";
import { importFromZCodeConfig, parseStartPlanCredential } from "./src/credential.js";
import { dispatchStartPlanRequest } from "./src/request.js";
import { resolveStartPlanModels } from "./src/models.js";
import { zcodeUsageProvider } from "./src/usage.js";

// `ZCODE_LIVE_JWT_FILE` overrides the installed config, so the smoke test can
// be pointed at a specific account without touching the desktop client.
const override = process.env.ZCODE_LIVE_JWT_FILE;
const cred = override
  ? parseStartPlanCredential(readFileSync(override, "utf-8"), "zai")
  : (() => {
      const installed = importFromZCodeConfig();
      if (installed.length === 0) throw new Error("no installed ZCode Start Plan credential");
      return installed[0]!.credential;
    })();
console.log(`credential: provider=${cred.provider} account=${cred.userId}`);

const models = await resolveStartPlanModels();
console.log(`catalog: ${models.map((m) => `${m.id}(ctx=${m.contextWindow},out=${m.maxTokens})`).join(", ")}`);
const model = models[0]!.id;

const report = await zcodeUsageProvider.fetchUsage(
  { provider: "zcode", credential: { type: "oauth", accessToken: cred.jwt, accountId: cred.userId } },
  { fetch: globalThis.fetch as never },
);
console.log(
  `usage: ${
    report
      ? report.limits.map((l) => `${l.label}=${l.amount.remaining}/${l.amount.limit} ${l.status}`).join(" | ")
      : "null"
  }`,
);

const t0 = Date.now();
const response = await dispatchStartPlanRequest(
  { accountId: cred.userId, jwt: cred.jwt },
  "https://api.anthropic.com/v1/messages",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: zcode-ok" }],
      stream: true,
    }),
  },
);
const contentType = response.headers.get("content-type") ?? "";
if (!contentType.includes("text/event-stream")) {
  console.log(`non-stream body: ${(await response.text()).slice(0, 600)}`);
  process.exit(1);
}

let text = "";
const decoder = new TextDecoder();

for await (const chunk of response.body!) {
  const frame = decoder.decode(chunk as Uint8Array, { stream: true });
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text ?? "";
      }
    } catch {
      // Non-JSON SSE lines (comments, keepalives) are expected.
    }
  }
}
console.log(`streamed text: ${JSON.stringify(text)}`);
process.exit(text.length > 0 ? 0 : 1);
