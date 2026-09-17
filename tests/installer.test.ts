import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { runInstaller } from "../src/installer.ts";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zeus-installer-"));
  temporaryDirectories.push(path);
  return path;
}

function hookEntries(config: Record<string, unknown>, event: string): unknown[] {
  const hooks = config.hooks as Record<string, unknown> | undefined;
  return Array.isArray(hooks?.[event]) ? hooks[event] : [];
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function expectedCodexHookHash(command: string): string {
  return expectedCodexGroupHash("compact", [
    {
      type: "command",
      command,
      timeout: 30,
      async: false,
      additionalContextLimit: 0,
    },
  ]);
}

function expectedCodexGroupHash(
  matcher: string,
  hooks: Record<string, unknown>[],
): string {
  const identity = canonicalJson({
    event_name: "session_start",
    matcher,
    hooks,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

describe("Zeus installer", () => {
  test("installs both agents idempotently and preserves unrelated hooks", async () => {
    const homeDir = await temporaryHome();
    const claudeSettings = join(homeDir, ".claude", "settings.json");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const codexConfig = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(claudeSettings), { recursive: true });
    await mkdir(dirname(codexHooks), { recursive: true });
    const claudeSkill = join(homeDir, ".claude", "skills", "zeus", "SKILL.md");
    await writeFile(
      claudeSettings,
      `{
  // Keep this comment.
  "hooks": {
    "PostCompact": [
      { "matcher": "manual|auto", "hooks": [
        { "type": "command", "command": "custom-hook" },
        { "type": "command", "command": "'/tmp/bin/zeus' hook --agent claude --skill '${claudeSkill}'" }
      ] }
    ]
  }
}\n`,
    );
    await writeFile(
      codexHooks,
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"custom-stop"}]}],"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"custom-start"}]}]}}\n',
    );
    await writeFile(codexConfig, "[features]\nhooks = false\nother = true\n");

    const options = {
      action: "install" as const,
      agents: ["claude", "codex"] as const,
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };
    await runInstaller({ ...options, agents: [...options.agents] });
    await runInstaller({ ...options, agents: [...options.agents] });

    const claudeText = await readFile(claudeSettings, "utf8");
    const claude = parse(claudeText) as Record<string, unknown>;
    const codex = JSON.parse(await readFile(codexHooks, "utf8")) as Record<string, unknown>;
    expect(claudeText).toContain("// Keep this comment.");
    expect(hookEntries(claude, "PostCompact")).toHaveLength(2);
    expect(JSON.stringify(hookEntries(claude, "PostCompact"))).toContain("custom-hook");
    expect(hookEntries(claude, "PostCompact").filter((entry) => JSON.stringify(entry).includes("/bin/zeus' hook --agent claude"))).toHaveLength(1);
    expect(hookEntries(codex, "Stop")).toHaveLength(1);
    expect(hookEntries(codex, "SessionStart")).toHaveLength(2);
    const codexConfigText = await readFile(codexConfig, "utf8");
    const parsedCodexConfig = Bun.TOML.parse(codexConfigText) as Record<string, unknown>;
    const trustKey = `${codexHooks}:session_start:1:0`;
    const codexState = ((parsedCodexConfig.hooks as Record<string, unknown>).state ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const codexCommand = `'${join(homeDir, ".local", "bin", "zeus")}' hook --agent codex --skill '${join(homeDir, ".codex", "skills", "zeus", "SKILL.md")}'`;
    expect(codexConfigText).toContain("hooks = true");
    expect(codexState[trustKey]?.trusted_hash).toBe(
      expectedCodexHookHash(codexCommand),
    );

    for (const agent of ["claude", "codex"]) {
      const skillDir = join(homeDir, `.${agent}`, "skills", "zeus");
      expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("Zeus — workstream coordination");
    }
    expect((await stat(join(homeDir, ".local", "bin", "zeus"))).mode & 0o777).toBe(0o755);
  });

  test("uninstall removes only Zeus entries and restores Codex feature state", async () => {
    const homeDir = await temporaryHome();
    const claudeSettings = join(homeDir, ".claude", "settings.json");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const codexConfig = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(claudeSettings), { recursive: true });
    await mkdir(dirname(codexHooks), { recursive: true });
    await writeFile(claudeSettings, '{"theme":"dark"}\n');
    await writeFile(codexHooks, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"custom-stop"}]}]}}\n');
    const zeusTrustKey = `${codexHooks}:session_start:0:0`;
    const unrelatedTrustKey = "/opt/acme/hooks.json:stop:0:0";
    await writeFile(
      codexConfig,
      `[features]\nhooks = false\nother = true\n\n# Preserve hook trust owned by other tools.\n[hooks.state.${JSON.stringify(zeusTrustKey)}]\ntrusted_hash = "sha256:previous"\nenabled = false\n\n[hooks.state.${JSON.stringify(unrelatedTrustKey)}]\ntrusted_hash = "sha256:unrelated"\n`,
    );

    const common = {
      agents: ["claude", "codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };
    await runInstaller({ ...common, action: "install" });
    const installedConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string; enabled?: boolean }> };
    };
    expect(installedConfig.hooks.state[zeusTrustKey]?.trusted_hash).not.toBe(
      "sha256:previous",
    );
    expect(installedConfig.hooks.state[zeusTrustKey]?.enabled).toBe(false);
    await runInstaller({ ...common, action: "uninstall" });

    const claude = JSON.parse(await readFile(claudeSettings, "utf8")) as Record<string, unknown>;
    const codex = JSON.parse(await readFile(codexHooks, "utf8")) as Record<string, unknown>;
    expect(claude).toEqual({ theme: "dark" });
    expect(hookEntries(codex, "Stop")).toHaveLength(1);
    expect(hookEntries(codex, "SessionStart")).toHaveLength(0);
    const restoredConfigText = await readFile(codexConfig, "utf8");
    const restoredConfig = Bun.TOML.parse(restoredConfigText) as {
      hooks: { state: Record<string, { trusted_hash?: string; enabled?: boolean }> };
    };
    expect(restoredConfigText).toContain("hooks = false");
    expect(restoredConfigText).toContain("# Preserve hook trust owned by other tools.");
    expect(restoredConfig.hooks.state[zeusTrustKey]).toEqual({
      trusted_hash: "sha256:previous",
      enabled: false,
    });
    expect(restoredConfig.hooks.state[unrelatedTrustKey]?.trusted_hash).toBe(
      "sha256:unrelated",
    );

    for (const agent of ["claude", "codex"]) {
      expect(
        await stat(join(homeDir, `.${agent}`, "skills", "zeus")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
    expect(
      await stat(join(homeDir, ".local", "bin", "zeus")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("uninstall removes Codex config created only for Zeus hook trust", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    expect(await readFile(codexConfig, "utf8")).toContain("trusted_hash");

    await runInstaller({ ...common, action: "uninstall" });
    expect(await stat(codexConfig).then(() => true, () => false)).toBe(false);
    expect(await stat(codexHooks).then(() => true, () => false)).toBe(false);
  });

  test("uninstall preserves a hook hash changed after installation", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    const installedText = await readFile(codexConfig, "utf8");
    await writeFile(
      codexConfig,
      installedText.replace(
        /^trusted_hash\s*=\s*"sha256:[0-9a-f]+"$/m,
        'trusted_hash = "sha256:user-change"',
      ),
    );

    await runInstaller({ ...common, action: "uninstall" });
    const restored = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(Object.values(restored.hooks.state)[0]?.trusted_hash).toBe(
      "sha256:user-change",
    );
  });

  test("reinstall and uninstall preserve trust for a hook added after Zeus", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    const hooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: Record<string, unknown>[] };
    };
    const foreignHandler = {
      type: "command",
      command: "foreign-hook",
      timeout: 30,
      additionalContextLimit: 0,
    };
    hooks.hooks.SessionStart.push({
      matcher: "startup",
      hooks: [foreignHandler],
    });
    await writeFile(codexHooks, `${JSON.stringify(hooks, null, 2)}\n`);

    const foreignKeyBeforeUninstall = `${codexHooks}:session_start:1:0`;
    const foreignHash = expectedCodexGroupHash("startup", [
      { ...foreignHandler, async: false },
    ]);
    await writeFile(
      codexConfig,
      `${await readFile(codexConfig, "utf8")}\n[hooks.state.${JSON.stringify(foreignKeyBeforeUninstall)}]\ntrusted_hash = ${JSON.stringify(foreignHash)}\n`,
    );

    await runInstaller({ ...common, action: "install" });
    const reinstalledHooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: { matcher: string }[] };
    };
    const reinstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(reinstalledHooks.hooks.SessionStart.map(({ matcher }) => matcher)).toEqual([
      "compact",
      "startup",
    ]);
    expect(
      reinstalledConfig.hooks.state[foreignKeyBeforeUninstall]?.trusted_hash,
    ).toBe(foreignHash);

    await runInstaller({ ...common, action: "uninstall" });
    const uninstalledHooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: { matcher: string }[] };
    };
    const uninstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    const foreignKeyAfterUninstall = `${codexHooks}:session_start:0:0`;
    expect(uninstalledHooks.hooks.SessionStart.map(({ matcher }) => matcher)).toEqual([
      "startup",
    ]);
    expect(
      uninstalledConfig.hooks.state[foreignKeyAfterUninstall]?.trusted_hash,
    ).toBe(foreignHash);
    expect(uninstalledConfig.hooks.state[foreignKeyBeforeUninstall]).toBeUndefined();
  });

  test("reinstall preserves trust for a handler added to the Zeus group", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    const hooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: { hooks: Record<string, unknown>[] }[] };
    };
    const foreignHandler = {
      type: "command",
      command: "foreign-hook",
      timeout: 30,
      additionalContextLimit: 0,
    };
    hooks.hooks.SessionStart[0]!.hooks.push(foreignHandler);
    await writeFile(codexHooks, `${JSON.stringify(hooks, null, 2)}\n`);

    const foreignKeyBeforeUninstall = `${codexHooks}:session_start:0:1`;
    const foreignHash = expectedCodexGroupHash("compact", [
      { ...foreignHandler, async: false },
    ]);
    await writeFile(
      codexConfig,
      `${await readFile(codexConfig, "utf8")}\n[hooks.state.${JSON.stringify(foreignKeyBeforeUninstall)}]\ntrusted_hash = ${JSON.stringify(foreignHash)}\n`,
    );

    await runInstaller({ ...common, action: "install" });
    const reinstalledHooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    const reinstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(reinstalledHooks.hooks.SessionStart).toHaveLength(1);
    expect(
      reinstalledHooks.hooks.SessionStart[0]!.hooks.map(({ command }) => command),
    ).toEqual([
      expect.stringContaining(" hook --agent codex "),
      "foreign-hook",
    ]);
    expect(
      reinstalledConfig.hooks.state[foreignKeyBeforeUninstall]?.trusted_hash,
    ).toBe(foreignHash);

    await runInstaller({ ...common, action: "uninstall" });
    const uninstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    const foreignKeyAfterUninstall = `${codexHooks}:session_start:0:0`;
    expect(
      uninstalledConfig.hooks.state[foreignKeyAfterUninstall]?.trusted_hash,
    ).toBe(foreignHash);
    expect(uninstalledConfig.hooks.state[foreignKeyBeforeUninstall]).toBeUndefined();
  });

  test("uninstall migrates foreign trust without an install manifest", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const manifest = join(homeDir, ".codex", "skills", "zeus", ".zeus-install.json");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    const hooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: Record<string, unknown>[] };
    };
    const foreignHandler = {
      type: "command",
      command: "foreign-hook",
      timeout: 30,
      additionalContextLimit: 0,
    };
    hooks.hooks.SessionStart.push({ matcher: "startup", hooks: [foreignHandler] });
    await writeFile(codexHooks, `${JSON.stringify(hooks, null, 2)}\n`);

    const oldForeignKey = `${codexHooks}:session_start:1:0`;
    const newForeignKey = `${codexHooks}:session_start:0:0`;
    const foreignHash = expectedCodexGroupHash("startup", [
      { ...foreignHandler, async: false },
    ]);
    await writeFile(
      codexConfig,
      `${await readFile(codexConfig, "utf8")}\n[hooks.state.${JSON.stringify(oldForeignKey)}]\ntrusted_hash = ${JSON.stringify(foreignHash)}\n`,
    );
    await rm(manifest);

    await runInstaller({ ...common, action: "uninstall" });
    const uninstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(uninstalledConfig.hooks.state[newForeignKey]?.trusted_hash).toBe(
      foreignHash,
    );
    expect(uninstalledConfig.hooks.state[oldForeignKey]).toBeUndefined();
  });

  test("reinstall deduplicates Zeus without invalidating foreign trust", async () => {
    const homeDir = await temporaryHome();
    const codexConfig = join(homeDir, ".codex", "config.toml");
    const codexHooks = join(homeDir, ".codex", "hooks.json");
    const common = {
      agents: ["codex"] as ("claude" | "codex")[],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };

    await runInstaller({ ...common, action: "install" });
    const hooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: Record<string, unknown>[] };
    };
    const zeusGroup = hooks.hooks.SessionStart[0]!;
    const foreignHandler = {
      type: "command",
      command: "foreign-hook",
      timeout: 30,
      additionalContextLimit: 0,
    };
    hooks.hooks.SessionStart.push(
      { matcher: "startup", hooks: [foreignHandler] },
      structuredClone(zeusGroup),
    );
    await writeFile(codexHooks, `${JSON.stringify(hooks, null, 2)}\n`);

    const oldForeignKey = `${codexHooks}:session_start:1:0`;
    const newForeignKey = `${codexHooks}:session_start:0:0`;
    const duplicateZeusKey = `${codexHooks}:session_start:2:0`;
    const foreignHash = expectedCodexGroupHash("startup", [
      { ...foreignHandler, async: false },
    ]);
    await writeFile(
      codexConfig,
      `${await readFile(codexConfig, "utf8")}\n[hooks.state.${JSON.stringify(oldForeignKey)}]\ntrusted_hash = ${JSON.stringify(foreignHash)}\n\n[hooks.state.${JSON.stringify(duplicateZeusKey)}]\ntrusted_hash = "sha256:duplicate"\n`,
    );

    await runInstaller({ ...common, action: "install" });
    const reinstalledHooks = JSON.parse(await readFile(codexHooks, "utf8")) as {
      hooks: { SessionStart: { matcher: string }[] };
    };
    const reinstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(reinstalledHooks.hooks.SessionStart.map(({ matcher }) => matcher)).toEqual([
      "startup",
      "compact",
    ]);
    expect(reinstalledConfig.hooks.state[newForeignKey]?.trusted_hash).toBe(
      foreignHash,
    );
    expect(reinstalledConfig.hooks.state[duplicateZeusKey]).toBeUndefined();

    await runInstaller({ ...common, action: "uninstall" });
    const uninstalledConfig = Bun.TOML.parse(await readFile(codexConfig, "utf8")) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    expect(uninstalledConfig.hooks.state[newForeignKey]?.trusted_hash).toBe(
      foreignHash,
    );
  });

  test("aborts before writing when a config file is malformed", async () => {
    const homeDir = await temporaryHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "{ broken", "utf8");

    await expect(
      runInstaller({
        action: "install",
        agents: ["claude"],
        dryRun: false,
        homeDir,
        packageDir: projectDir,
        binarySourcePath: join(projectDir, "install.sh"),
        binaryInstallDir: join(homeDir, ".local", "bin"),
        log: () => {},
      }),
    ).rejects.toThrow("Cannot safely edit");
    expect(
      await stat(join(homeDir, ".claude", "skills", "zeus")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("dry run does not write files", async () => {
    const homeDir = await temporaryHome();
    await runInstaller({
      action: "install",
      agents: ["claude", "codex"],
      dryRun: true,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    expect(await stat(join(homeDir, ".claude")).then(() => true, () => false)).toBe(false);
    expect(await stat(join(homeDir, ".codex")).then(() => true, () => false)).toBe(false);
  });

  test("registers the standalone executable as the hook", async () => {
    const homeDir = await temporaryHome();
    await runInstaller({
      action: "install",
      agents: ["claude"],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    const settings = JSON.parse(
      await readFile(join(homeDir, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(hookEntries(settings, "PostCompact"))).toContain(
      "hook --agent claude --skill",
    );
  });

  test("uninstall preserves an unrelated handler in the same matcher group", async () => {
    const homeDir = await temporaryHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const skillPath = join(homeDir, ".claude", "skills", "zeus", "SKILL.md");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostCompact: [
            {
              matcher: "manual|auto",
              hooks: [
                { type: "command", command: "custom-hook" },
                {
                  type: "command",
                  command: `'/tmp/bin/zeus' hook --agent claude --skill '${skillPath}'`,
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    await runInstaller({
      action: "uninstall",
      agents: ["claude"],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(hookEntries(settings, "PostCompact")).toEqual([
      {
        matcher: "manual|auto",
        hooks: [{ type: "command", command: "custom-hook" }],
      },
    ]);
  });

  test("uninstall preserves JSONC comments in a mixed matcher group", async () => {
    const homeDir = await temporaryHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const skillPath = join(homeDir, ".claude", "skills", "zeus", "SKILL.md");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `{
  "hooks": {
    "PostCompact": [{
      "matcher": "manual|auto",
      "hooks": [
        // Keep the custom handler comment.
        { "type": "command", "command": "custom-hook" },
        // Zeus owns only this handler.
        { "type": "command", "command": "'/tmp/bin/zeus' hook --agent claude --skill '${skillPath}'" }
      ]
    }]
  }
}\n`,
      "utf8",
    );

    await runInstaller({
      action: "uninstall",
      agents: ["claude"],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    const text = await readFile(settingsPath, "utf8");
    const settings = parse(text) as Record<string, unknown>;
    expect(text).toContain("// Keep the custom handler comment.");
    expect(JSON.stringify(hookEntries(settings, "PostCompact"))).toContain(
      "custom-hook",
    );
    expect(text).not.toContain("hook --agent claude");
  });

  test("preserves hook commands that are not owned by this Zeus install", async () => {
    const homeDir = await temporaryHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const foreignHooks = [
      "'/opt/acme/zeus' hook --agent unrelated --skill '/tmp/SKILL.md'",
      "'/opt/acme/zeus' hook --agent claude --skill '/opt/acme/SKILL.md'",
    ] as const;
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostCompact: foreignHooks.map((command) => ({
            matcher: "manual|auto",
            hooks: [{ type: "command", command }],
          })),
        },
      }),
      "utf8",
    );

    await runInstaller({
      action: "uninstall",
      agents: ["claude"],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(hookEntries(settings, "PostCompact"))).toContain(
      foreignHooks[0],
    );
    expect(JSON.stringify(hookEntries(settings, "PostCompact"))).toContain(
      foreignHooks[1],
    );
  });

  test("preserves symlinked configuration files", async () => {
    const homeDir = await temporaryHome();
    const settingsPath = join(homeDir, ".claude", "settings.json");
    const targetPath = join(homeDir, "dotfiles", "claude-settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, '{"theme":"dark"}\n', "utf8");
    await symlink(targetPath, settingsPath);

    const options = {
      agents: ["claude"] as const,
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    };
    await runInstaller({ ...options, action: "install", agents: [...options.agents] });
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, "utf8")).toContain("PostCompact");

    await runInstaller({ ...options, action: "uninstall", agents: [...options.agents] });
    expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual({ theme: "dark" });
  });

  test("uses the lexical hook path for a symlinked default Codex home", async () => {
    const homeDir = await temporaryHome();
    const codexHome = join(homeDir, ".codex");
    const codexTarget = join(homeDir, "dotfiles", "codex");
    await mkdir(codexTarget, { recursive: true });
    await symlink(codexTarget, codexHome);

    await runInstaller({
      action: "install",
      agents: ["codex"],
      dryRun: false,
      homeDir,
      packageDir: projectDir,
      binarySourcePath: join(projectDir, "install.sh"),
      binaryInstallDir: join(homeDir, ".local", "bin"),
      log: () => {},
    });

    const config = Bun.TOML.parse(
      await readFile(join(codexTarget, "config.toml"), "utf8"),
    ) as {
      hooks: { state: Record<string, { trusted_hash?: string }> };
    };
    const keys = Object.keys(config.hooks.state);
    expect(keys).toEqual([`${codexHome}/hooks.json:session_start:0:0`]);
    expect(keys[0]).not.toContain(codexTarget);
    expect((await lstat(codexHome)).isSymbolicLink()).toBe(true);
  });
});
