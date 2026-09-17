import { afterEach, describe, expect, test } from "bun:test";
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
    await writeFile(codexHooks, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"custom-stop"}]}]}}\n');
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
    expect(hookEntries(codex, "SessionStart")).toHaveLength(1);
    expect(await readFile(codexConfig, "utf8")).toContain("hooks = true");

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
    await writeFile(codexConfig, "[features]\nhooks = false\nother = true\n");

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
    await runInstaller({ ...common, action: "uninstall" });

    const claude = JSON.parse(await readFile(claudeSettings, "utf8")) as Record<string, unknown>;
    const codex = JSON.parse(await readFile(codexHooks, "utf8")) as Record<string, unknown>;
    expect(claude).toEqual({ theme: "dark" });
    expect(hookEntries(codex, "Stop")).toHaveLength(1);
    expect(hookEntries(codex, "SessionStart")).toHaveLength(0);
    expect(await readFile(codexConfig, "utf8")).toContain("hooks = false");

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
});
