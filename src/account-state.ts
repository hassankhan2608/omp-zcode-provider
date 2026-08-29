/**
 * Per-account runtime state: device identity and request health.
 *
 * Everything here is keyed on the ZCode `userId` that `credential.ts` decodes
 * out of the plan JWT, so two logged-in accounts never share a device
 * fingerprint or a health counter.
 *
 * `X-Device-Mid` is *derived* rather than randomly minted. zcode-api persists a
 * random UUIDv4 in its own YAML; OMP's credential rows have no free-form field
 * to persist one in, and a per-process random value would violate ZCode's
 * "random once, reused forever" telemetry contract by changing on every
 * restart. A deterministic UUIDv4-shaped digest of the account id is stable
 * across restarts, unique per account, and carries no hardware value.
 *
 * Two things deliberately do NOT live here, because they do not exist on
 * zcode-api's Start Plan request path either:
 *   - **Cookies.** The gateway is sent no cookie jar. Cookies exist only inside
 *     the captcha solver's own browser context, which primes
 *     `https://zcode.z.ai/` per solve (`captcha-happy.ts`, ported verbatim).
 *   - **Upstream session ids.** zcode-api's `buildTraceHeaders` emits
 *     `x-query-id`/`x-session-id` only when `plan !== "start-plan"`. Start Plan
 *     affinity is carried by `x-zcode-session-type: main` plus the per-account
 *     device id, and nothing else.
 */
import { createHash } from "node:crypto";

/** Mutable per-account runtime state. */
export interface AccountState {
  /** ZCode `user_id` this state belongs to. */
  readonly accountId: string;
  /** Stable `X-Device-Mid` for this account. */
  readonly deviceMid: string;
  /** Epoch ms of the last captcha rejection the gateway issued to this account. */
  lastCaptchaFailureAt?: number;
  /** Consecutive gateway captcha rejections; reset on any accepted request. */
  captchaFailures: number;
  /** Epoch ms of the last upstream 401 on this account. */
  lastAuthFailureAt?: number;
}

const states = new Map<string, AccountState>();

/**
 * Derive the stable per-account device id.
 *
 * SHA-256 of a namespaced account key, formatted as a UUIDv4 so it is
 * indistinguishable from the client's own `crypto.randomUUID()` deviceMid at
 * the fingerprinting layer (version nibble `4`, variant bits `10`).
 */
export function deriveDeviceMid(accountId: string): string {
  const digest = createHash("sha256").update(`zcode-device-mid:${accountId}`, "utf-8").digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Get (creating on first use) the runtime state for one account. */
export function accountState(accountId: string): AccountState {
  const existing = states.get(accountId);
  if (existing) return existing;
  const created: AccountState = {
    accountId,
    deviceMid: deriveDeviceMid(accountId),
    captchaFailures: 0,
  };
  states.set(accountId, created);
  return created;
}

/** Drop one account's runtime state (logout), or all of it (tests). */
export function resetAccountState(accountId?: string): void {
  if (accountId === undefined) {
    states.clear();
    return;
  }
  states.delete(accountId);
}
