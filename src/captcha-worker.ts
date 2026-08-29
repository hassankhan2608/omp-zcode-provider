/**
 * Captcha solve worker entry.
 *
 * Runs zcode-api's `captcha-happy.ts` solver unmodified, on a worker thread.
 *
 * ## Why a thread is required
 *
 * The solver deliberately tolerates guest rejections: `captcha-happy.ts`
 * registers `process.on("unhandledRejection")` and
 * `process.on("uncaughtException")` once per process (guarded by
 * `process.__capUnhandledRejectionHooked`) so "a single bad pe version must
 * only fail that one solve, not the server". That works upstream because the
 * proxy owns its process and is the sole listener.
 *
 * OMP is not. It registers its own `unhandledRejection` listeners, and Node
 * invokes *every* registered listener — there is no `preventDefault` for
 * process events. So upstream's silent handler cannot stop OMP from printing
 * `[Unhandled Rejection]` and offering `[Recovery]`; the agent still dies
 * mid-turn. Enumerating the missing browser APIs is not an alternative: the
 * FeiLin / `pe` bundles are obfuscated, minified per release, and fetched at
 * solve time, so each build probes different identifiers (`print`,
 * `w[tv]`, ...).
 *
 * A worker thread restores the assumption upstream's code is written against:
 * unhandled rejections here are delivered to this thread, surface to the parent
 * as an `error`/`exit` event, and never reach the main thread's listeners. One
 * bad solve costs one worker, which is exactly the pool's retry unit.
 */
import { parentPort, workerData } from "node:worker_threads";

interface SolveRequest {
  scene: string;
  region: string;
  prefix: string;
}

const port = parentPort;
if (!port) throw new Error("captcha worker started without a parent port");

// happy-dom's virtual console and the guest SDK write raw format strings
// ("%c%d", "NaN", ...) straight to stdout during a solve, which would land in
// the middle of the agent's own output. Silencing `console.*` is not enough
// because the writes bypass it, so stdout itself is sinked: this worker talks
// to the parent over `postMessage` only and has no legitimate stdout duty.
// stderr is left intact so real crashes stay visible, and `CAPTCHA_DEBUG`
// restores upstream's diagnostics when debugging a solve.
if (!/^(1|true|yes)$/i.test(process.env.CAPTCHA_DEBUG ?? "")) {
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

const { scene, region, prefix } = workerData as SolveRequest;

try {
  const { solveTraceless } = await import("./captcha-happy.js");
  const token = await solveTraceless({ scene, region, prefix });
  port.postMessage({ ok: true, token });
} catch (error) {
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
