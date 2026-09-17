import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type AgentName = "claude" | "codex";

type JsonObject = Record<string, unknown>;

type CodexFeatureState = {
  configFileExisted: boolean;
  featureKey: "hooks" | "codex_hooks";
  featureTableExisted: boolean;
  previousValue: boolean | null;
};

type CodexHookTrustState = {
  key: string;
  trustedHash: string;
  stateTableExisted: boolean;
  previousTrustedHash: string | null;
};

type InstallManifest = {
  version: 1 | 2;
  agent: AgentName;
  hooksFileExisted: boolean;
  codexFeature?: CodexFeatureState;
  codexHookTrust?: CodexHookTrustState;
};

type WriteOperation = {
  kind: "write";
  path: string;
  content: string | Uint8Array;
  mode?: number;
  preserveSymlink?: boolean;
  description: string;
};

type DeleteOperation = {
  kind: "delete";
  path: string;
  description: string;
};

type Operation = WriteOperation | DeleteOperation;

type InstallerOptions = {
  action: "install" | "uninstall";
  agents: AgentName[];
  dryRun: boolean;
  homeDir: string;
  packageDir: string;
  binarySourcePath?: string;
  binaryInstallDir?: string;
  claudeConfigDir?: string;
  codexHome?: string;
  log?: (message: string) => void;
};

type AgentPaths = {
  agent: AgentName;
  skillSourcePath: string;
  binaryPath: string;
  skillDir: string;
  skillPath: string;
  manifestPath: string;
  hooksConfigPath: string;
  hookEvent: "PostCompact" | "SessionStart";
  hookMatcher: string;
  codexConfigPath?: string;
  canonicalizeCodexHome?: boolean;
};

type InstalledHookEntry = {
  text: string;
  groupIndex: number;
  handlerIndex: number;
  entry: JsonObject;
  stateMoves: CodexHookStateKeyMove[];
  removedManagedStateKeys: string[];
};

type CodexHookStateKeyMove = {
  from: string;
  to: string;
};

const MANIFEST_FILENAME = ".zeus-install.json";
const SKILL_FILENAME = "SKILL.md";
const BINARY_FILENAME = "zeus";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formattingOptions(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indentedLine = text.match(/^(\s+)["}]/m)?.[1] ?? "  ";
  const insertSpaces = !indentedLine.includes("\t");

  return {
    eol,
    insertSpaces,
    tabSize: insertSpaces ? Math.max(1, indentedLine.length) : 1,
  };
}

function parseJsonObject(text: string, path: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    const error = errors[0]!;
    throw new Error(
      `Cannot safely edit ${path}: ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
    );
  }

  if (!isObject(value)) {
    throw new Error(`Cannot safely edit ${path}: the root value must be an object.`);
  }

  return value;
}

function applyJsonModification(
  text: string,
  path: (string | number)[],
  value: unknown,
  isArrayInsertion = false,
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: formattingOptions(text),
      isArrayInsertion,
    }),
  );
}

function parseJsonTree(text: string, path: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (!root || errors.length > 0) {
    parseJsonObject(text, path);
    throw new Error(`Cannot safely edit ${path}: the JSON structure is unavailable.`);
  }

  return root;
}

function findComma(text: string, start: number, end: number): {
  offset: number;
  length: number;
} {
  const scanner = createScanner(text, false);
  scanner.setPosition(start);

  while (scanner.getPosition() < end) {
    scanner.scan();
    const tokenOffset = scanner.getTokenOffset();
    const tokenLength = scanner.getTokenLength();
    if (
      tokenOffset < end &&
      tokenLength === 1 &&
      text[tokenOffset] === ","
    ) {
      return {
        offset: tokenOffset,
        length: tokenLength,
      };
    }
    if (tokenLength === 0) {
      break;
    }
  }

  throw new Error("Cannot safely remove a JSON array item: separator not found.");
}

function deleteJsonArrayItem(
  text: string,
  arrayPath: (string | number)[],
  index: number,
  configPath: string,
): string {
  const root = parseJsonTree(text, configPath);
  const array = findNodeAtLocation(root, arrayPath);
  const items = array?.type === "array" ? (array.children ?? []) : [];
  const item = items[index];

  if (!array || array.type !== "array" || !item || items.length < 2) {
    throw new Error(`Cannot safely edit ${configPath}: expected a populated JSON array.`);
  }

  if (index < items.length - 1) {
    const next = items[index + 1]!;
    const comma = findComma(text, item.offset + item.length, next.offset);
    return `${text.slice(0, item.offset)}${text.slice(comma.offset + comma.length)}`;
  }

  const previous = items[index - 1]!;
  const comma = findComma(text, previous.offset + previous.length, item.offset);
  return `${text.slice(0, comma.offset)}${text.slice(item.offset + item.length)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isManagedHookCommand(value: unknown, paths: AgentPaths): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.replaceAll("\\", "/");
  const skillPath = paths.skillPath.replaceAll("\\", "/");
  const expectedSuffix = ` hook --agent ${paths.agent} --skill ${shellQuote(skillPath)}`;
  if (!normalized.endsWith(expectedSuffix)) {
    return false;
  }

  const executable = normalized.slice(0, -expectedSuffix.length);
  return executable.startsWith("'") && executable.endsWith("/zeus'");
}

function canonicalHookEntry(paths: AgentPaths): JsonObject {
  const hook = {
    type: "command",
    command: `${shellQuote(paths.binaryPath)} hook --agent ${paths.agent} --skill ${shellQuote(paths.skillPath)}`,
    timeout: 30,
    ...(paths.agent === "codex" ? { additionalContextLimit: 0 } : {}),
  };

  return {
    matcher: paths.hookMatcher,
    hooks: [hook],
  };
}

function readHookEntries(text: string, paths: AgentPaths): unknown[] {
  const root = parseJsonObject(text, paths.hooksConfigPath);
  const hooks = root.hooks;

  if (hooks !== undefined && !isObject(hooks)) {
    throw new Error(
      `Cannot safely edit ${paths.hooksConfigPath}: "hooks" must be an object.`,
    );
  }

  const existing = isObject(hooks) ? hooks[paths.hookEvent] : undefined;
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error(
      `Cannot safely edit ${paths.hooksConfigPath}: hooks.${paths.hookEvent} must be an array.`,
    );
  }

  return Array.isArray(existing) ? existing : [];
}

function removeManagedHookHandlers(text: string, paths: AgentPaths): string {
  const entries = readHookEntries(text, paths);
  let updated = text;
  let entryCount = entries.length;

  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      continue;
    }

    const managedIndexes = entry.hooks.flatMap((hook, hookIndex) =>
      isObject(hook) && isManagedHookCommand(hook.command, paths)
        ? [hookIndex]
        : [],
    );
    if (managedIndexes.length === 0) {
      continue;
    }

    if (managedIndexes.length === entry.hooks.length) {
      if (entryCount === 1) {
        updated = applyJsonModification(
          updated,
          ["hooks", paths.hookEvent],
          undefined,
        );
      } else {
        updated = deleteJsonArrayItem(
          updated,
          ["hooks", paths.hookEvent],
          entryIndex,
          paths.hooksConfigPath,
        );
      }
      entryCount -= 1;
      continue;
    }

    for (const hookIndex of managedIndexes.toReversed()) {
      updated = deleteJsonArrayItem(
        updated,
        ["hooks", paths.hookEvent, entryIndex, "hooks"],
        hookIndex,
        paths.hooksConfigPath,
      );
    }
  }

  if (updated === text) {
    return text;
  }

  const root = parseJsonObject(updated, paths.hooksConfigPath);
  if (isObject(root.hooks) && Object.keys(root.hooks).length === 0) {
    updated = applyJsonModification(updated, ["hooks"], undefined);
    if (updated.trim() === "") {
      return "{}\n";
    }
  }

  return updated;
}

async function installHookEntry(
  text: string,
  paths: AgentPaths,
): Promise<InstalledHookEntry> {
  const existingEntries = readHookEntries(text, paths);
  const existingManagedHandlers = existingEntries.flatMap((entry, groupIndex) => {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks.flatMap((hook, handlerIndex) =>
      isObject(hook) && isManagedHookCommand(hook.command, paths)
        ? [{ groupIndex, handlerIndex }]
        : [],
    );
  });
  const canonical = canonicalHookEntry(paths);
  const canonicalHandlers = canonical.hooks;
  if (!Array.isArray(canonicalHandlers) || !isObject(canonicalHandlers[0])) {
    throw new Error("Cannot install hook: canonical hook is invalid.");
  }

  if (existingManagedHandlers.length === 1) {
    const { groupIndex, handlerIndex } = existingManagedHandlers[0]!;
    const existingEntry = existingEntries[groupIndex];
    const standalone =
      isObject(existingEntry) &&
      Array.isArray(existingEntry.hooks) &&
      existingEntry.hooks.length === 1;
    if (paths.agent === "codex" || standalone) {
      const updatedText = standalone
        ? applyJsonModification(
            text,
            ["hooks", paths.hookEvent, groupIndex],
            canonical,
          )
        : applyJsonModification(
            text,
            ["hooks", paths.hookEvent, groupIndex, "hooks", handlerIndex],
            canonicalHandlers[0],
          );
      const installedEntry = readHookEntries(updatedText, paths)[groupIndex];
      if (!isObject(installedEntry)) {
        throw new Error("Cannot install hook: updated hook group is invalid.");
      }
      return {
        text: updatedText,
        groupIndex,
        handlerIndex: standalone ? 0 : handlerIndex,
        entry: installedEntry,
        stateMoves: [],
        removedManagedStateKeys: [],
      };
    }
  }

  const updated = removeManagedHookHandlers(text, paths);
  const currentEntries = readHookEntries(updated, paths);
  const groupIndex = currentEntries.length;
  const textWithHook = currentEntries.length > 0
    ? applyJsonModification(
        updated,
        ["hooks", paths.hookEvent, currentEntries.length],
        canonical,
        true,
      )
    : applyJsonModification(updated, ["hooks", paths.hookEvent], [canonical]);

  return {
    text: textWithHook,
    groupIndex,
    handlerIndex: 0,
    entry: canonical,
    stateMoves: await codexHookStateKeyMoves(text, paths),
    removedManagedStateKeys: await codexManagedHookStateKeys(text, paths),
  };
}

function uninstallHookEntry(text: string, paths: AgentPaths): string {
  return removeManagedHookHandlers(text, paths);
}

function splitLines(text: string): { lines: string[]; eol: string; trailing: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return {
    lines: text === "" ? [] : text.split(/\r?\n/),
    eol,
    trailing: text.endsWith("\n"),
  };
}

function joinLines(lines: string[], eol: string, trailing: boolean): string {
  while (lines.at(-1) === "") {
    lines.pop();
  }

  const content = lines.join(eol);
  return content && trailing ? `${content}${eol}` : content;
}

function parseToml(text: string, path: string): JsonObject {
  if (text.trim() === "") {
    return {};
  }

  try {
    const parsed = Bun.TOML.parse(text) as unknown;
    if (!isObject(parsed)) {
      throw new Error("the root value must be a table");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot safely edit ${path}: invalid TOML (${message}).`);
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

async function canonicalizePendingDirectory(path: string): Promise<string> {
  let current = path;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return join(await realpath(current), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function codexHooksIdentityPath(paths: AgentPaths): Promise<string> {
  const hooksDirectory = paths.canonicalizeCodexHome
    ? await canonicalizePendingDirectory(dirname(paths.hooksConfigPath))
    : dirname(paths.hooksConfigPath);
  return join(hooksDirectory, basename(paths.hooksConfigPath));
}

async function codexHookTrustIdentity(
  paths: AgentPaths,
  installedHook: InstalledHookEntry,
): Promise<{ key: string; trustedHash: string }> {
  const handlers = installedHook.entry.hooks;
  const handler = Array.isArray(handlers) ? handlers[installedHook.handlerIndex] : undefined;
  if (!isObject(handler)) {
    throw new Error("Cannot calculate Codex hook trust: installed hook is invalid.");
  }
  const matcher = installedHook.entry.matcher;
  if (matcher !== undefined && typeof matcher !== "string") {
    throw new Error("Cannot calculate Codex hook trust: hook matcher is invalid.");
  }

  const identity = canonicalJson({
    event_name: "session_start",
    ...(typeof matcher === "string" ? { matcher } : {}),
    hooks: [{ ...handler, async: false }],
  });
  const trustedHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;

  const hooksPath = await codexHooksIdentityPath(paths);
  return {
    key: `${hooksPath}:session_start:${installedHook.groupIndex}:${installedHook.handlerIndex}`,
    trustedHash,
  };
}

async function codexHookStateKeyMoves(
  text: string,
  paths: AgentPaths,
): Promise<CodexHookStateKeyMove[]> {
  if (paths.agent !== "codex") {
    return [];
  }

  const entries = readHookEntries(text, paths);
  const hooksPath = await codexHooksIdentityPath(paths);
  const moves: CodexHookStateKeyMove[] = [];
  let removedGroups = 0;

  entries.forEach((entry, groupIndex) => {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      return;
    }
    const managedHandlers = entry.hooks.map((hook) =>
      isObject(hook) && isManagedHookCommand(hook.command, paths),
    );
    if (managedHandlers.length > 0 && managedHandlers.every(Boolean)) {
      removedGroups += 1;
      return;
    }

    let removedHandlers = 0;
    managedHandlers.forEach((managed, handlerIndex) => {
      if (managed) {
        removedHandlers += 1;
        return;
      }
      const newGroupIndex = groupIndex - removedGroups;
      const newHandlerIndex = handlerIndex - removedHandlers;
      if (newGroupIndex === groupIndex && newHandlerIndex === handlerIndex) {
        return;
      }
      moves.push({
        from: `${hooksPath}:session_start:${groupIndex}:${handlerIndex}`,
        to: `${hooksPath}:session_start:${newGroupIndex}:${newHandlerIndex}`,
      });
    });
  });

  return moves;
}

async function codexManagedHookStateKeys(
  text: string,
  paths: AgentPaths,
): Promise<string[]> {
  if (paths.agent !== "codex") {
    return [];
  }

  const entries = readHookEntries(text, paths);
  const hooksPath = await codexHooksIdentityPath(paths);
  return entries.flatMap((entry, groupIndex) => {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks.flatMap((hook, handlerIndex) =>
      isObject(hook) && isManagedHookCommand(hook.command, paths)
        ? [`${hooksPath}:session_start:${groupIndex}:${handlerIndex}`]
        : [],
    );
  });
}

function readCodexHookTrustEntry(
  text: string,
  path: string,
  key: string,
): { exists: boolean; trustedHash: string | null } {
  const parsed = parseToml(text, path);
  const hooks = parsed.hooks;
  if (hooks === undefined) {
    return { exists: false, trustedHash: null };
  }
  if (!isObject(hooks)) {
    throw new Error(`Cannot safely edit ${path}: "hooks" must be a table.`);
  }

  const state = hooks.state;
  if (state === undefined) {
    return { exists: false, trustedHash: null };
  }
  if (!isObject(state)) {
    throw new Error(`Cannot safely edit ${path}: hooks.state must be a table.`);
  }

  const entry = state[key];
  if (entry === undefined) {
    return { exists: false, trustedHash: null };
  }
  if (!isObject(entry)) {
    throw new Error(`Cannot safely edit ${path}: Codex hook state must be a table.`);
  }

  const trustedHash = entry.trusted_hash;
  if (trustedHash !== undefined && typeof trustedHash !== "string") {
    throw new Error(`Cannot safely edit ${path}: hook trusted_hash must be a string.`);
  }
  return {
    exists: true,
    trustedHash: typeof trustedHash === "string" ? trustedHash : null,
  };
}

function findTomlTable(
  lines: string[],
  header: string,
): { start: number; end: number } | undefined {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\s*${escapedHeader}\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start < 0) {
    return undefined;
  }
  const nextTable = lines.findIndex(
    (line, index) =>
      index > start &&
      /^\s*\[(?:\[[^\]]+]\]|[^\]]+)]\s*(?:#.*)?$/.test(line),
  );
  return { start, end: nextTable < 0 ? lines.length : nextTable };
}

function codexHookStateHeader(key: string): string {
  return `[hooks.state.${JSON.stringify(key)}]`;
}

const TRUSTED_HASH_LINE = /^(\s*trusted_hash\s*=\s*)(?:"(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$/;

function setCodexHookTrustedHash(
  text: string,
  path: string,
  key: string,
  trustedHash: string,
): string {
  const current = readCodexHookTrustEntry(text, path, key);
  const { lines, eol, trailing } = splitLines(text);
  const header = codexHookStateHeader(key);
  const table = findTomlTable(lines, header);

  if (current.exists) {
    if (!table) {
      throw new Error(
        `Cannot safely edit ${path}: use a dedicated ${header} table for hook state.`,
      );
    }
    const hashIndex = lines.findIndex(
      (line, index) => index > table.start && index < table.end && TRUSTED_HASH_LINE.test(line),
    );
    if (current.trustedHash !== null && hashIndex < 0) {
      throw new Error(`Cannot safely edit ${path}: hook trusted_hash must be single-line.`);
    }
    if (hashIndex >= 0) {
      lines[hashIndex] = lines[hashIndex]?.replace(
        TRUSTED_HASH_LINE,
        `$1${JSON.stringify(trustedHash)}$2`,
      ) ?? "";
    } else {
      lines.splice(table.end, 0, `trusted_hash = ${JSON.stringify(trustedHash)}`);
    }
  } else {
    if (lines.length > 0 && lines.some((line) => line.trim() !== "")) {
      lines.push("");
    }
    lines.push(header, `trusted_hash = ${JSON.stringify(trustedHash)}`);
  }

  return joinLines(lines, eol, trailing || text.length === 0);
}

function restoreCodexHookTrust(
  text: string,
  path: string,
  state: CodexHookTrustState,
): string {
  const current = readCodexHookTrustEntry(text, path, state.key);
  if (!current.exists || current.trustedHash !== state.trustedHash) {
    return text;
  }
  if (state.previousTrustedHash !== null) {
    return setCodexHookTrustedHash(text, path, state.key, state.previousTrustedHash);
  }

  const { lines, eol, trailing } = splitLines(text);
  const table = findTomlTable(lines, codexHookStateHeader(state.key));
  if (!table) {
    return text;
  }
  const hashIndex = lines.findIndex(
    (line, index) => index > table.start && index < table.end && TRUSTED_HASH_LINE.test(line),
  );
  if (hashIndex < 0) {
    return text;
  }
  lines.splice(hashIndex, 1);

  const refreshed = findTomlTable(lines, codexHookStateHeader(state.key));
  if (
    refreshed &&
    !state.stateTableExisted &&
    lines.slice(refreshed.start + 1, refreshed.end).every((line) => line.trim() === "")
  ) {
    lines.splice(refreshed.start, refreshed.end - refreshed.start);
  }
  return joinLines(lines, eol, trailing);
}

function removeCodexHookStateTables(
  text: string,
  path: string,
  keys: string[],
): string {
  let updated = text;
  for (const key of keys) {
    const current = readCodexHookTrustEntry(updated, path, key);
    if (!current.exists) {
      continue;
    }
    const { lines, eol, trailing } = splitLines(updated);
    const header = codexHookStateHeader(key);
    const table = findTomlTable(lines, header);
    if (!table) {
      throw new Error(
        `Cannot safely edit ${path}: use a dedicated ${header} table for hook state.`,
      );
    }
    lines.splice(table.start, table.end - table.start);
    updated = joinLines(lines, eol, trailing);
  }
  return updated;
}

function migrateCodexHookStateKeys(
  text: string,
  path: string,
  moves: CodexHookStateKeyMove[],
): string {
  if (moves.length === 0) {
    return text;
  }

  const parsed = parseToml(text, path);
  const hooks = parsed.hooks;
  const state = isObject(hooks) && isObject(hooks.state) ? hooks.state : {};
  const activeMoves = moves.filter(({ from }) => state[from] !== undefined);
  if (activeMoves.length === 0) {
    return text;
  }

  const sourceKeys = new Set(activeMoves.map(({ from }) => from));
  for (const { to } of activeMoves) {
    if (state[to] !== undefined && !sourceKeys.has(to)) {
      throw new Error(
        `Cannot safely edit ${path}: hook state migration would overwrite ${to}.`,
      );
    }
  }

  const { lines, eol, trailing } = splitLines(text);
  for (const { from, to } of activeMoves) {
    const sourceHeader = codexHookStateHeader(from);
    const table = findTomlTable(lines, sourceHeader);
    if (!table) {
      throw new Error(
        `Cannot safely edit ${path}: use a dedicated ${sourceHeader} table for hook state.`,
      );
    }
    lines[table.start] = lines[table.start]!.replace(
      sourceHeader,
      codexHookStateHeader(to),
    );
  }
  return joinLines(lines, eol, trailing);
}

function installCodexHookTrust(
  text: string,
  path: string,
  identity: { key: string; trustedHash: string },
  existingState?: CodexHookTrustState,
  stateMoves: CodexHookStateKeyMove[] = [],
  removedManagedStateKeys: string[] = [],
): { text: string; state: CodexHookTrustState } {
  let updated = text;
  if (existingState && existingState.key !== identity.key) {
    updated = restoreCodexHookTrust(updated, path, existingState);
  }
  updated = removeCodexHookStateTables(
    updated,
    path,
    removedManagedStateKeys.filter((key) => key !== existingState?.key),
  );
  updated = migrateCodexHookStateKeys(updated, path, stateMoves);

  const current = readCodexHookTrustEntry(updated, path, identity.key);
  const state =
    existingState?.key === identity.key &&
    current.trustedHash === existingState.trustedHash
      ? { ...existingState, trustedHash: identity.trustedHash }
      : {
          key: identity.key,
          trustedHash: identity.trustedHash,
          stateTableExisted: current.exists,
          previousTrustedHash: current.trustedHash,
        };

  return {
    text: setCodexHookTrustedHash(updated, path, identity.key, identity.trustedHash),
    state,
  };
}

function findFeaturesTable(lines: string[]): { start: number; end: number } | undefined {
  return findTomlTable(lines, "[features]");
}

function installCodexFeature(
  text: string,
  path: string,
  configFileExisted: boolean,
): { text: string; state: CodexFeatureState } {
  const parsed = parseToml(text, path);
  const features = parsed.features;
  if (features !== undefined && !isObject(features)) {
    throw new Error(`Cannot safely edit ${path}: "features" must be a table.`);
  }

  const { lines, eol, trailing } = splitLines(text);
  const table = findFeaturesTable(lines);
  if (!table && features !== undefined) {
    throw new Error(
      `Cannot safely edit ${path}: inline "features" tables are not changed automatically.`,
    );
  }

  const featureTable = isObject(features) ? features : {};
  const featureKey =
    typeof featureTable.hooks === "boolean"
      ? "hooks"
      : typeof featureTable.codex_hooks === "boolean"
        ? "codex_hooks"
        : "hooks";
  const current = featureTable[featureKey];
  if (current !== undefined && typeof current !== "boolean") {
    throw new Error(`Cannot safely edit ${path}: features.${featureKey} must be boolean.`);
  }

  if (table) {
    const keyPattern = new RegExp(`^(\\s*)${featureKey}(\\s*=\\s*)(true|false)(.*)$`);
    const keyIndex = lines.findIndex(
      (line, index) => index > table.start && index < table.end && keyPattern.test(line),
    );
    if (keyIndex >= 0) {
      lines[keyIndex] = lines[keyIndex]?.replace(keyPattern, "$1" + featureKey + "$2true$4") ?? "";
    } else {
      lines.splice(table.end, 0, `${featureKey} = true`);
    }
  } else {
    if (lines.length > 0 && lines.some((line) => line.trim() !== "")) {
      lines.push("");
    }
    lines.push("[features]", `${featureKey} = true`);
  }

  return {
    text: joinLines(lines, eol, trailing || text.length === 0),
    state: {
      configFileExisted,
      featureKey,
      featureTableExisted: table !== undefined,
      previousValue: typeof current === "boolean" ? current : null,
    },
  };
}

function restoreCodexFeature(
  text: string,
  path: string,
  state: CodexFeatureState,
): string {
  parseToml(text, path);
  const { lines, eol, trailing } = splitLines(text);
  const table = findFeaturesTable(lines);
  if (!table) {
    return text;
  }

  const keyPattern = new RegExp(
    `^(\\s*)${state.featureKey}(\\s*=\\s*)(true|false)(.*)$`,
  );
  const keyIndex = lines.findIndex(
    (line, index) => index > table.start && index < table.end && keyPattern.test(line),
  );
  if (keyIndex < 0) {
    return text;
  }

  if (state.previousValue === null) {
    lines.splice(keyIndex, 1);
    const refreshedTable = findFeaturesTable(lines);
    if (refreshedTable && !state.featureTableExisted) {
      const hasValues = lines
        .slice(refreshedTable.start + 1, refreshedTable.end)
        .some((line) => line.trim() !== "" && !/^\s*#/.test(line));
      if (!hasValues) {
        lines.splice(refreshedTable.start, 1);
      }
    }
  } else {
    lines[keyIndex] =
      lines[keyIndex]?.replace(
        keyPattern,
        `$1${state.featureKey}$2${String(state.previousValue)}$4`,
      ) ?? "";
  }

  return joinLines(lines, eol, trailing);
}

async function readOptional(path: string): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

async function readManifest(path: string): Promise<InstallManifest | undefined> {
  const file = await readOptional(path);
  if (!file.exists) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    throw new Error(`Cannot safely continue: ${path} is not valid JSON.`);
  }
  if (
    !isObject(value) ||
    (value.version !== 1 && value.version !== 2) ||
    (value.agent !== "claude" && value.agent !== "codex") ||
    typeof value.hooksFileExisted !== "boolean"
  ) {
    throw new Error(`Cannot safely continue: ${path} is not a Zeus install manifest.`);
  }

  if (value.codexFeature !== undefined) {
    const feature = value.codexFeature;
    if (
      !isObject(feature) ||
      typeof feature.configFileExisted !== "boolean" ||
      (feature.featureKey !== "hooks" && feature.featureKey !== "codex_hooks") ||
      typeof feature.featureTableExisted !== "boolean" ||
      (feature.previousValue !== null && typeof feature.previousValue !== "boolean")
    ) {
      throw new Error(`Cannot safely continue: ${path} has invalid Codex ownership data.`);
    }
  }

  if (value.codexHookTrust !== undefined) {
    const trust = value.codexHookTrust;
    if (
      !isObject(trust) ||
      typeof trust.key !== "string" ||
      typeof trust.trustedHash !== "string" ||
      typeof trust.stateTableExisted !== "boolean" ||
      (trust.previousTrustedHash !== null &&
        typeof trust.previousTrustedHash !== "string")
    ) {
      throw new Error(`Cannot safely continue: ${path} has invalid Codex hook trust data.`);
    }
  }

  return value as InstallManifest;
}

function agentPaths(options: InstallerOptions, agent: AgentName): AgentPaths {
  const rootDir = resolve(
    agent === "claude"
      ? options.claudeConfigDir ?? join(options.homeDir, ".claude")
      : options.codexHome ?? join(options.homeDir, ".codex"),
  );
  const skillDir = join(rootDir, "skills", "zeus");
  if (basename(skillDir) !== "zeus" || basename(dirname(skillDir)) !== "skills") {
    throw new Error(`Refusing unsafe Zeus skill directory: ${skillDir}`);
  }

  return {
    agent,
    skillSourcePath: join(options.packageDir, "dist", agent, SKILL_FILENAME),
    binaryPath: join(
      resolve(options.binaryInstallDir ?? join(options.homeDir, ".local", "bin")),
      BINARY_FILENAME,
    ),
    skillDir,
    skillPath: join(skillDir, SKILL_FILENAME),
    manifestPath: join(skillDir, MANIFEST_FILENAME),
    hooksConfigPath:
      agent === "claude" ? join(rootDir, "settings.json") : join(rootDir, "hooks.json"),
    hookEvent: agent === "claude" ? "PostCompact" : "SessionStart",
    hookMatcher: agent === "claude" ? "manual|auto" : "compact",
    codexConfigPath: agent === "codex" ? join(rootDir, "config.toml") : undefined,
    canonicalizeCodexHome: agent === "codex" && options.codexHome !== undefined,
  };
}

async function prepareInstall(paths: AgentPaths): Promise<Operation[]> {
  const skillSource = await readFile(paths.skillSourcePath, "utf8");
  const existingManifest = await readManifest(paths.manifestPath);
  if (existingManifest && existingManifest.agent !== paths.agent) {
    throw new Error(
      `Cannot safely continue: ${paths.manifestPath} belongs to ${existingManifest.agent}.`,
    );
  }
  const hooksConfig = await readOptional(paths.hooksConfigPath);
  const originalHooksText = hooksConfig.exists ? hooksConfig.content : "{}\n";
  const installedHook = await installHookEntry(originalHooksText, paths);

  let codexFeature: CodexFeatureState | undefined;
  let codexHookTrust: CodexHookTrustState | undefined;
  const operations: Operation[] = [
    {
      kind: "write",
      path: paths.skillPath,
      content: skillSource,
      mode: 0o644,
      description: `Install ${paths.agent} SKILL`,
    },
    {
      kind: "write",
      path: paths.hooksConfigPath,
      content: installedHook.text,
      preserveSymlink: true,
      description: `Register ${paths.hookEvent} hook for ${paths.agent}`,
    },
  ];

  if (paths.agent === "codex" && paths.codexConfigPath) {
    const config = await readOptional(paths.codexConfigPath);
    const updated = installCodexFeature(
      config.content,
      paths.codexConfigPath,
      config.exists,
    );
    codexFeature = existingManifest?.codexFeature ?? updated.state;
    const trusted = installCodexHookTrust(
      updated.text,
      paths.codexConfigPath,
      await codexHookTrustIdentity(paths, installedHook),
      existingManifest?.codexHookTrust,
      installedHook.stateMoves,
      installedHook.removedManagedStateKeys,
    );
    codexHookTrust = trusted.state;
    operations.push({
      kind: "write",
      path: paths.codexConfigPath,
      content: trusted.text,
      preserveSymlink: true,
      description: "Enable and trust the Codex hook",
    });
  }

  const manifest: InstallManifest = {
    version: 2,
    agent: paths.agent,
    hooksFileExisted: existingManifest?.hooksFileExisted ?? hooksConfig.exists,
    ...(codexFeature ? { codexFeature } : {}),
    ...(codexHookTrust ? { codexHookTrust } : {}),
  };
  operations.push({
    kind: "write",
    path: paths.manifestPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    mode: 0o600,
    description: `Record ${paths.agent} install ownership`,
  });

  return operations;
}

async function prepareUninstall(
  paths: AgentPaths,
): Promise<Operation[]> {
  const manifest = await readManifest(paths.manifestPath);
  if (manifest && manifest.agent !== paths.agent) {
    throw new Error(
      `Cannot safely continue: ${paths.manifestPath} belongs to ${manifest.agent}.`,
    );
  }
  const hooksConfig = await readOptional(paths.hooksConfigPath);
  const operations: Operation[] = [];
  let updatedHooksText = hooksConfig.content;
  const codexStateMoves = hooksConfig.exists
    ? await codexHookStateKeyMoves(hooksConfig.content, paths)
    : [];
  const codexManagedStateKeys = hooksConfig.exists
    ? await codexManagedHookStateKeys(hooksConfig.content, paths)
    : [];

  if (hooksConfig.exists) {
    updatedHooksText = uninstallHookEntry(hooksConfig.content, paths);
    const root = parseJsonObject(updatedHooksText, paths.hooksConfigPath);
    if (
      Object.keys(root).length === 0 &&
      manifest?.hooksFileExisted === false &&
      /^\{\s*}$/.test(updatedHooksText.trim())
    ) {
      operations.push({
        kind: "delete",
        path: paths.hooksConfigPath,
        description: `Remove empty ${paths.agent} hooks config created by Zeus`,
      });
    } else if (updatedHooksText !== hooksConfig.content) {
      operations.push({
        kind: "write",
        path: paths.hooksConfigPath,
        content: updatedHooksText,
        preserveSymlink: true,
        description: `Remove Zeus hook from ${paths.agent} config`,
      });
    }
  }

  if (
    paths.agent === "codex" &&
    paths.codexConfigPath
  ) {
    const config = await readOptional(paths.codexConfigPath);
    if (config.exists) {
      let restored = manifest?.codexHookTrust
        ? restoreCodexHookTrust(
            config.content,
            paths.codexConfigPath,
            manifest.codexHookTrust,
          )
        : config.content;
      restored = removeCodexHookStateTables(
        restored,
        paths.codexConfigPath,
        codexManagedStateKeys.filter(
          (key) => key !== manifest?.codexHookTrust?.key,
        ),
      );
      restored = migrateCodexHookStateKeys(
        restored,
        paths.codexConfigPath,
        codexStateMoves,
      );
      if (manifest?.codexFeature) {
        restored = restoreCodexFeature(
          restored,
          paths.codexConfigPath,
          manifest.codexFeature,
        );
      }
      const restoredConfig = parseToml(restored, paths.codexConfigPath);
      if (
        manifest?.codexFeature &&
        !manifest.codexFeature.configFileExisted &&
        Object.keys(restoredConfig).length === 0 &&
        restored.trim() === ""
      ) {
        operations.push({
          kind: "delete",
          path: paths.codexConfigPath,
          description: "Remove empty Codex config created by Zeus",
        });
      } else if (restored !== config.content) {
        operations.push({
          kind: "write",
          path: paths.codexConfigPath,
          content: restored,
          preserveSymlink: true,
          description: "Restore the previous Codex hook settings",
        });
      }
    }
  }

  for (const [path, description] of [
    [paths.skillPath, `Remove ${paths.agent} SKILL`],
    [paths.manifestPath, `Remove ${paths.agent} install manifest`],
  ] as const) {
    operations.push({ kind: "delete", path, description });
  }

  return operations;
}

async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode?: number,
  preserveSymlink = false,
): Promise<void> {
  let writePath = path;
  if (preserveSymlink) {
    let isSymlink = false;
    try {
      isSymlink = (await lstat(path)).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (isSymlink) {
      writePath = await realpath(path);
    }
  }

  await mkdir(dirname(writePath), { recursive: true });
  const temporaryPath = join(
    dirname(writePath),
    `.${basename(writePath)}.zeus-${process.pid}-${crypto.randomUUID()}`,
  );

  try {
    await writeFile(temporaryPath, content, "utf8");
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    } else {
      const current = await readOptional(writePath);
      if (current.exists) {
        await chmod(temporaryPath, (await stat(writePath)).mode & 0o777);
      }
    }
    await rename(temporaryPath, writePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function executeOperations(
  operations: Operation[],
  dryRun: boolean,
  log: (message: string) => void,
): Promise<void> {
  for (const operation of operations) {
    log(`${dryRun ? "Would apply" : "Apply"} ${operation.description}: ${operation.path}`);
    if (dryRun) {
      continue;
    }

    if (operation.kind === "write") {
      await atomicWrite(
        operation.path,
        operation.content,
        operation.mode,
        operation.preserveSymlink,
      );
    } else {
      await rm(operation.path, { force: true });
    }
  }
}

async function removeEmptySkillDirectories(paths: AgentPaths[]): Promise<void> {
  for (const pathsForAgent of paths) {
    try {
      await rmdir(pathsForAgent.skillDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        throw error;
      }
    }
  }
}

export async function runInstaller(options: InstallerOptions): Promise<void> {
  if (options.agents.length === 0) {
    throw new Error("At least one agent must be selected.");
  }

  const log = options.log ?? console.log;
  const paths = options.agents.map((agent) => agentPaths(options, agent));
  const plans = await Promise.all(
    paths.map((agent) =>
      options.action === "install"
        ? prepareInstall(agent)
        : prepareUninstall(agent),
    ),
  );

  if (options.action === "install") {
    if (!options.binarySourcePath) {
      throw new Error("The Zeus executable source path is required for installation.");
    }
    const binary = await readFile(options.binarySourcePath);
    await executeOperations(
      [
        {
          kind: "write",
          path: paths[0]!.binaryPath,
          content: binary,
          mode: 0o755,
          description: "Install Zeus executable",
        },
      ],
      options.dryRun,
      log,
    );
  }

  for (const operations of plans) {
    await executeOperations(operations, options.dryRun, log);
  }

  if (options.action === "uninstall" && !options.dryRun) {
    await removeEmptySkillDirectories(paths);
  }

  if (options.action === "uninstall") {
    const unselectedAgents = (["claude", "codex"] as const).filter(
      (agent) => !options.agents.includes(agent),
    );
    const hasAnotherInstallation = (
      await Promise.all(
        unselectedAgents.map(async (agent) => {
          const otherPaths = agentPaths(options, agent);
          return (await readOptional(otherPaths.manifestPath)).exists;
        }),
      )
    ).some(Boolean);

    if (!hasAnotherInstallation) {
      await executeOperations(
        [
          {
            kind: "delete",
            path: paths[0]!.binaryPath,
            description: "Remove Zeus executable",
          },
        ],
        options.dryRun,
        log,
      );
    }
  }

  log(
    `${options.dryRun ? "Dry run complete" : options.action === "install" ? "Zeus installed" : "Zeus uninstalled"} for ${options.agents.join(" and ")}.`,
  );
}
