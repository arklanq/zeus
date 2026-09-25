import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AgentName } from "./installer.ts";

export type WorkerModel = {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort?: string;
  isDefault?: boolean;
};

export type WorkerModelCatalog = {
  source: string;
  models: WorkerModel[];
};

export interface WorkerModelCatalogProvider {
  getCatalog(): Promise<WorkerModelCatalog>;
}

export type BundledCatalogs = {
  capturedAt: string;
  catalogs: Record<AgentName, WorkerModelCatalog>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateCatalog(value: unknown, label: string): WorkerModelCatalog {
  if (!isObject(value) || typeof value.source !== "string" || !Array.isArray(value.models)) {
    throw new Error(`${label} is not a model catalog.`);
  }
  const models = value.models.map((model): WorkerModel => {
    if (
      !isObject(model) ||
      typeof model.id !== "string" ||
      model.id === "" ||
      typeof model.displayName !== "string" ||
      !isStringArray(model.efforts) ||
      (model.defaultEffort !== undefined && typeof model.defaultEffort !== "string") ||
      (model.isDefault !== undefined && typeof model.isDefault !== "boolean")
    ) {
      throw new Error(`${label} contains an invalid model entry.`);
    }
    return {
      id: model.id,
      displayName: model.displayName,
      efforts: model.efforts,
      ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
      ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
    };
  });
  if (models.length === 0) {
    throw new Error(`${label} does not list any models.`);
  }
  return { source: value.source, models };
}

export function validateBundledCatalogs(value: unknown): BundledCatalogs {
  if (!isObject(value) || typeof value.capturedAt !== "string" || !isObject(value.catalogs)) {
    throw new Error("The bundled model catalog is invalid.");
  }
  return {
    capturedAt: value.capturedAt,
    catalogs: {
      claude: validateCatalog(value.catalogs.claude, "The bundled Claude catalog"),
      codex: validateCatalog(value.catalogs.codex, "The bundled Codex catalog"),
    },
  };
}

// Codex.

const CODEX_APP_BUNDLES = ["Codex.app", "ChatGPT.app"];
const CODEX_BUNDLE_RUNTIMES = [
  join("Contents", "Resources", "codex"),
  join("Contents", "Resources", "codex-cli", "bin", "codex"),
];
const CODEX_BUNDLE_ID = "com.openai.codex";

export type CodexRuntimeEnvironment = {
  homeDir: string;
  platform: NodeJS.Platform;
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
  findAppBundles: () => string[];
};

function spotlightAppBundles(): string[] {
  try {
    const result = Bun.spawnSync(
      ["mdfind", `kMDItemCFBundleIdentifier == "${CODEX_BUNDLE_ID}"`],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".app"));
  } catch {
    return [];
  }
}

export function defaultCodexRuntimeEnvironment(homeDir: string): CodexRuntimeEnvironment {
  return {
    homeDir,
    platform: process.platform,
    which: (command) => Bun.which(command),
    exists: existsSync,
    findAppBundles: spotlightAppBundles,
  };
}

export function findCodexRuntime(environment: CodexRuntimeEnvironment): string | undefined {
  const fromPath = environment.which("codex");
  if (fromPath) {
    return fromPath;
  }
  if (environment.platform !== "darwin") {
    return undefined;
  }

  const bundles = [
    ...["/Applications", join(environment.homeDir, "Applications")].flatMap((directory) =>
      CODEX_APP_BUNDLES.map((bundle) => join(directory, bundle)),
    ),
    ...environment.findAppBundles(),
  ];
  for (const bundle of bundles) {
    for (const runtime of CODEX_BUNDLE_RUNTIMES) {
      const path = join(bundle, runtime);
      if (environment.exists(path)) {
        return path;
      }
    }
  }
  return undefined;
}

export function parseCodexModelList(result: unknown): {
  models: WorkerModel[];
  nextCursor: string | null;
} {
  if (!isObject(result) || !Array.isArray(result.data)) {
    throw new Error("Codex model/list returned an unexpected response.");
  }
  const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
  const models = result.data.flatMap((model): WorkerModel[] => {
    if (
      !isObject(model) ||
      typeof model.model !== "string" ||
      typeof model.displayName !== "string" ||
      !Array.isArray(model.supportedReasoningEfforts)
    ) {
      throw new Error("Codex model/list returned an invalid model entry.");
    }
    if (model.hidden === true) {
      return [];
    }
    const efforts = model.supportedReasoningEfforts.map((option) => {
      if (!isObject(option) || typeof option.reasoningEffort !== "string") {
        throw new Error("Codex model/list returned an invalid reasoning effort.");
      }
      return option.reasoningEffort;
    });
    return [
      {
        id: model.model,
        displayName: model.displayName,
        efforts,
        ...(typeof model.defaultReasoningEffort === "string"
          ? { defaultEffort: model.defaultReasoningEffort }
          : {}),
        isDefault: model.isDefault === true,
      },
    ];
  });
  return { models, nextCursor };
}

async function* jsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          // The app-server protocol is line-delimited JSON; skip anything else.
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
}

export class CodexModelCatalogProvider implements WorkerModelCatalogProvider {
  constructor(
    private readonly runtimePath: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async getCatalog(): Promise<WorkerModelCatalog> {
    const child = Bun.spawn([this.runtimePath, "app-server"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const messages = jsonLines(child.stdout);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.timeoutMs);
    let nextId = 1;

    const send = async (message: JsonObject): Promise<void> => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      await child.stdin.flush();
    };
    const request = async (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++;
      await send({ id, method, params });
      while (true) {
        const next = await messages.next();
        if (next.done) {
          throw new Error(
            timedOut
              ? `Codex app-server did not answer ${method} within ${this.timeoutMs / 1000} s.`
              : `Codex app-server exited before answering ${method}.`,
          );
        }
        const message = next.value;
        if (!isObject(message) || message.id !== id) {
          continue;
        }
        if (isObject(message.error)) {
          throw new Error(`Codex app-server ${method} failed: ${String(message.error.message)}`);
        }
        return message.result;
      }
    };

    try {
      await request("initialize", {
        clientInfo: { name: "zeus-installer", title: "Zeus installer", version: "1" },
        capabilities: null,
      });
      await send({ method: "initialized" });

      const models: WorkerModel[] = [];
      let cursor: string | null = null;
      do {
        const page = parseCodexModelList(
          await request("model/list", { cursor, includeHidden: false }),
        );
        models.push(...page.models);
        cursor = page.nextCursor;
      } while (cursor);

      if (models.length === 0) {
        throw new Error("Codex model/list did not return any models.");
      }
      return { source: `Codex app-server model/list (${this.runtimePath})`, models };
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
}

// Claude.

export const CLAUDE_MODELS_URL = "https://platform.claude.com/docs/en/models/overview.md";
export const CLAUDE_EFFORT_URL = "https://platform.claude.com/docs/en/build-with-claude/effort.md";

const BASE_EFFORTS = ["low", "medium", "high"];
const EXTRA_EFFORTS = ["xhigh", "max"];

function plainMarkdown(cell: string): string {
  return cell
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .replace(/\*\*/g, "")
    .trim();
}

function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error(`The Claude models page has no "${heading}" section.`);
  }
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (!trimmed.startsWith("|")) {
      if (rows.length > 0) {
        break;
      }
      continue;
    }
    const cells = trimmed.split("|").slice(1, -1).map(plainMarkdown);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      continue;
    }
    rows.push(cells);
  }
  return rows;
}

function effortAvailability(effortMarkdown: string, effort: string): Set<string> {
  const row = effortMarkdown
    .split(/\r?\n/)
    .find((line) => new RegExp(`^\\|\\s*\`${effort}\`\\s*\\|`).test(line.trim()));
  const description = row?.split("|")[2] ?? "";
  const models = description.match(/Available on (.+?)\.(?!\d)/)?.[1];
  if (!models) {
    throw new Error(`The Claude effort page does not list models for \`${effort}\`.`);
  }
  return new Set(
    models
      .split(/,\s*(?:and\s+)?|\s+and\s+/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function parseClaudeCatalog(overviewMarkdown: string, effortMarkdown: string): WorkerModel[] {
  const rows = tableRows(overviewMarkdown, "## Compare models");
  const header = rows[0];
  const row = (label: string): string[] => {
    const found = rows.find((cells) => cells[0] === label);
    if (!found) {
      throw new Error(`The Claude models table has no "${label}" row.`);
    }
    return found;
  };
  if (!header || header.length < 2) {
    throw new Error("The Claude models table is missing.");
  }
  const ids = row("Claude API ID");
  const defaults = row("Default effort");
  const extraAvailability = EXTRA_EFFORTS.map(
    (effort) => [effort, effortAvailability(effortMarkdown, effort)] as const,
  );

  return header.slice(1).map((displayName, index): WorkerModel => {
    const id = ids[index + 1];
    const defaultEffort = defaults[index + 1];
    if (!id || !/^claude-[a-z0-9.-]+$/.test(id) || defaultEffort === undefined) {
      throw new Error(`The Claude models table has an unexpected entry for ${displayName}.`);
    }
    const supportsEffort = BASE_EFFORTS.includes(defaultEffort) || EXTRA_EFFORTS.includes(defaultEffort);
    const efforts = supportsEffort
      ? [
          ...BASE_EFFORTS,
          ...extraAvailability
            .filter(([, models]) => models.has(displayName))
            .map(([effort]) => effort),
        ]
      : [];
    return {
      id,
      displayName,
      efforts,
      ...(supportsEffort ? { defaultEffort } : {}),
    };
  });
}

export class ClaudeModelCatalogProvider implements WorkerModelCatalogProvider {
  constructor(
    private readonly fetchText: (url: string) => Promise<string> = fetchMarkdown,
  ) {}

  async getCatalog(): Promise<WorkerModelCatalog> {
    const [overview, effort] = await Promise.all([
      this.fetchText(CLAUDE_MODELS_URL),
      this.fetchText(CLAUDE_EFFORT_URL),
    ]);
    return {
      source: `Anthropic documentation (${CLAUDE_MODELS_URL})`,
      models: parseClaudeCatalog(overview, effort),
    };
  }
}

async function fetchMarkdown(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.text();
}
