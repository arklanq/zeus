import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
} from "@clack/prompts";

import { AGENT_NAMES, describeDetection, detectAgents } from "./detect.ts";
import { runHook } from "./hook.ts";
import {
  applyInstallerPlan,
  describeOperation,
  installations,
  installedAgents,
  planInstaller,
  type AgentName,
  type InstallerPlan,
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
} from "./worker-settings.ts";
import { DEVELOPMENT_VERSION, ZEUS_VERSION } from "./version.ts";

const usage = `Usage: zeus <command> [options]

Commands:
  install       Install the Zeus SKILL and hook for the chosen agents.
  uninstall     Remove only files and configuration entries owned by Zeus.
  status        Show detected agents and what is installed.

Options:
  --dry-run                        Show changes without writing files.
  --yes, --non-interactive         Do not ask; use flags, saved answers, then defaults.
  --skip-claude                    Do not change Claude configuration.
  --skip-codex                     Do not change Codex configuration.
  --claude-worker-model <id>       Claude worker model; skips the wizard for Claude.
  --claude-worker-effort <level>   Claude worker effort (defaults to the model default).
  --codex-worker-model <id>        Codex worker model; skips the wizard for Codex.
  --codex-worker-effort <level>    Codex worker effort (defaults to the model default).
  -h, --help                       Show this help.

In a terminal, install asks which detected agents to configure and which model and
effort worker sessions use for each. Without a terminal or with --yes, it configures
every detected agent and reuses the choice saved in ~/.zeus/config.json.`;

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

if (command !== "install" && command !== "uninstall" && command !== "status") {
  fail("Expected install, uninstall or status.");
}

const supportedFlags = new Set([
  "--dry-run",
  "--yes",
  "--non-interactive",
  "--skip-claude",
  "--skip-codex",
]);
const workerOptions = [
  "--claude-worker-model",
  "--claude-worker-effort",
  "--codex-worker-model",
  "--codex-worker-effort",
];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (command === "status") {
    fail(`status does not take options: ${argument}`);
  }
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

const skipped = new Set<AgentName>();
if (args.includes("--skip-claude")) {
  skipped.add("claude");
}
if (args.includes("--skip-codex")) {
  skipped.add("codex");
}
if (skipped.size === 2) {
  fail("Both agents were skipped.");
}

const homeDir = process.env.HOME;
if (!homeDir) {
  fail("HOME is not set.");
}

const dryRun = args.includes("--dry-run");
const interactive =
  !args.includes("--yes") && !args.includes("--non-interactive") && process.stdin.isTTY === true;
const locations = {
  homeDir,
  binaryInstallDir: process.env.ZEUS_BIN_DIR,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  codexHome: process.env.CODEX_HOME,
};
const binDir = resolve(locations.binaryInstallDir ?? join(homeDir, ".local", "bin"));

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
for (const agent of skipped) {
  const flags = workerFlags[agent];
  if (flags.model || flags.effort) {
    fail(`--${agent}-worker-* options cannot be combined with --skip-${agent}.`);
  }
}

function exitIfCancelled<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("Nothing was changed.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

const terminalPrompter: Prompter = {
  select: async (message, options, initialValue) =>
    exitIfCancelled(await select({ message, options, initialValue })),
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

function isInPath(directory: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry.replace(/^~(?=\/|$)/, homeDir!)) === directory);
}

/** Tells the user how to put the install directory in PATH; the hooks call the executable by full path either way. */
function pathWarning(): string | undefined {
  if (isInPath(binDir)) {
    return undefined;
  }
  const shown = binDir.startsWith(`${homeDir}/`) ? `$HOME${binDir.slice(homeDir!.length)}` : binDir;
  const shell = basename(process.env.SHELL ?? "");
  const profile = shell === "bash" ? "~/.bashrc" : shell === "zsh" ? "~/.zshrc" : "<your shell profile>";
  const addCommand =
    shell === "fish" ? `fish_add_path ${shown}` : `echo 'export PATH="${shown}:$PATH"' >> ${profile}`;
  return `${binDir} is not in PATH, so zeus cannot be run by name. The hooks work without it. Add it with:\n  ${addCommand}\nthen open a new terminal.`;
}

function uninstallCommand(): string {
  return isInPath(binDir) ? "zeus uninstall" : `${join(binDir, "zeus")} uninstall`;
}

function changes(plan: InstallerPlan): string[] {
  return plan.operations.map((operation) => operation.description);
}

function printPlan(plan: InstallerPlan): void {
  if (plan.operations.length === 0) {
    console.log("Nothing to change.");
  } else if (dryRun) {
    plan.operations.forEach((operation) => console.log(`Would: ${describeOperation(operation, true)}`));
  } else {
    console.log(["Changes:", ...changes(plan).map((line) => `- ${line}`)].join("\n"));
  }
}

/** Shows the plan, asks for confirmation in a terminal and applies it unless this is a dry run. */
async function confirmAndApply(plan: InstallerPlan, question: string): Promise<boolean> {
  if (dryRun || !interactive) {
    printPlan(plan);
    if (!dryRun) {
      await applyInstallerPlan(plan);
    }
    return !dryRun;
  }

  note(changes(plan).map((line) => `• ${line}`).join("\n") || "Nothing to change.", "Changes");
  if (plan.operations.length === 0) {
    return true;
  }
  if (!exitIfCancelled(await confirm({ message: question, initialValue: true }))) {
    cancel("Nothing was changed.");
    process.exit(1);
  }
  const progress = spinner();
  progress.start("Applying changes");
  await applyInstallerPlan(plan);
  progress.stop("Changes applied");
  return true;
}

function report(lines: string[], level: "info" | "warn" = "info"): void {
  for (const line of lines) {
    if (interactive && !dryRun) {
      log[level](line);
    } else {
      console.log(`${level === "warn" ? "Warning" : "Note"}: ${line}`);
    }
  }
}

async function chooseAgents(): Promise<AgentName[]> {
  const detections = detectAgents(locations);
  const found = detections
    .filter((detection) => detection.found && !skipped.has(detection.agent))
    .map((detection) => detection.agent);
  // An explicit worker model is a request to configure that agent, even if it was not detected.
  for (const agent of ["claude", "codex"] as const) {
    if (workerFlags[agent].model && !found.includes(agent)) {
      found.push(agent);
    }
  }

  if (!interactive) {
    if (found.length === 0) {
      throw new Error(
        "Neither Claude Code nor Codex was detected. Pass --claude-worker-model or --codex-worker-model to install anyway.",
      );
    }
    console.log(`Configuring ${found.map((agent) => AGENT_NAMES[agent]).join(" and ")}.`);
    return found;
  }

  note(detections.map(describeDetection).join("\n"), "Detected agents");
  if (found.length === 0) {
    cancel("Neither Claude Code nor Codex was detected. Install one of them, then run the installer again.");
    process.exit(1);
  }
  const installed = (await installedAgents(locations)).filter((agent) => found.includes(agent));
  return exitIfCancelled(
    await multiselect<AgentName>({
      message: "Install Zeus for these agents?",
      options: found.map((agent) => ({ value: agent, label: AGENT_NAMES[agent] })),
      // Re-running the installer keeps the previous choice; a first run selects every detected agent.
      initialValues: installed.length > 0 ? installed : found,
      required: true,
    }),
  );
}

async function install(): Promise<void> {
  if (interactive) {
    intro("Zeus");
  }
  const agents = await chooseAgents();
  for (const agent of ["claude", "codex"] as const) {
    if (workerFlags[agent].effort && !agents.includes(agent)) {
      throw new Error(`--${agent}-worker-effort was given, but ${AGENT_NAMES[agent]} is not selected.`);
    }
  }

  const workerSettings = await resolveWorkerSettings({
    agents,
    flags: workerFlags,
    saved: (await readZeusConfig(zeusConfigPath(homeDir!)))?.workers ?? {},
    prompter: interactive ? terminalPrompter : undefined,
    catalogSource,
    log: console.log,
  });

  const plan = await planInstaller({
    action: "install",
    agents,
    homeDir: homeDir!,
    packageDir: findPackageDir(),
    binarySourcePath: process.execPath,
    binaryInstallDir: locations.binaryInstallDir,
    claudeConfigDir: locations.claudeConfigDir,
    codexHome: locations.codexHome,
    workerSettings,
    zeusVersion: ZEUS_VERSION,
  });
  const applied = await confirmAndApply(plan, "Apply these changes?");

  report([
    ...agents.map((agent) => `${AGENT_NAMES[agent]} Worker: ${describeWorkerSettings(workerSettings[agent])}.`),
    ...(applied && plan.operations.length > 0 ? ["Start a new agent session so Zeus is loaded."] : []),
  ]);
  const warning = pathWarning();
  if (warning) {
    report([warning], "warn");
  }
  if (interactive && !dryRun) {
    outro(`To uninstall: ${uninstallCommand()}`);
  } else if (!dryRun) {
    console.log(`Done. To uninstall: ${uninstallCommand()}`);
  }
}

async function uninstall(): Promise<void> {
  const agents = (await installedAgents(locations)).filter((agent) => !skipped.has(agent));
  if (interactive && !dryRun) {
    intro("Zeus");
  }
  const plan = await planInstaller({
    action: "uninstall",
    agents,
    homeDir: homeDir!,
    packageDir: findPackageDir(),
    binaryInstallDir: locations.binaryInstallDir,
    claudeConfigDir: locations.claudeConfigDir,
    codexHome: locations.codexHome,
  });
  if (plan.operations.length === 0 && !dryRun) {
    const message = "Zeus is not installed.";
    if (interactive) {
      outro(message);
    } else {
      console.log(message);
    }
    return;
  }
  if (!(await confirmAndApply(plan, "Remove Zeus?"))) {
    return;
  }
  if (interactive) {
    outro("Zeus was removed.");
  } else {
    console.log("Zeus was removed.");
  }
}

function versionLabel(version: string | undefined): string {
  return version ?? "nightly build";
}

/** A release tag as is; a source run or an unrecorded version in parentheses, like the other labels. */
function describeVersion(version: string | undefined): string {
  return version === undefined || version === DEVELOPMENT_VERSION ? `(${versionLabel(version)})` : version;
}

async function status(): Promise<void> {
  detectAgents(locations).forEach((detection) => console.log(describeDetection(detection)));
  const installed = await installations(locations);
  if (installed.length === 0) {
    console.log("Zeus is not installed.");
    return;
  }
  const workers = (await readZeusConfig(zeusConfigPath(homeDir!)))?.workers ?? {};
  // Agents installed by different releases list their own version.
  const versions = new Set(installed.map(({ zeusVersion }) => zeusVersion));
  const shared = versions.size === 1;
  console.log(
    shared
      ? `Zeus ${describeVersion(installed[0]!.zeusVersion)} is installed for:`
      : "Zeus is installed for:",
  );
  for (const { agent, zeusVersion } of installed) {
    const settings = workers[agent];
    const version = shared ? "" : ` (${versionLabel(zeusVersion)})`;
    console.log(`- ${AGENT_NAMES[agent]}${version}, Worker: ${settings ? describeWorkerSettings(settings) : "not set"}`);
  }
}

try {
  if (command === "install") {
    await install();
  } else if (command === "uninstall") {
    await uninstall();
  } else {
    await status();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
