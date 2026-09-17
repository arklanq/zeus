import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { runHook } from "./hook.ts";
import {
  runInstaller,
  type AgentName,
} from "./installer.ts";

const usage = `Usage: zeus <install|uninstall> [options]

Options:
  --dry-run       Show changes without writing files.
  --skip-claude   Do not change Claude configuration.
  --skip-codex    Do not change Codex configuration.
  -h, --help      Show this help.`;

function fail(message: string): never {
  console.error(message);
  console.error(usage);
  process.exit(1);
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Expected a value after ${option}.`);
  }
  return value;
}

function findPackageDir(): string {
  const candidates = [
    process.env.ZEUS_PACKAGE_DIR,
    resolve(import.meta.dir, ".."),
    import.meta.dir,
    dirname(process.execPath),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const packageDir = candidates.find((candidate) =>
    existsSync(join(candidate, "dist", "claude", "SKILL.md")),
  );
  if (!packageDir) {
    fail("The Zeus SKILL payload is missing. Reinstall Zeus with install.sh.");
  }
  return packageDir;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const command = args.shift();
if (command === "hook") {
  const agent = optionValue(args, "--agent");
  const skillPath = optionValue(args, "--skill");
  if ((agent !== "claude" && agent !== "codex") || !skillPath) {
    fail("Hook execution requires --agent <claude|codex> and --skill <path>.");
  }

  try {
    const output = await runHook(agent, skillPath, await Bun.stdin.text());
    if (output) {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (command !== "install" && command !== "uninstall") {
  fail("Expected install or uninstall.");
}

const supportedFlags = new Set(["--dry-run", "--skip-claude", "--skip-codex"]);
const unknownFlag = args.find((argument) => !supportedFlags.has(argument));
if (unknownFlag) {
  fail(`Unknown option: ${unknownFlag}`);
}

const agents: AgentName[] = [];
if (!args.includes("--skip-claude")) {
  agents.push("claude");
}
if (!args.includes("--skip-codex")) {
  agents.push("codex");
}
if (agents.length === 0) {
  fail("Both agents were skipped.");
}

const homeDir = process.env.HOME;
if (!homeDir) {
  fail("HOME is not set.");
}

try {
  await runInstaller({
    action: command,
    agents,
    dryRun: args.includes("--dry-run"),
    homeDir,
    packageDir: findPackageDir(),
    binarySourcePath: command === "install" ? process.execPath : undefined,
    binaryInstallDir: process.env.ZEUS_BIN_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
