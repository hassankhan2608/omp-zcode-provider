/**
 * Persistent captcha solve worker.
 *
 * zcode-api keeps `captcha-happy.ts` loaded for the life of the proxy, so its
 * module-level cookie/CDN/SDK caches survive long idle periods. OMP cannot run
 * that module on the main thread because Alibaba guest rejections trigger
 * OMP's own process-level recovery handlers. This worker restores both
 * properties: one long-lived sandbox process with persistent upstream caches,
 * isolated from the agent process.
 */
import { parentPort } from "node:worker_threads";
import { redactCaptchaSecrets } from "./captcha-redact.js";

interface SolveRequest {
  id: string;
  scene: string;
  region: string;
  prefix: string;
}

interface SolveResponse {
  id: string;
  ok: boolean;
  token?: string;
  error?: string;
}

const port = parentPort;
if (!port) throw new Error("captcha worker started without a parent port");

// happy-dom's virtual console and the guest SDK emit devtools-format stdout
// spam and `[WINDOW-ERROR]` diagnostics during browser-feature probes. Those
// probes are expected and do not mean a solve failed. This worker communicates
// only through postMessage; actual crashes still reach the parent through the
// worker error/exit events. CAPTCHA_DEBUG restores upstream diagnostics.
if (!/^(1|true|yes)$/i.test(process.env.CAPTCHA_DEBUG ?? "")) {
  const drop = (): void => {};
  console.log = drop;
  console.info = drop;
  console.warn = drop;
  console.error = drop;
  console.debug = drop;
  console.trace = drop;
  process.stdout.write = (
    _chunk: unknown,
    encodingOrCallback?: unknown,
    maybeCallback?: unknown,
  ): boolean => {
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  };
}

// One import for the worker lifetime. All solve messages share the exact
// module-level caches and concurrency behavior zcode-api has in-process.
const solver = import("./captcha-happy.js");

port.on("message", (request: SolveRequest) => {
  void solver
    .then(({ solveTraceless }) =>
      solveTraceless({ scene: request.scene, region: request.region, prefix: request.prefix }),
    )
    .then((token) => {
      const response: SolveResponse = { id: request.id, ok: true, token };
      port.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: SolveResponse = {
        id: request.id,
        ok: false,
        // Vendored sandbox messages can quote the verify param (upstream is a
        // proxy and logs it freely); scrub before it leaves the worker.
        error: redactCaptchaSecrets(error instanceof Error ? error.message : String(error)),
      };
      port.postMessage(response);
    });
});
