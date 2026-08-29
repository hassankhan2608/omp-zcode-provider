/**
 * Per-account isolation: device identity and request health. This is what keeps
 * multiple `/login zcode` accounts from bleeding into each other.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { accountState, deriveDeviceMid, resetAccountState } from "../src/account-state.js";

afterEach(() => {
  resetAccountState();
});

describe("deriveDeviceMid", () => {
  it("is stable for one account across calls", () => {
    expect(deriveDeviceMid("u-1")).toBe(deriveDeviceMid("u-1"));
  });

  it("differs between accounts", () => {
    expect(deriveDeviceMid("u-1")).not.toBe(deriveDeviceMid("u-2"));
  });

  it("is shaped exactly like the client's UUIDv4 deviceMid", () => {
    expect(deriveDeviceMid("u-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("leaks no account material into the header value", () => {
    expect(deriveDeviceMid("secret-account-id")).not.toContain("secret");
  });
});

describe("accountState", () => {
  it("returns the same state object for one account", () => {
    expect(accountState("u-1")).toBe(accountState("u-1"));
  });

  it("gives each account its own device id", () => {
    expect(accountState("u-1").deviceMid).not.toBe(accountState("u-2").deviceMid);
  });

  it("survives a reset with the same derived device id", () => {
    const before = accountState("u-1").deviceMid;
    resetAccountState("u-1");
    expect(accountState("u-1").deviceMid).toBe(before);
  });

  it("keeps captcha health counters per account", () => {
    accountState("u-1").captchaFailures += 1;
    expect(accountState("u-2").captchaFailures).toBe(0);
    expect(accountState("u-1").captchaFailures).toBe(1);
  });

  it("keeps auth failure timestamps per account", () => {
    accountState("u-1").lastAuthFailureAt = 42;
    expect(accountState("u-2").lastAuthFailureAt).toBeUndefined();
  });

  it("drops only the named account on reset", () => {
    accountState("u-1").captchaFailures = 3;
    accountState("u-2").captchaFailures = 5;
    resetAccountState("u-1");
    expect(accountState("u-1").captchaFailures).toBe(0);
    expect(accountState("u-2").captchaFailures).toBe(5);
  });
});
