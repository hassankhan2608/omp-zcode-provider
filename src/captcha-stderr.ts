/**
 * Sandbox stderr capture.
 *
 * `captcha-happy.ts` is vendored verbatim from zcode-api, where it runs inside
 * a long-lived proxy daemon and writes diagnostics straight to
 * `process.stderr` - `[captcha-guest-uncaught] …` when a rotated guest bundle
 * throws, plus the `[guest-*]` channels under `CAPTCHA_DEBUG`. For a daemon
 * that is journald's problem.
 *
 * OMP runs that module in a worker thread, and a worker thread shares the
 * agent process's stderr file descriptor. Those writes therefore paint over
 * the TUI mid-frame, which is exactly what a solve-time guest error did:
 * `[captcha-guest-uncaught] window is not defined` repeated across the
 * composer and status line.
 *
 * Silencing the stream outright would also throw away the only signal that a
 * pe bundle rotated into something broken, so the write is redirected into a
 * sink the parent turns into `pi.logger.debug` instead. Redirecting rather
 * than editing the vendored file keeps `bun run parity` byte-exact.
 */
import { redactCaptchaSecrets } from "./captcha-redact.js";

/** The slice of `process.stderr` this module replaces. */
export interface WritableStreamLike {
  write(chunk: unknown, encodingOrCallback?: unknown, maybeCallback?: unknown): boolean;
}

/**
 * Route `stream.write` into `sink`, returning a restore function.
 *
 * Always reports the write as accepted and always runs the completion
 * callback: the caller is vendored sandbox code mid-solve, and back-pressure
 * or an exception from a diagnostic write would fail a mint that is otherwise
 * fine. A throwing sink is swallowed for the same reason.
 */
export function redirectStderr(stream: WritableStreamLike, sink: (line: string) => void): () => void {
  const original = stream.write.bind(stream);

  stream.write = (chunk: unknown, encodingOrCallback?: unknown, maybeCallback?: unknown): boolean => {
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      const trimmed = text.replace(/\n+$/, "");
      if (trimmed.length > 0) sink(redactCaptchaSecrets(trimmed));
    } catch {
      // A diagnostic must never break the solve that produced it.
    }
    if (typeof callback === "function") (callback as () => void)();
    return true;
  };

  return () => {
    stream.write = original;
  };
}
