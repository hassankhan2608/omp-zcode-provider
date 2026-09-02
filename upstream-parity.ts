#!/usr/bin/env bun
/**
 * Upstream parity checker for the files this provider vendors from zcode-api.
 *
 * ## Why this exists
 *
 * The captcha sandbox is the one part of the provider we do NOT want to
 * reimplement. It encodes hard-won knowledge about Alibaba's FeiLin SDK -
 * fingerprint surfaces, timer identity, alias teardown, CDN caching - that only
 * shows up as a `400 {"code":3007}` when it is wrong. So those files are kept
 * as byte copies of upstream, and porting a new upstream commit is a copy, not
 * a merge.
 *
 * The previous workflow was "pull zcode-api, diff by hand, hope you spot it".
 * That does not scale and it is exactly where a silent divergence hides. This
 * script turns the invariant into a command:
 *
 * ```bash
 * bun run parity          # compares against the pinned revision
 * bun run parity --head   # compares against origin/master instead
 * ```
 *
 * ## Why "allowed markers" instead of a diff allowlist
 *
 * Our copies carry a small number of intentional OMP-only lines (see
 * {@link VENDORED_FILES}). A stored diff/hash allowlist would go stale the
 * moment upstream touches an unrelated line in the same file. Instead each
 * intentional line carries a marker string, and any differing line that does
 * not contain a marker is reported. That survives upstream churn and still
 * fails when someone edits a vendored file for a new reason.
 *
 * Line-order and whitespace-only differences are ignored on purpose: they
 * cannot change behaviour, and treating them as drift would make the check
 * noisy enough to be ignored - which is worse than not having it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One intentional difference between our copy and upstream's.
 *
 * `marker` excuses a line we ADD. Dropping an upstream line is only excused
 * when `replaces` names the upstream text being substituted - otherwise a
 * half-applied port would look like parity.
 */
export interface AllowedDivergence {
  /** Substring that appears only on the intentionally-different local line(s). */
  marker: string;
  /** Upstream substring this rule replaces, when the edit is a substitution. */
  replaces?: string;
  /** Why the difference exists. Shown in the report. */
  reason: string;
}

/** A file copied from zcode-api, plus its permitted local edits. */
export interface VendoredFile {
  /** Path inside this extension. */
  local: string;
  /** Path inside the zcode-api checkout. */
  upstream: string;
  allowed: AllowedDivergence[];
}

/**
 * The zcode-api revision our copies are known to match.
 *
 * Bump this in the same commit that ports an upstream change, so the pin and
 * the code always tell the same story.
 */
export const PINNED_UPSTREAM_REF = "5fcb778";

/** Default location of the zcode-api checkout used for comparison. */
export const DEFAULT_UPSTREAM_REPO = `${process.env.HOME ?? ""}/repos/zcode-api`;

export const VENDORED_FILES: VendoredFile[] = [
  {
    local: "src/captcha-happy.ts",
    upstream: "src/proxy/captcha-happy.ts",
    allowed: [
      {
        marker: 'else if (v && typeof v.then === "function") v.then(undefined, () => {});',
        reason:
          "OMP loads pi-ai stream globals into the host realm; some prototype getters return an already-rejected Promise when read without an instance, so the sandbox sweep must claim it before the isolated worker tears down. Written as a single added line to keep this file a line-for-line copy.",
      },
      {
        marker: "// OMP-ONLY:",
        reason: "First line of the comment block explaining the Promise-getter guard above.",
      },
      {
        marker: "// their prototype getters return an already-rejected Promise when",
        reason: "Comment continuation for the OMP-only Promise-getter guard.",
      },
      {
        marker: "// without an instance. Claim it or the isolated captcha worker dies on",
        reason: "Comment continuation for the OMP-only Promise-getter guard.",
      },
      {
        marker: "// an unhandled rejection during teardown. Deliberately one added line",
        reason: "Comment continuation for the OMP-only Promise-getter guard.",
      },
      {
        marker: "// so this file stays a line-for-line copy of upstream (see",
        reason: "Comment continuation pointing maintainers at this parity checker.",
      },
      {
        marker: "// upstream-parity.ts); upstream's own style is kept for the same reason.",
        reason: "Comment continuation explaining why upstream style wins inside vendored files.",
      },
    ],
  },
  {
    local: "src/captcha.ts",
    upstream: "src/proxy/captcha.ts",
    allowed: [
      {
        marker: "./captcha-solver.js",
        reason:
          "OMP runs the solver in a persistent worker thread instead of upstream's in-process solver, so this import points at the OMP worker shim.",
      },
    ],
  },
  {
    local: "src/captcha-pool.ts",
    upstream: "src/proxy/captcha-pool.ts",
    allowed: [
      {
        marker: "let deadlineTimer: NodeJS.Timeout | undefined;",
        reason:
          "Holds the take-deadline timer so it can be cleared and unref'd. Upstream is a long-lived proxy, so a 25s timer left pending after a fast take costs nothing there; OMP also runs as `omp -p`, where it delayed process exit by the full 25s (measured).",
      },
      {
        marker: "deadlineTimer = setTimeout(",
        replaces: "setTimeout(",
        reason: "Same fix: the timer is assigned to the handle instead of being created anonymously.",
      },
      {
        marker: "new Promise<never>((_, rej) => {",
        replaces: "new Promise<never>((_, rej) =>",
        reason: "Same fix: the executor needs a block body to assign the handle and unref it.",
      },
      {
        marker: "deadlineTimer.unref?.();",
        reason: "Same fix: an unref'd deadline timer cannot hold OMP's event loop open.",
      },
      {
        marker: "clearTimeout(deadlineTimer);",
        reason: "Same fix: clears the losing timer as soon as the race settles.",
      },
      {
        marker: "// OMP-ONLY: keep a handle so the loser is cleared",
        reason: "First line of the comment block explaining the take-deadline timer fix.",
      },
      {
        marker: "// runs as `omp -p`, which exits when its work is done, so a 25s timer",
        reason: "Comment continuation for the take-deadline timer fix.",
      },
      {
        marker: "// left pending after a 2ms take delayed process exit by 25s. Upstream is",
        reason: "Comment continuation for the take-deadline timer fix.",
      },
      {
        marker: "// a long-lived proxy and never observes this. See upstream-parity.ts.",
        reason: "Comment continuation for the take-deadline timer fix.",
      },
    ],
  },
  {
    // Upstream's own suite for the vendored pool: it is the regression net for
    // the storm/idle/decay behaviour, so it is copied too. OMP-only pool tests
    // live in tests/captcha-pool-omp.test.ts precisely so this copy stays thin.
    local: "tests/captcha-pool.test.ts",
    upstream: "src/proxy/captcha-pool.test.ts",
    allowed: [
      {
        marker: 'import * as realSolver from "../src/captcha-solver.js";',
        reason:
          "`mock.module` is process-wide, so the solver stand-in must spread the real module or other test files lose its remaining exports.",
      },
      {
        marker: 'mock.module("../src/captcha-solver.js"',
        replaces: 'mock.module("./captcha-solver.js"',
        reason: "Import path differs because OMP keeps tests in tests/ rather than beside the source.",
      },
      { marker: "...realSolver,", reason: "Keeps every real export in the process-wide stand-in." },
      {
        marker: "// `mock.module` is process-wide",
        reason: "First line of the comment explaining the process-wide stand-in.",
      },
      {
        marker: "// test files can still import its remaining exports",
        reason: "Comment continuation for the process-wide stand-in.",
      },
      {
        marker: 'await import("../src/captcha-pool.js")',
        replaces: 'await import("./captcha-pool.js")',
        reason: "Import path differs because OMP keeps tests in tests/.",
      },
    ],
  },
  {
    local: "tests/captcha-token.test.ts",
    upstream: "src/proxy/captcha-token.test.ts",
    allowed: [
      {
        marker: "../src/captcha-token.js",
        replaces: "./captcha-token.js",
        reason: "Import path differs because OMP keeps tests in tests/ rather than beside the source.",
      },
    ],
  },
  {
    local: "tests/captcha-cpu-governor.test.ts",
    upstream: "src/proxy/captcha-cpu-governor.test.ts",
    allowed: [
      {
        marker: "../src/captcha-cpu-governor.js",
        replaces: "./captcha-cpu-governor.js",
        reason: "Import path differs because OMP keeps tests in tests/ rather than beside the source.",
      },
    ],
  },
  { local: "src/captcha-token.ts", upstream: "src/proxy/captcha-token.ts", allowed: [] },
  { local: "src/captcha-cpu-governor.ts", upstream: "src/proxy/captcha-cpu-governor.ts", allowed: [] },
  { local: "src/zcode_system.json", upstream: "src/proxy/zcode_system.json", allowed: [] },
  {
    local: "tests/captcha-happy.test.ts",
    upstream: "src/proxy/captcha-happy.test.ts",
    allowed: [
      {
        marker: "../src/captcha-happy.js",
        replaces: "./captcha-happy.js",
        reason: "Import path differs because OMP keeps tests in tests/ rather than beside the source.",
      },
      {
        marker: "// Real-timer integration exception",
        reason:
          "Explains why the tombstone tests use real timers: the implementation captures the pristine host setTimeout at module load, which Bun fake timers cannot replace.",
      },
      {
        marker: "// setTimeout at module load so aliases cannot poison it",
        reason: "Comment continuation for the real-timer exception.",
      },
      {
        marker: "// cannot replace that closed-over handle",
        reason: "Comment continuation for the real-timer exception.",
      },
      {
        marker: "// tombstone cleanup boundary.",
        reason: "Comment continuation for the real-timer exception.",
      },
    ],
  },
];

export interface DivergenceResult {
  identical: boolean;
  /** Differing lines covered by an allowed marker. */
  explained: string[];
  /** Differing lines nobody has explained: `+` local-only, `-` upstream-only. */
  unexplained: string[];
}

/** Reads a file's contents, or `undefined` when it does not exist. */
export type ContentReader = (path: string) => string | undefined;

export function classifyDivergence(
  localContent: string,
  upstreamContent: string,
  allowed: AllowedDivergence[],
): DivergenceResult {
  if (localContent === upstreamContent) return { identical: true, explained: [], unexplained: [] };

  // Multiset comparison: a line moving elsewhere in the file is not drift, but
  // a line appearing or disappearing is.
  //
  // Two classes of line are normalised away because they cannot change
  // behaviour on their own, and reporting them would bury real findings:
  // blank/indentation-only differences, and lines made purely of block
  // punctuation (`}`, `);`, `try {`) which a restructure shuffles. Any
  // statement that moved with them is still compared.
  const count = (content: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (/^(?:\}?\s*(?:try|else|finally|do)?\s*\{|[)\]};,]+)$/.test(line)) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };

  const localCounts = count(localContent);
  const upstreamCounts = count(upstreamContent);
  const explained: string[] = [];
  const unexplained: string[] = [];

  for (const [line, localTimes] of localCounts) {
    const extra = localTimes - (upstreamCounts.get(line) ?? 0);
    if (extra <= 0) continue;
    if (allowed.some((rule) => line.includes(rule.marker))) explained.push(line);
    else unexplained.push(`+${line}`);
  }

  for (const [line, upstreamTimes] of upstreamCounts) {
    const missing = upstreamTimes - (localCounts.get(line) ?? 0);
    if (missing <= 0) continue;
    // An upstream line we do not have is a finding unless a rule declares it
    // as substituted: markers alone excuse additions, never omissions, so a
    // partial port cannot pass as parity.
    const substituted = allowed.some((rule) => rule.replaces !== undefined && line.includes(rule.replaces));
    if (!substituted) unexplained.push(`-${line}`);
  }

  return { identical: false, explained, unexplained };
}

export interface FileReport extends DivergenceResult {
  local: string;
  upstream: string;
  /** Set when a side could not be read at all. */
  error?: string;
}

export interface ParityReport {
  ok: boolean;
  files: FileReport[];
}

export function parityReport(
  entries: VendoredFile[],
  readLocal: ContentReader,
  readUpstream: ContentReader,
): ParityReport {
  const files: FileReport[] = entries.map((entry) => {
    const localContent = readLocal(entry.local);
    const upstreamContent = readUpstream(entry.upstream);
    if (localContent === undefined || upstreamContent === undefined) {
      const which = localContent === undefined ? "missing locally" : "missing upstream";
      return {
        local: entry.local,
        upstream: entry.upstream,
        identical: false,
        explained: [],
        unexplained: [],
        error: `${entry.local}: ${which}`,
      };
    }
    return {
      local: entry.local,
      upstream: entry.upstream,
      ...classifyDivergence(localContent, upstreamContent, entry.allowed),
    };
  });

  return { ok: files.every((file) => file.error === undefined && file.unexplained.length === 0), files };
}

/** CLI entry: compare the working tree against a zcode-api revision. */
function main(): void {
  const args = process.argv.slice(2);
  const repo = process.env.ZCODE_API_REPO ?? DEFAULT_UPSTREAM_REPO;
  const ref = args.includes("--head") ? "origin/master" : PINNED_UPSTREAM_REF;
  const extensionRoot = import.meta.dirname;

  const git = (...gitArgs: string[]): string | undefined => {
    const run = spawnSync("git", ["-C", repo, ...gitArgs], { encoding: "utf-8" });
    return run.status === 0 ? run.stdout : undefined;
  };

  const describe = git("describe", "--tags", ref)?.trim();
  const head = git("rev-parse", "--short", "origin/master")?.trim();
  if (head === undefined) {
    console.error(`Cannot read zcode-api at ${repo}. Clone it or set ZCODE_API_REPO.`);
    process.exit(2);
  }

  const report = parityReport(
    VENDORED_FILES,
    (path) => {
      try {
        return readFileSync(resolve(extensionRoot, path), "utf-8");
      } catch {
        return undefined;
      }
    },
    (path) => git("show", `${ref}:${path}`),
  );

  console.log(`zcode-api ${repo}`);
  console.log(`  comparing against: ${ref}${describe ? ` (${describe})` : ""}`);
  console.log(`  origin/master:     ${head}${head.startsWith(PINNED_UPSTREAM_REF) ? " (pinned)" : " — newer than pin, review it"}`);
  console.log("");

  for (const file of report.files) {
    if (file.error) {
      console.log(`  ✗ ${file.error}`);
      continue;
    }
    const suffix = file.explained.length > 0 ? ` (${file.explained.length} allowed OMP line(s))` : "";
    if (file.unexplained.length === 0) {
      console.log(`  ✓ ${file.local}${file.identical ? "" : suffix}`);
      continue;
    }
    console.log(`  ✗ ${file.local}${suffix}`);
    for (const line of file.unexplained.slice(0, 20)) console.log(`      ${line}`);
    if (file.unexplained.length > 20) console.log(`      … ${file.unexplained.length - 20} more`);
  }

  console.log("");
  console.log(report.ok ? "Parity OK." : "Parity FAILED: unexplained divergence above.");
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.main) main();
