import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentName } from "./installer.ts";
import {
  validateBundledCatalogs,
  type WorkerModelCatalog,
  type WorkerModelCatalogProvider,
} from "./model-catalog.ts";
import bundledCatalogsJson from "./model-catalog.bundled.json";

export type WorkerSettings = {
  model: string;
  effort: string | null;
};

export type WorkerSettingsByAgent = Partial<Record<AgentName, WorkerSettings>>;

export type ZeusConfig = {
  version: 1;
  workers: WorkerSettingsByAgent;
};

export const WORKER_SETTINGS_TOKEN = "<zeus:worker-settings>";

const AGENT_LABELS: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function zeusConfigPath(homeDir: string): string {
  return join(homeDir, ".zeus", "config.json");
}

export async function readZeusConfig(path: string): Promise<ZeusConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Cannot safely continue: ${path} is not valid JSON.`);
  }
  if (!isObject(value) || value.version !== 1 || !isObject(value.workers)) {
    throw new Error(`Cannot safely continue: ${path} is not a Zeus configuration file.`);
  }

  const workers: WorkerSettingsByAgent = {};
  for (const agent of ["claude", "codex"] as const) {
    const settings = value.workers[agent];
    if (settings === undefined) {
      continue;
    }
    if (
      !isObject(settings) ||
      typeof settings.model !== "string" ||
      settings.model === "" ||
      (settings.effort !== null && typeof settings.effort !== "string")
    ) {
      throw new Error(`Cannot safely continue: ${path} has invalid ${agent} worker settings.`);
    }
    workers[agent] = { model: settings.model, effort: settings.effort };
  }
  return { version: 1, workers };
}

export function serializeZeusConfig(config: ZeusConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function describeWorkerSettings(settings: WorkerSettings): string {
  return settings.effort ? `${settings.model} / ${settings.effort}` : `${settings.model} / no effort`;
}

function renderWorkerSettings(agent: AgentName, settings: WorkerSettings): string {
  const model = `\`model: ${JSON.stringify(settings.model)}\``;
  if (settings.effort === null) {
    return agent === "claude"
      ? `${model} (this model does not support effort, so leave effort unset)`
      : model;
  }
  const effortKey = agent === "claude" ? "effort" : "thinking";
  return `${model} and \`${effortKey}: ${JSON.stringify(settings.effort)}\``;
}

export function renderInstalledSkill(
  skill: string,
  agent: AgentName,
  settings: WorkerSettings,
): string {
  if (!skill.includes(WORKER_SETTINGS_TOKEN)) {
    throw new Error(`The ${agent} SKILL payload has no worker settings placeholder.`);
  }
  return skill.replaceAll(WORKER_SETTINGS_TOKEN, renderWorkerSettings(agent, settings));
}

export function settingsFromCatalog(
  agent: AgentName,
  catalog: WorkerModelCatalog,
  modelId: string,
  effort: string | undefined,
): WorkerSettings {
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(
      `${AGENT_LABELS[agent]} model "${modelId}" is not in the catalog. Available: ${catalog.models.map(({ id }) => id).join(", ")}.`,
    );
  }
  if (model.efforts.length === 0) {
    if (effort !== undefined) {
      throw new Error(`${AGENT_LABELS[agent]} model "${modelId}" does not support effort.`);
    }
    return { model: model.id, effort: null };
  }
  const resolvedEffort = effort ?? model.defaultEffort ?? model.efforts[0]!;
  if (!model.efforts.includes(resolvedEffort)) {
    throw new Error(
      `${AGENT_LABELS[agent]} model "${modelId}" does not support effort "${resolvedEffort}". Available: ${model.efforts.join(", ")}.`,
    );
  }
  return { model: model.id, effort: resolvedEffort };
}

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
};

export type Prompter = {
  select(message: string, options: SelectOption[], initialValue: string): Promise<string>;
  progress<T>(message: string, work: () => Promise<T>): Promise<T>;
  print(line: string): void;
};

function hints(...parts: (string | false | undefined)[]): string | undefined {
  const text = parts.filter(Boolean).join(" · ");
  return text || undefined;
}

export async function chooseWorkerSettings(
  agent: AgentName,
  catalog: WorkerModelCatalog,
  previous: WorkerSettings | undefined,
  prompter: Prompter,
): Promise<WorkerSettings> {
  const label = AGENT_LABELS[agent];
  const models = catalog.models;
  const initialModel =
    models.find(({ id }) => id === previous?.model) ??
    models.find((model) => model.isDefault) ??
    models[0]!;

  prompter.print(`${label} models: ${catalog.source}.`);
  const modelId = await prompter.select(
    `${label} worker model`,
    models.map((candidate) => ({
      value: candidate.id,
      label: candidate.displayName,
      hint: hints(
        candidate.id,
        candidate.id === previous?.model && "current",
        candidate.isDefault && `${label} default`,
      ),
    })),
    initialModel.id,
  );
  const model = models.find(({ id }) => id === modelId)!;

  if (model.efforts.length === 0) {
    prompter.print(`${model.displayName} does not support effort.`);
    return { model: model.id, effort: null };
  }

  const previousEffort = previous?.model === model.id ? previous.effort : null;
  const initialEffort =
    (previousEffort && model.efforts.includes(previousEffort) && previousEffort) ||
    (model.defaultEffort && model.efforts.includes(model.defaultEffort) && model.defaultEffort) ||
    model.efforts[0]!;
  const effort = await prompter.select(
    `${label} worker effort for ${model.displayName}`,
    model.efforts.map((candidate) => ({
      value: candidate,
      label: candidate,
      hint: hints(
        candidate === previousEffort && "current",
        candidate === model.defaultEffort && "model default",
      ),
    })),
    initialEffort,
  );
  return { model: model.id, effort };
}

export type CatalogSource = {
  provider?: WorkerModelCatalogProvider;
  unavailableReason?: string;
};

export type LoadedCatalog = {
  catalog: WorkerModelCatalog;
  warning?: string;
};

export async function loadWorkerCatalog(
  agent: AgentName,
  source: CatalogSource,
  bundled: unknown = bundledCatalogsJson,
): Promise<LoadedCatalog> {
  let reason = source.unavailableReason ?? "no catalog source is available";
  if (source.provider) {
    try {
      return { catalog: await source.provider.getCatalog() };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  const catalogs = validateBundledCatalogs(bundled);
  const catalog = catalogs.catalogs[agent];
  return {
    catalog: { ...catalog, source: `${catalog.source}, bundled on ${catalogs.capturedAt}` },
    warning: `Could not load the live ${AGENT_LABELS[agent]} model catalog (${reason}). Using the catalog bundled with Zeus, captured on ${catalogs.capturedAt}.`,
  };
}

export type WorkerSettingsRequest = {
  agents: AgentName[];
  flags: Partial<Record<AgentName, { model?: string; effort?: string }>>;
  saved: WorkerSettingsByAgent;
  prompter?: Prompter;
  catalogSource: (agent: AgentName) => CatalogSource;
  log: (message: string) => void;
};

export async function resolveWorkerSettings(
  request: WorkerSettingsRequest,
): Promise<Record<AgentName, WorkerSettings>> {
  const log = request.prompter ? (line: string) => request.prompter!.print(line) : request.log;
  const loadCatalog = async (agent: AgentName): Promise<WorkerModelCatalog> => {
    const load = () => loadWorkerCatalog(agent, request.catalogSource(agent));
    const loaded = request.prompter
      ? await request.prompter.progress(`${AGENT_LABELS[agent]} model catalog`, load)
      : await load();
    if (loaded.warning) {
      log(loaded.warning);
    }
    return loaded.catalog;
  };

  const resolved: WorkerSettingsByAgent = {};
  for (const agent of request.agents) {
    const flags = request.flags[agent] ?? {};
    const saved = request.saved[agent];
    if (flags.effort !== undefined && flags.model === undefined) {
      throw new Error(`--${agent}-worker-effort requires --${agent}-worker-model.`);
    }

    if (flags.model !== undefined) {
      resolved[agent] = settingsFromCatalog(agent, await loadCatalog(agent), flags.model, flags.effort);
    } else if (request.prompter) {
      resolved[agent] = await chooseWorkerSettings(
        agent,
        await loadCatalog(agent),
        saved,
        request.prompter,
      );
    } else if (saved) {
      log(`Using the saved ${AGENT_LABELS[agent]} worker settings: ${describeWorkerSettings(saved)}.`);
      resolved[agent] = saved;
    } else {
      throw new Error(
        `No ${AGENT_LABELS[agent]} worker model is configured. Run the installer in a terminal to choose one, or pass --${agent}-worker-model <id> [--${agent}-worker-effort <level>].`,
      );
    }
  }
  return resolved as Record<AgentName, WorkerSettings>;
}
