/**
 * Rate-limit smoke probe (manual, not part of `bun test`).
 *
 * Two halves, both through the REAL client + scheduler:
 *   1. a stub gateway that answers 429 (with and without `Retry-After`), to
 *      show one 429 pauses every account, logs once, and reports the window;
 *   2. exactly ONE live preview against the real endpoint, to prove the normal
 *      path still parses. It stays at one request on purpose - provoking a real
 *      429 would mean deliberately hammering the user's own account.
 *
 * Run: bun run rate-limit-probe.ts
 */
import { ClaimScheduler } from "./src/claim-scheduler.js";
import { createClaimClient } from "./src/claim.js";
import { importFromZCodeConfig } from "./src/credential.js";
import { asFetch } from "./tests/fetch-stub.js";
import type { SchedulerAccount } from "./src/claim-scheduler.js";

const accounts: SchedulerAccount[] = [
  { jwt: "jwt-a", accountId: "probe-a", email: "a@probe.dev" },
  { jwt: "jwt-b", accountId: "probe-b", email: "b@probe.dev" },
];

function run(label: string, retryAfter?: string): Promise<void> {
  let previews = 0;
  let nowMs = 1_000_000;
  const logs: string[] = [];
  const scheduler = new ClaimScheduler({
    listAccounts: () => accounts,
    createClient: (account) =>
      createClaimClient({
        account,
        fetchImpl: asFetch(async () => {
          previews += 1;
          return new Response("HTTP 429", {
            status: 429,
            ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
          });
        }),
      }),
    getCaptcha: () => Promise.reject(new Error("probe never claims")),
    config: { pollIntervalMs: 300_000, cooldownMs: 600_000 },
    log: (message) => logs.push(message),
    now: () => nowMs,
  });

  return (async () => {
    const first = await scheduler.tick();
    const wakeAfterFirst = scheduler.nextWakeInMs();
    nowMs += 1_000;
    const second = await scheduler.tick();
    console.log(
      [
        `${label}:`,
        `tick1=${first.action}`,
        `tick2=${second.action}`,
        `previewRequests=${previews}`,
        `wake=${Math.round(wakeAfterFirst / 1000)}s`,
        `logLines=${logs.length}`,
      ].join(" "),
    );
    for (const line of logs) console.log(`    ${line}`);
  })();
}

await run("no Retry-After ");
await run("Retry-After 45", "45");

const installed = importFromZCodeConfig();
if (installed.length === 0) {
  console.log("live preview: skipped (no installed ZCode credential)");
} else {
  const credential = installed[0].credential;
  const client = createClaimClient({ account: { jwt: credential.jwt, accountId: credential.userId } });
  try {
    const plans = await client.getPreviews();
    console.log(`live preview: ok, ${plans.length} claimable plan(s) for ${credential.userId}`);
  } catch (error) {
    console.log(`live preview: ${error instanceof Error ? error.message : String(error)}`);
  }
}
