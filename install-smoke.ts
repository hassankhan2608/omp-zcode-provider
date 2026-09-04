/**
 * Clean-device installation smoke.
 *
 * Uses an isolated HOME so no global plugin, provider checkout, credential, or
 * node_modules tree can make a broken package appear healthy. The target must
 * be an immutable Git ref in CI; callers pass it explicitly.
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

  const models = await runOmp(["models", "zcode", "--json"]);
  if (!models.includes("GLM-5.3")) {
    throw new Error(`installed provider exposed no GLM-5.3 model\n${models}`);
  }
  console.log(`clean install passed: ${target}`);
} finally {
  await rm(home, { recursive: true, force: true });
}
