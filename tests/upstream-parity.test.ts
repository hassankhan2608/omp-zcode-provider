/**
 * Upstream parity checker.
 *
 * A few provider files are deliberately byte-copies of zcode-api (the captcha
 * sandbox and its pool/token helpers). Keeping them identical is what makes an
 * upstream sync a copy instead of a merge, so drift has to be detectable
 * without a human diffing files by hand.
 *
 * These tests cover the pure classification logic; the CLI wrapper only feeds
 * it file contents and the pinned upstream revision.
 */
import { describe, expect, it } from "bun:test";
import { classifyDivergence, parityReport, VENDORED_FILES, type VendoredFile } from "../upstream-parity.js";

const ENTRY: VendoredFile = {
  local: "src/demo.ts",
  upstream: "src/proxy/demo.ts",
  allowed: [{ marker: "OMP-ONLY", reason: "OMP boundary guard" }],
};

describe("classifyDivergence", () => {
  it("reports identical files as in parity", () => {
    const result = classifyDivergence("a\nb\n", "a\nb\n", ENTRY.allowed);
    expect(result.identical).toBe(true);
    expect(result.unexplained).toEqual([]);
  });

  it("accepts differing lines that carry an allowed marker", () => {
    const result = classifyDivergence("a\nkeep(); // OMP-ONLY\n", "a\n", ENTRY.allowed);
    expect(result.identical).toBe(false);
    expect(result.explained).toEqual(["keep(); // OMP-ONLY"]);
    expect(result.unexplained).toEqual([]);
  });

  it("flags a local line that no marker explains", () => {
    const result = classifyDivergence("a\nsneaky();\n", "a\n", ENTRY.allowed);
    expect(result.unexplained).toEqual(["+sneaky();"]);
  });

  it("flags an upstream line we dropped, so ports are never partial", () => {
    const result = classifyDivergence("a\n", "a\nupstreamFix();\n", ENTRY.allowed);
    expect(result.unexplained).toEqual(["-upstreamFix();"]);
  });

  it("excuses a dropped upstream line only when a rule declares the substitution", () => {
    const substitution = [
      {
        marker: "../src/thing.js",
        replaces: "./thing.js",
        reason: "Import path differs because OMP keeps tests in a separate directory.",
      },
    ];
    const result = classifyDivergence('import x from "../src/thing.js";\n', 'import x from "./thing.js";\n', substitution);
    expect(result.unexplained).toEqual([]);
    expect(result.explained).toEqual(['import x from "../src/thing.js";']);
  });

  it("ignores line-order and whitespace-only noise, since neither changes behaviour", () => {
    const result = classifyDivergence("a\n\n  b\n", "a\nb\n", ENTRY.allowed);
    expect(result.unexplained).toEqual([]);
  });
});

describe("parityReport", () => {
  const read = (contents: Record<string, string>) => (path: string) => contents[path];

  it("passes when every vendored file matches except allowed markers", () => {
    const report = parityReport(
      [ENTRY],
      read({ "src/demo.ts": "a\nguard(); // OMP-ONLY\n" }),
      read({ "src/proxy/demo.ts": "a\n" }),
    );
    expect(report.ok).toBe(true);
    expect(report.files[0]!.explained).toHaveLength(1);
  });

  it("fails and names the file when an unexplained difference appears", () => {
    const report = parityReport([ENTRY], read({ "src/demo.ts": "a\nb\n" }), read({ "src/proxy/demo.ts": "a\n" }));
    expect(report.ok).toBe(false);
    expect(report.files[0]!.local).toBe("src/demo.ts");
    expect(report.files[0]!.unexplained).toEqual(["+b"]);
  });

  it("fails loudly when a vendored file is missing on either side", () => {
    const missingLocal = parityReport([ENTRY], read({}), read({ "src/proxy/demo.ts": "a\n" }));
    expect(missingLocal.ok).toBe(false);
    expect(missingLocal.files[0]!.error).toContain("missing locally");

    const missingUpstream = parityReport([ENTRY], read({ "src/demo.ts": "a\n" }), read({}));
    expect(missingUpstream.ok).toBe(false);
    expect(missingUpstream.files[0]!.error).toContain("missing upstream");
  });
});

describe("VENDORED_FILES manifest", () => {
  it("covers every file we copy from zcode-api", () => {
    expect(VENDORED_FILES.map((entry) => entry.local).sort()).toEqual([
      "src/captcha-cpu-governor.ts",
      "src/captcha-happy.ts",
      "src/captcha-pool.ts",
      "src/captcha-token.ts",
      "src/captcha.ts",
      "src/zcode_system.json",
      "tests/captcha-happy.test.ts",
    ]);
  });

  it("documents a reason for every allowed divergence, so nothing is silently excused", () => {
    for (const entry of VENDORED_FILES) {
      for (const allowed of entry.allowed) {
        expect(allowed.marker.length).toBeGreaterThan(0);
        expect(allowed.reason.length).toBeGreaterThan(10);
      }
    }
  });
});
