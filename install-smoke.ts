/**
 * Clean-device installation smoke.
 *
 * Uses an isolated HOME so no global plugin, provider checkout, credential, or
 * node_modules tree can make a broken package appear healthy. The target must
 * be an immutable Git ref in CI; callers pass it explicitly.
 *
 * What this asserts, and why it stops where it does: `omp install` is the step
 * that resolves dependencies in the plugin store and imports every declared
 * extension entry, rolling back on failure. That import is the exact surface
 * that caught the two real packaging defects - a missing `happy-dom` and an
 * optional-peer `@oh-my-pi/pi-catalog` that Bun never materialized.
 *
 * Model discovery is deliberately NOT asserted here: `omp models` only lists a
 * provider once a credential for it exists, so in a credential-free HOME even
 * built-in `anthropic` returns an empty list. ZCode is OAuth-only, so no
 * secretless environment can enumerate its catalog. Model discovery is
 * verified on a real workstation instead, where accounts are already stored.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: bun run install-smoke.ts TARGET");

const home = await mkdtemp(join(tmpdir(), "omp-zcode-install-"));
const environment = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
};

async function runOmp(args: string[]): Promise<string> {
  const processHandle = Bun.spawn(["omp", ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`omp ${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
  }
  return stdout;
}

try {
  await runOmp(["install", target, "--json"]);
  const plugins = await runOmp(["plugin", "list", "--json"]);
  if (!plugins.includes("omp-zcode-provider")) {
    throw new Error(`plugin inventory did not identify omp-zcode-provider\n${plugins}`);
  }

  const doctor = await runOmp(["plugin", "doctor", "--json"]);
  if (!doctor.includes("plugin:omp-zcode-provider")) {
    throw new Error(`plugin doctor did not report the installed provider\n${doctor}`);
  }
  if (doctor.includes('"status": "error"')) {
    throw new Error(`plugin doctor reported a fault\n${doctor}`);
  }
  console.log(`clean install passed: ${target}`);
} finally {
  await rm(home, { recursive: true, force: true });
}
