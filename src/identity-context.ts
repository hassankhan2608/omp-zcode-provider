/**
 * Fixed ZCode client identity this provider presents.
 *
 * Values mirror the installed ZCode Desktop build (`/opt/ZCode/resources/
 * app.asar` → `package.json` version `3.10.1`, `homepage
 * https://zcode.z.ai`). `sourceTitle` is `cli`, matching zcode-api's
 * `X-Title: Z Code@cli`. Overridable through the same environment variables
 * zcode-api honors so a different desktop build can be impersonated without
 * touching code.
 */
import os from "node:os";
import { buildIdentityHeaders, type ProxyIdentity } from "./identity.js";

/** Origin of every ZCode plan endpoint. */
export const ZCODE_ORIGIN = "https://zcode.z.ai";

/** Start Plan Anthropic gateway base (zcode-api `STARTPLAN_ANTHROPIC_BASE`). */
export const STARTPLAN_ANTHROPIC_BASE = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic`;

/**
 * Desktop build this provider identifies as.
 *
 * `3.10.1` is the build actually installed here (`/opt/ZCode/resources/
 * app.asar` → `package.json` version). Remote zcode-api pins `3.10.0` in
 * `DEFAULTS.APP_VERSION`; impersonating the version present on this machine is
 * the closer fingerprint, and both values are accepted by the gateway
 * (live-probed 2026-08-29 — neither is the discriminator behind a 3012).
 * `ZCODE_IDENTITY_APP_VERSION` overrides, matching zcode-api's
 * `ZCODE_APP_VERSION`.
 */
export const ZCODE_APP_VERSION = process.env.ZCODE_IDENTITY_APP_VERSION?.trim() || "3.10.1";

/** `anthropic-version` the gateway expects (zcode-api `ANTHROPIC_VERSION`). */
export const ANTHROPIC_VERSION = "2023-06-01";

/** `{platform}-{arch}` used in query strings and `X-Platform`. */
export function zcodePlatform(): string {
  const platform = process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform;
  const arch = process.env.ZCODE_IDENTITY_ARCH ?? os.arch();
  return `${platform}-${arch}`;
}

/**
 * Build the ZCode desktop fingerprint headers for one account.
 *
 * `deviceMid` comes from `account-state.ts`, so each stored account carries
 * its own stable `X-Device-Mid`. Delegates to the verbatim zcode-api
 * `buildIdentityHeaders` for order and conditional semantics.
 */
export function identityHeaders(deviceMid?: string): Record<string, string> {
  const identity: ProxyIdentity = {
    appVersion: ZCODE_APP_VERSION,
    sourceTitle: "cli",
    refererOrigin: ZCODE_ORIGIN,
    ...(deviceMid ? { deviceMid } : {}),
  };
  return buildIdentityHeaders(identity);
}
