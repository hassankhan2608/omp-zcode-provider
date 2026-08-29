/**
 * Credential import + paste behavior.
 * Ports the semantics of zcode-api `importFromZCodeConfig` (src/index.ts).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeJwtPayload,
  importFromZCodeConfig,
  parseStartPlanCredential,
  zcodeConfigPath,
} from "../src/credential.js";

/** Mint an unsigned JWT with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.c2ln`;
}

function writeConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("parseStartPlanCredential", () => {
  it("accepts a JWT carrying user_id and records iat", () => {
    const token = jwt({ user_id: "u-1", sub: "u-1", iat: 1787924639 });
    expect(parseStartPlanCredential(token, "zai")).toEqual({
      jwt: token,
      provider: "zai",
      userId: "u-1",
      issuedAt: 1787924639_000,
    });
  });

  it("falls back to sub when user_id is absent", () => {
    expect(parseStartPlanCredential(jwt({ sub: "u-2" }), "bigmodel").userId).toBe("u-2");
  });

  it("carries exp through when the token has one", () => {
    expect(parseStartPlanCredential(jwt({ sub: "u-3", exp: 1900000000 }), "zai").expiresAt).toBe(1900000000_000);
  });

  it("trims surrounding whitespace from a pasted credential", () => {
    const token = jwt({ sub: "u-4" });
    expect(parseStartPlanCredential(`  ${token}\n`, "zai").jwt).toBe(token);
  });

  it("rejects an empty credential", () => {
    expect(() => parseStartPlanCredential("   ", "zai")).toThrow(/empty/);
  });

  it("rejects a non-JWT credential", () => {
    expect(() => parseStartPlanCredential("not-a-jwt", "zai")).toThrow(/not a JWT/);
  });

  it("rejects a JWT without any user identity", () => {
    expect(() => parseStartPlanCredential(jwt({ iat: 1 }), "zai")).toThrow(/user_id/);
  });
});

describe("decodeJwtPayload", () => {
  it("returns null for a token with the wrong number of segments", () => {
    expect(decodeJwtPayload("a.b")).toBeNull();
  });

  it("returns null when the payload is not JSON", () => {
    expect(decodeJwtPayload(`a.${Buffer.from("nope").toString("base64url")}.c`)).toBeNull();
  });
});

describe("importFromZCodeConfig", () => {
  it("reads the start-plan JWT for each provider family", () => {
    const zaiToken = jwt({ user_id: "u-zai" });
    const bigToken = jwt({ user_id: "u-big" });
    const path = writeConfig({
      provider: {
        "builtin:zai-start-plan": { enabled: true, options: { apiKey: zaiToken } },
        "builtin:bigmodel-start-plan": { enabled: false, options: { apiKey: bigToken } },
        "builtin:zai-coding-plan": { enabled: false, options: { apiKey: "coding.key" } },
      },
    });

    const found = importFromZCodeConfig(path);
    expect(found).toHaveLength(2);
    // Enabled entries sort first so `/login zcode` defaults to what the
    // desktop client is actually using.
    expect(found[0]!.credential.provider).toBe("zai");
    expect(found[0]!.enabled).toBe(true);
    expect(found[0]!.credential.jwt).toBe(zaiToken);
    expect(found[1]!.credential.provider).toBe("bigmodel");
    expect(found[1]!.enabled).toBe(false);
  });

  it("ignores coding-plan keys entirely", () => {
    const path = writeConfig({
      provider: { "builtin:zai-coding-plan": { enabled: true, options: { apiKey: "abc.def" } } },
    });
    expect(importFromZCodeConfig(path)).toEqual([]);
  });

  it("skips a malformed entry without hiding a valid one", () => {
    const good = jwt({ user_id: "u-good" });
    const path = writeConfig({
      provider: {
        "builtin:zai-start-plan": { enabled: true, options: { apiKey: "garbage" } },
        "builtin:bigmodel-start-plan": { enabled: true, options: { apiKey: good } },
      },
    });
    const found = importFromZCodeConfig(path);
    expect(found).toHaveLength(1);
    expect(found[0]!.credential.jwt).toBe(good);
  });

  it("returns nothing when the config is missing or unreadable", () => {
    expect(importFromZCodeConfig(join(tmpdir(), "definitely-absent", "config.json"))).toEqual([]);
  });

  it("returns nothing when the config is not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{{{");
    expect(importFromZCodeConfig(path)).toEqual([]);
  });
});

describe("zcodeConfigPath", () => {
  it("points at the installed ZCode v2 configuration", () => {
    expect(zcodeConfigPath("/home/x")).toBe("/home/x/.zcode/v2/config.json");
  });
});
