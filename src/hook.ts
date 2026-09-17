import { readFile } from "node:fs/promises";

import type { AgentName } from "./installer.ts";

type HookInput = {
  transcript_path?: unknown;
};

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PostCompact" | "SessionStart";
    additionalContext: string;
  };
};

const ZEUS_ID_PATTERN = "[A-Za-z0-9._-]{1,40}";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isObject(item)) {
        return "";
      }
      return typeof item.text === "string" ? item.text : "";
    })
    .join("\n");
}

function assistantMessageText(record: unknown): string {
  if (!isObject(record)) {
    return "";
  }

  if (record.type === "assistant" && isObject(record.message)) {
    return record.message.role === "assistant"
      ? contentText(record.message.content)
      : "";
  }

  if (
    record.type === "response_item" &&
    isObject(record.payload) &&
    record.payload.type === "message" &&
    record.payload.role === "assistant"
  ) {
    return contentText(record.payload.content);
  }

  return "";
}

function recoverZeusId(transcript: string): string | undefined {
  const startup = new RegExp(
    `^Zeus ID: \`(${ZEUS_ID_PATTERN})\`\\r?\\n<!-- zeus-session-id:(${ZEUS_ID_PATTERN}) -->(?:\\r?\\n|$)`,
  );
  const candidates: string[] = [];

  for (const line of transcript.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const match = assistantMessageText(record).match(startup);
    if (match?.[1] && match[1] === match[2]) {
      candidates.push(match[1]);
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

function concretizeSkill(skill: string, zeusId: string): string {
  const replaced = skill
    .replaceAll("{zeus-id}", zeusId)
    .replaceAll("<zeus-id>", zeusId);
  const lines = replaced.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line === "## Uruchomienie");
  if (sectionStart < 0) {
    return replaced;
  }

  const nextSectionOffset = lines
    .slice(sectionStart + 1)
    .findIndex((line) => line.startsWith("## "));
  const sectionEnd =
    nextSectionOffset < 0 ? lines.length : sectionStart + 1 + nextSectionOffset;
  lines.splice(
    sectionStart,
    sectionEnd - sectionStart,
    "## Tożsamość instancji",
    "",
    `Ta sesja jest już uruchomiona, a jej identyfikator to \`${zeusId}\`. Nie losuj nowego, nie pytaj o niego i nie traktuj braku argumentu jako nowego startu — pracujesz dalej pod tym samym identyfikatorem. Twoje workstreamy to te pasujące do \`~/.zeus/workstreams/*-${zeusId}-*\`.`,
    "",
  );
  return lines.join("\n");
}

export function createHookOutput(
  agent: AgentName,
  transcript: string,
  skill: string,
): HookOutput | undefined {
  const zeusId = recoverZeusId(transcript);
  if (!zeusId) {
    return undefined;
  }

  const skillText = concretizeSkill(skill, zeusId);
  const identity = `Tożsamość tej instancji jest już ustalona: \`${zeusId}\` (odzyskane z zaufanego znacznika pierwszej odpowiedzi Zeusa). W treści poniżej placeholdery zostały zastąpione tą wartością, a sekcja o uruchamianiu — usunięta, bo nie dotyczy sesji, która już działa.`;

  return {
    hookSpecificOutput: {
      hookEventName: agent === "claude" ? "PostCompact" : "SessionStart",
      additionalContext: `Kontekst tej sesji został właśnie skompaktowany. Prowadzisz ją jako Zeus.\n\n${identity}\n\nPoniżej pełna, obowiązująca treść instrukcji skilla /zeus — stosuj ją dalej w całości, także jeżeli skrót kontekstu jej nie zawiera.\n\n${skillText}`,
    },
  };
}

export async function runHook(
  agent: AgentName,
  skillPath: string,
  inputText: string,
): Promise<HookOutput | undefined> {
  let input: HookInput;
  try {
    input = JSON.parse(inputText) as HookInput;
  } catch {
    throw new Error("Hook input is not valid JSON.");
  }

  if (typeof input.transcript_path !== "string" || input.transcript_path === "") {
    return undefined;
  }

  let transcript: string;
  let skill: string;
  try {
    [transcript, skill] = await Promise.all([
      readFile(input.transcript_path, "utf8"),
      readFile(skillPath, "utf8"),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return createHookOutput(agent, transcript, skill);
}
