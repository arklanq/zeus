import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { cancel, intro, isCancel, log, outro, select, spinner } from "@clack/prompts";

import { runHook } from "./hook.ts";
import {
  runInstaller,
  type AgentName,
} from "./installer.ts";
import {
  ClaudeModelCatalogProvider,
  CodexModelCatalogProvider,
  defaultCodexRuntimeEnvironment,
  findCodexRuntime,
} from "./model-catalog.ts";
import {
  describeWorkerSettings,
  readZeusConfig,
  resolveWorkerSettings,
  zeusConfigPath,
  type CatalogSource,
  type Prompter,
  type WorkerSettingsByAgent,
} from "./worker-settings.ts";

const usage = `Usage: zeus <install|uninstall> [options]

Options:
  --dry-run                        Show changes without writing files.
  --skip-claude                    Do not change Claude configuration.
  --skip-codex                     Do not change Codex configuration.
  --claude-worker-model <id>       Claude worker model; skips the wizard for Claude.
  --claude-worker-effort <level>   Claude worker effort (defaults to the model default).
  --codex-worker-model <id>        Codex worker model; skips the wizard for Codex.
  --codex-worker-effort <level>    Codex worker effort (defaults to the model default).
  -h, --help                       Show this help.

In a terminal, install asks which model and effort worker sessions use for each
agent. Without a terminal, it reuses the choice saved in ~/.zeus/config.json.`;

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
const workerOptions = [
  "--claude-worker-model",
  "--claude-worker-effort",
  "--codex-worker-model",
  "--codex-worker-effort",
];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (workerOptions.includes(argument)) {
    if (command !== "install") {
      fail(`${argument} is only supported by install.`);
    }
    optionValue(args.slice(index), argument);
    index += 1;
  } else if (!supportedFlags.has(argument)) {
    fail(`Unknown option: ${argument}`);
  }
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

const workerFlags = {
  claude: {
    model: optionValue(args, "--claude-worker-model"),
    effort: optionValue(args, "--claude-worker-effort"),
  },
  codex: {
    model: optionValue(args, "--codex-worker-model"),
    effort: optionValue(args, "--codex-worker-effort"),
  },
};
for (const agent of ["claude", "codex"] as const) {
  const flags = workerFlags[agent];
  if (!agents.includes(agent) && (flags.model || flags.effort)) {
    fail(`--${agent}-worker-* options cannot be combined with --skip-${agent}.`);
  }
}

const terminalPrompter: Prompter = {
  select: async (message, options, initialValue) => {
    const value = await select({ message, options, initialValue });
    if (isCancel(value)) {
      cancel("Installation cancelled.");
      process.exit(130);
    }
    return value;
  },
  progress: async (message, work) => {
    const indicator = spinner();
    indicator.start(message);
    try {
      const result = await work();
      indicator.stop(message);
      return result;
    } catch (error) {
      indicator.error(message);
      throw error;
    }
  },
  print: (line) => log.info(line),
};

function catalogSource(agent: AgentName): CatalogSource {
  if (agent === "claude") {
    return { provider: new ClaudeModelCatalogProvider() };
  }
  const runtime = findCodexRuntime(defaultCodexRuntimeEnvironment(homeDir!));
  return runtime
    ? { provider: new CodexModelCatalogProvider(runtime) }
    : { unavailableReason: "the Codex runtime was not found in PATH or in a Codex/ChatGPT app bundle" };
}

try {
  let workerSettings: WorkerSettingsByAgent | undefined;
  if (command === "install") {
    const prompter = process.stdin.isTTY ? terminalPrompter : undefined;
    if (prompter) {
      intro("Zeus worker settings");
    }
    const resolved = await resolveWorkerSettings({
      agents,
      flags: workerFlags,
      saved: (await readZeusConfig(zeusConfigPath(homeDir)))?.workers ?? {},
      prompter,
      catalogSource,
      log: console.log,
    });
    workerSettings = resolved;
    if (prompter) {
      outro(
        agents.map((agent) => `${agent}: ${describeWorkerSettings(resolved[agent])}`).join(", "),
      );
    }
  }

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
    workerSettings,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
