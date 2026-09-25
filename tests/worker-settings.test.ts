import { describe, expect, test } from "bun:test";

import type { WorkerModelCatalog } from "../src/model-catalog.ts";
import {
  chooseWorkerSettings,
  loadWorkerCatalog,
  renderInstalledSkill,
  resolveWorkerSettings,
  settingsFromCatalog,
  WORKER_SETTINGS_TOKEN,
  type Prompter,
  type SelectOption,
} from "../src/worker-settings.ts";

const catalog: WorkerModelCatalog = {
  source: "test",
  models: [
    { id: "big", displayName: "Big", efforts: ["low", "high", "max"], defaultEffort: "high" },
    {
      id: "mid",
      displayName: "Mid",
      efforts: ["low", "medium"],
      defaultEffort: "medium",
      isDefault: true,
    },
    { id: "small", displayName: "Small", efforts: [] },
  ],
};

type SelectCall = { message: string; options: SelectOption[]; initialValue: string };

// Each answer is an option value, or null to accept the preselected option.
function scriptedPrompter(
  answers: (string | null)[],
): Prompter & { selects: SelectCall[]; printed: string[] } {
  const selects: SelectCall[] = [];
  const printed: string[] = [];
  return {
    selects,
    printed,
    select: async (message, options, initialValue) => {
      selects.push({ message, options, initialValue });
      if (answers.length === 0) {
        throw new Error(`Unexpected prompt: ${message}`);
      }
      const answer = answers.shift() ?? initialValue;
      if (!options.some(({ value }) => value === answer)) {
        throw new Error(`"${answer}" is not an option of ${message}`);
      }
      return answer;
    },
    progress: (_message, work) => work(),
    print: (line) => printed.push(line),
  };
}

const bundled = {
  capturedAt: "2026-01-02",
  catalogs: {
    claude: { source: "docs", models: [{ id: "claude-x", displayName: "X", efforts: [] }] },
    codex: { source: "codex", models: [{ id: "gpt-x", displayName: "X", efforts: ["low"] }] },
  },
};

describe("worker settings", () => {
  test("renders the agent-specific parameters into the SKILL", () => {
    const skill = `pass ${WORKER_SETTINGS_TOKEN} now`;
    expect(renderInstalledSkill(skill, "codex", { model: "gpt-x", effort: "high" })).toBe(
      'pass `model: "gpt-x"` and `thinking: "high"` now',
    );
    expect(renderInstalledSkill(skill, "claude", { model: "claude-x", effort: "max" })).toBe(
      'pass `model: "claude-x"` and `effort: "max"` now',
    );
    expect(renderInstalledSkill(skill, "claude", { model: "claude-x", effort: null })).toContain(
      "does not support effort",
    );
    expect(() => renderInstalledSkill("no token", "codex", { model: "m", effort: null })).toThrow(
      "no worker settings placeholder",
    );
  });

  test("validates explicit settings against the catalog", () => {
    expect(settingsFromCatalog("codex", catalog, "big", undefined)).toEqual({
      model: "big",
      effort: "high",
    });
    expect(settingsFromCatalog("codex", catalog, "small", undefined)).toEqual({
      model: "small",
      effort: null,
    });
    expect(() => settingsFromCatalog("codex", catalog, "nope", undefined)).toThrow(
      'Codex model "nope" is not in the catalog',
    );
    expect(() => settingsFromCatalog("codex", catalog, "mid", "max")).toThrow(
      'does not support effort "max"',
    );
    expect(() => settingsFromCatalog("claude", catalog, "small", "low")).toThrow(
      "does not support effort",
    );
  });

  test("wizard preselects the catalog default model and its default effort", async () => {
    const prompter = scriptedPrompter([null, null]);
    expect(await chooseWorkerSettings("codex", catalog, undefined, prompter)).toEqual({
      model: "mid",
      effort: "medium",
    });
    const [models, efforts] = prompter.selects;
    expect(models?.message).toBe("Codex worker model");
    expect(models?.initialValue).toBe("mid");
    expect(models?.options).toEqual([
      { value: "big", label: "Big", hint: "big" },
      { value: "mid", label: "Mid", hint: "mid · Codex default" },
      { value: "small", label: "Small", hint: "small" },
    ]);
    expect(efforts?.message).toBe("Codex worker effort for Mid");
    expect(efforts?.initialValue).toBe("medium");
    expect(prompter.printed).toEqual(["Codex models: test."]);
  });

  test("wizard preselects and marks the saved choice", async () => {
    const prompter = scriptedPrompter([null, "max"]);
    expect(
      await chooseWorkerSettings("claude", catalog, { model: "big", effort: "low" }, prompter),
    ).toEqual({ model: "big", effort: "max" });
    const [models, efforts] = prompter.selects;
    expect(models?.initialValue).toBe("big");
    expect(models?.options[0]?.hint).toBe("big · current");
    expect(efforts?.initialValue).toBe("low");
    expect(efforts?.options).toEqual([
      { value: "low", label: "low", hint: "current" },
      { value: "high", label: "high", hint: "model default" },
      { value: "max", label: "max", hint: undefined },
    ]);
  });

  test("wizard skips effort for a model without effort support", async () => {
    const prompter = scriptedPrompter(["small"]);
    expect(await chooseWorkerSettings("claude", catalog, undefined, prompter)).toEqual({
      model: "small",
      effort: null,
    });
    expect(prompter.selects).toHaveLength(1);
    expect(prompter.printed).toContain("Small does not support effort.");
  });

  test("falls back to the bundled catalog and says why", async () => {
    const loaded = await loadWorkerCatalog(
      "codex",
      { provider: { getCatalog: async () => Promise.reject(new Error("offline")) } },
      bundled,
    );
    expect(loaded.catalog.models.map(({ id }) => id)).toEqual(["gpt-x"]);
    expect(loaded.catalog.source).toBe("codex, bundled on 2026-01-02");
    expect(loaded.warning).toContain("(offline)");
    expect(loaded.warning).toContain("captured on 2026-01-02");
  });

  test("resolves flags first, then the wizard, then the saved choice", async () => {
    const request = {
      agents: ["claude", "codex"] as ("claude" | "codex")[],
      saved: { claude: { model: "saved-claude", effort: null }, codex: { model: "saved", effort: "low" } },
      catalogSource: () => ({ provider: { getCatalog: async () => catalog } }),
      log: () => {},
    };

    expect(
      await resolveWorkerSettings({ ...request, flags: { codex: { model: "big", effort: "max" } } }),
    ).toEqual({
      claude: { model: "saved-claude", effort: null },
      codex: { model: "big", effort: "max" },
    });

    expect(
      await resolveWorkerSettings({
        ...request,
        agents: ["codex"],
        flags: {},
        prompter: scriptedPrompter(["big", "low"]),
      }),
    ).toEqual({ codex: { model: "big", effort: "low" } } as never);
  });

  test("requires a choice when there is no terminal and nothing is saved", async () => {
    const request = {
      agents: ["codex"] as "codex"[],
      saved: {},
      catalogSource: () => ({}),
      log: () => {},
    };
    await expect(resolveWorkerSettings({ ...request, flags: {} })).rejects.toThrow(
      "No Codex worker model is configured",
    );
    await expect(
      resolveWorkerSettings({ ...request, flags: { codex: { effort: "low" } } }),
    ).rejects.toThrow("--codex-worker-effort requires --codex-worker-model");
  });
});
