import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentName } from "./installer.ts";

export type AgentDetection = {
  agent: AgentName;
  /** Human-readable variants that were found, e.g. "CLI 2.1.296", "Desktop app". */
  variants: string[];
  configDir: string;
  found: boolean;
};

export type Probe = {
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  version: (binary: string) => string | undefined;
  platform: NodeJS.Platform;
};

export type DetectionLocations = {
  homeDir: string;
  claudeConfigDir?: string;
  codexHome?: string;
};

export const AGENT_NAMES: Record<AgentName, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const systemProbe: Probe = {
  which: (command) => Bun.which(command),
  exists: existsSync,
  readText: (path) => {
    try {
      return readFileSync(path, "latin1");
    } catch {
      return undefined;
    }
  },
  version: (binary) => {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return result.status === 0 ? result.stdout.trim().match(/\d+\.\d+\.\d+\S*/)?.[0] : undefined;
  },
  platform: process.platform,
};

function findApp(homeDir: string, probe: Probe, names: string[], bundleId: string): boolean {
  if (probe.platform !== "darwin") {
    return false;
  }
  return ["/Applications", join(homeDir, "Applications")].some((dir) =>
    names.some((name) => probe.readText(join(dir, name, "Contents", "Info.plist"))?.includes(bundleId)),
  );
}

function cliVariant(probe: Probe, command: string): string | undefined {
  const path = probe.which(command);
  if (!path) {
    return undefined;
  }
  const version = probe.version(path);
  return version ? `CLI ${version}` : "CLI";
}

function detection(agent: AgentName, configDir: string, variants: (string | undefined)[], probe: Probe): AgentDetection {
  const found = variants.filter((variant): variant is string => variant !== undefined);
  return { agent, variants: found, configDir, found: found.length > 0 || probe.exists(configDir) };
}

export function detectAgents(locations: DetectionLocations, probe: Probe = systemProbe): AgentDetection[] {
  const { homeDir } = locations;
  return [
    detection("claude", locations.claudeConfigDir ?? join(homeDir, ".claude"), [
      cliVariant(probe, "claude"),
      findApp(homeDir, probe, ["Claude.app"], "com.anthropic.claudefordesktop") ? "Desktop app" : undefined,
    ], probe),
    detection("codex", locations.codexHome ?? join(homeDir, ".codex"), [
      cliVariant(probe, "codex"),
      // The Codex desktop app ships as ChatGPT.app with the com.openai.codex bundle id.
      findApp(homeDir, probe, ["ChatGPT.app", "Codex.app"], "com.openai.codex") ? "Desktop app" : undefined,
    ], probe),
  ];
}

export function describeDetection(detection: AgentDetection): string {
  const name = AGENT_NAMES[detection.agent];
  if (!detection.found) {
    return `${name}: not found`;
  }
  const variants = detection.variants.length > 0 ? detection.variants.join(", ") : "configuration only";
  return `${name}: ${variants} (${detection.configDir})`;
}
