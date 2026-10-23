import { describe, expect, test } from "bun:test";

import { describeDetection, detectAgents, type Probe } from "../src/detect.ts";

function probe(overrides: Partial<Probe>): Probe {
  return {
    which: () => null,
    exists: () => false,
    readText: () => undefined,
    version: () => undefined,
    platform: "darwin",
    ...overrides,
  };
}

describe("detectAgents", () => {
  test("finds the CLI, the desktop app and a bare configuration directory", () => {
    const detections = detectAgents(
      { homeDir: "/home/user", codexHome: "/custom/codex" },
      probe({
        which: (command) => (command === "claude" ? "/bin/claude" : null),
        version: () => "2.1.0",
        readText: (path) =>
          path === "/Applications/ChatGPT.app/Contents/Info.plist" ? "com.openai.codex" : undefined,
        exists: (path) => path === "/custom/codex",
      }),
    );

    expect(detections.map(describeDetection)).toEqual([
      "Claude Code: CLI 2.1.0 (/home/user/.claude)",
      "Codex: Desktop app (/custom/codex)",
    ]);
  });

  test("reports missing agents and ignores app bundles outside macOS", () => {
    const detections = detectAgents(
      { homeDir: "/home/user" },
      probe({ platform: "linux", readText: () => "com.anthropic.claudefordesktop" }),
    );

    expect(detections.map(({ found }) => found)).toEqual([false, false]);
    expect(describeDetection(detections[0]!)).toBe("Claude Code: not found");
  });

  test("treats a configuration directory alone as an installed agent", () => {
    const [claude] = detectAgents(
      { homeDir: "/home/user" },
      probe({ exists: (path) => path === "/home/user/.claude" }),
    );

    expect(describeDetection(claude!)).toBe("Claude Code: configuration only (/home/user/.claude)");
  });
});
