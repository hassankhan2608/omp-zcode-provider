/**
 * Scrub captcha payloads out of error text at the worker boundary.
 *
 * ## Why here and not in the sandbox
 *
 * `captcha-happy.ts` is a byte copy of zcode-api (see `upstream-parity.ts`).
 * Upstream runs it inside a proxy where quoting the payload in a failure
 * message is harmless, so several of its errors embed captcha material - the
 * clearest case being its refusal of a degraded result, which appends the
 * first 80 characters of the verify param.
 *
 * In OMP those messages leave the isolated worker, reach `pi.logger`, and can
 * be pasted into a bug report. Redacting them as they cross `postMessage`
 * keeps the vendored sandbox byte-identical while making sure no credential
 * material leaves the worker.
 *
 * ## What counts as a secret
 *
 * A verify param is a base64 blob, the account credential is a JWT, and
 * cookies are opaque hex. All three are long, high-entropy, and useless for
 * diagnosis. What *is* useful - the reason, the length, scene ids, `pe` bundle
 * names, biz codes such as 3007 - is short and stays intact. So the rule is
 * "replace long opaque runs, keep everything else", which fails safe: a new
 * upstream message that quotes a payload is redacted without us noticing it.
 */

/** Minimum run length treated as opaque material rather than a diagnostic. */
const OPAQUE_MIN_LENGTH = 24;

/**
 * Long base64url/hex runs, optionally dotted (JWT). Kept deliberately broad:
 * anything of this shape is a token, signature, cookie value, or verify param.
 */
const OPAQUE_RUN = new RegExp(`[A-Za-z0-9_+/=-]{${OPAQUE_MIN_LENGTH},}(?:\\.[A-Za-z0-9_+/=-]+)*`, "g");

export function redactCaptchaSecrets(message: string | undefined): string {
  if (!message) return "";
  return message.replace(OPAQUE_RUN, (match) => `[redacted ${match.length} chars]`);
}
