/**
 * ZCode Start Plan credential handling.
 *
 * A Start Plan credential is exactly one thing: the ZCode plan JWT that the
 * desktop client stores under `provider["builtin:{provider}-start-plan"]
 * .options.apiKey` and sends to the gateway as `Authorization: Bearer {jwt}`.
 * Ported from zcode-api `src/index.ts` `importFromZCodeConfig` and
 * `src/auth/types.ts`.
 *
 * The JWT payload carries `user_id`/`sub`, which is the stable account
 * identity. OMP keys stored credentials on `accountId`, so decoding it here is
 * what makes "add a new account vs. update the matching one" work without any
 * duplicate rows: a re-login for the same ZCode user resolves to the same
 * `accountId` and OMP updates that credential in place.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Provider families ZCode fronts. Start Plan is offered on both. */
export type ZCodeProviderId = "zai" | "bigmodel";

export const ZCODE_PROVIDER_IDS: readonly ZCodeProviderId[] = ["zai", "bigmodel"];

/** A validated ZCode Start Plan credential. */
export interface StartPlanCredential {
  /** ZCode plan JWT — the gateway bearer token. */
  jwt: string;
  /** Upstream provider family the plan is attached to. */
  provider: ZCodeProviderId;
  /** `user_id` (or `sub`) from the JWT payload. Stable account identity. */
  userId: string;
  /** `iat` from the JWT payload, in epoch ms, when present. */
  issuedAt?: number;
  /** `exp` from the JWT payload, in epoch ms, when present. */
  expiresAt?: number;
  /**
   * Account email, when the login response carried one.
   *
   * Never available from a plan JWT or from the installed ZCode config: the
   * token payload holds only `user_id`/`sub`/`iat`, and zcode-api's login
   * responses expose `user: { user_id }` and nothing else (verified against
   * remote master). Captured opportunistically from the browser flow so OMP's
   * account list can show it if the gateway ever starts returning one; until
   * then the `user_id` UUID is the only identity ZCode issues.
   */
  email?: string;
}

/** Decoded JWT payload fields this provider relies on. */
interface JwtPayload {
  user_id?: unknown;
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
}

/** Path of the installed ZCode desktop configuration. */
export function zcodeConfigPath(home: string = homedir()): string {
  return join(home, ".zcode", "v2", "config.json");
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * The signature is the gateway's business; we only need the account identity
 * it asserts. Returns `null` for anything that is not a three-part JWT with a
 * base64url JSON payload.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Seconds-since-epoch JWT claim → epoch ms. */
function epochSecondsToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value * 1000) : undefined;
}

/**
 * Validate a pasted or imported Start Plan JWT into a credential.
 *
 * Throws on anything the gateway would reject outright: a non-JWT string, or a
 * JWT with no user identity. A missing `exp` is normal — ZCode plan tokens are
 * long-lived and carry only `iat`. `email` is only ever supplied by the browser
 * login flow; the JWT itself never carries one.
 */
export function parseStartPlanCredential(
  raw: string,
  provider: ZCodeProviderId,
  email?: string,
): StartPlanCredential {
  const jwt = raw.trim();
  if (jwt.length === 0) {
    throw new Error("ZCode Start Plan credential is empty");
  }
  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    throw new Error("ZCode Start Plan credential is not a JWT");
  }
  const userId = stringField(payload.user_id) ?? stringField(payload.sub);
  if (!userId) {
    throw new Error("ZCode Start Plan credential has no user_id");
  }
  return {
    jwt,
    provider,
    userId,
    ...(epochSecondsToMs(payload.iat) !== undefined ? { issuedAt: epochSecondsToMs(payload.iat) } : {}),
    ...(epochSecondsToMs(payload.exp) !== undefined ? { expiresAt: epochSecondsToMs(payload.exp) } : {}),
    ...(stringField(email) ? { email: stringField(email) } : {}),
  };
}

/** Result of scanning the installed ZCode configuration. */
export interface ImportedCredential {
  credential: StartPlanCredential;
  /** True when the desktop client has this provider's Start Plan entry enabled. */
  enabled: boolean;
}

/**
 * Read every Start Plan credential present in the installed ZCode config.
 *
 * Equivalent to `bun run src/index.ts auth login zai --import`, generalized
 * over both provider families so a single `/login zcode` can offer whatever
 * the desktop client actually holds. Enabled entries sort first; entries
 * without a decodable JWT are skipped rather than failing the whole import.
 */
/**
 * The slice of ZCode's `config.json` this importer reads. Values stay `unknown`
 * because a hand-edited config can hold anything; each one is validated below.
 */
interface ZCodeConfigFile {
  provider?: Record<string, { options?: { apiKey?: unknown }; enabled?: unknown } | undefined>;
}

export function importFromZCodeConfig(configPath: string = zcodeConfigPath()): ImportedCredential[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }

  // Boundary assert against the named shape above: `JSON.parse` is `any`, and
  // every field this function goes on to read is validated (`stringField`,
  // `=== true`), so nothing unchecked escapes.
  let parsed: ZCodeConfigFile;
  try {
    parsed = JSON.parse(raw) as ZCodeConfigFile;
  } catch {
    return [];
  }

  const found: ImportedCredential[] = [];
  for (const provider of ZCODE_PROVIDER_IDS) {
    const entry = parsed.provider?.[`builtin:${provider}-start-plan`];
    const apiKey = stringField(entry?.options?.apiKey);
    if (!apiKey) continue;
    try {
      found.push({ credential: parseStartPlanCredential(apiKey, provider), enabled: entry?.enabled === true });
    } catch {
      // A malformed entry for one provider must not hide a valid one.
    }
  }
  return found.sort((a, b) => Number(b.enabled) - Number(a.enabled));
}
