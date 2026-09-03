/**
 * Captcha error redaction.
 *
 * Upstream's sandbox is a proxy that logs freely; some of its failure messages
 * quote the captcha payload itself, e.g. `captcha-happy.ts` refusing a
 * degraded result includes the first 80 characters of the verify param. A
 * verify param is single-use but it is still a request credential, and the
 * same is true of cookies and the account JWT.
 *
 * Those messages cross from the isolated worker into OMP's file logger and can
 * end up in a pasted bug report, so the worker scrubs them at the boundary
 * rather than us editing the vendored sandbox.
 */
import { describe, expect, it } from "bun:test";
import { redactCaptchaSecrets } from "../src/captcha-redact.js";

const VERIFY_PARAM =
  "eyJjZXJ0aWZ5SWQiOiJhYmNkZWZnaGlqa2xtbm9wIiwic2NlbmUiOiIxMXh5Z3R2ZCIsInRva2VuIjoiWFlaMTIzNDU2Nzg5MCJ9";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiYWJjIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";

describe("redactCaptchaSecrets", () => {
  it("keeps a plain diagnostic untouched", () => {
    expect(redactCaptchaSecrets("captcha solve stall pe=pe.099.storm.js")).toBe(
      "captcha solve stall pe=pe.099.storm.js",
    );
  });

  it("removes a quoted verify param but keeps the reason and its length", () => {
    const message = `verify param too short (31 chars) — degraded result, refusing: ${VERIFY_PARAM}`;
    const redacted = redactCaptchaSecrets(message);

    expect(redacted).toContain("verify param too short (31 chars)");
    expect(redacted).toContain("degraded result, refusing");
    expect(redacted).not.toContain(VERIFY_PARAM);
    expect(redacted).toContain("[redacted 100 chars]");
  });

  it("removes a JWT anywhere in the message", () => {
    expect(redactCaptchaSecrets(`upstream rejected token ${JWT} for account`)).not.toContain("c2lnbmF0dXJl");
  });

  it("removes cookie material", () => {
    const redacted = redactCaptchaSecrets("set-cookie: acw_tc=abcdef0123456789abcdef0123456789; path=/");
    expect(redacted).not.toContain("abcdef0123456789abcdef0123456789");
    expect(redacted).toContain("set-cookie");
  });

  it("keeps short technical tokens that carry no secret", () => {
    // Scene ids, pe bundle names and biz codes are how a failure is diagnosed.
    const message = "captcha config unavailable (scene 11xygtvd, region sgp, code 3007)";
    expect(redactCaptchaSecrets(message)).toBe(message);
  });

  it("redacts every occurrence, not just the first", () => {
    const redacted = redactCaptchaSecrets(`first ${VERIFY_PARAM} second ${VERIFY_PARAM}`);
    expect(redacted).not.toContain(VERIFY_PARAM);
    expect([...redacted.matchAll(/\[redacted \d+ chars\]/g)]).toHaveLength(2);
  });

  it("passes through an empty or absent message safely", () => {
    expect(redactCaptchaSecrets("")).toBe("");
    expect(redactCaptchaSecrets(undefined)).toBe("");
  });
});
