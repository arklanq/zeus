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
  const sectionStart = lines.findIndex((line) => line === "## Startup");
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
    "## Instance identity",
    "",
    `This session is already running and its identifier is \`${zeusId}\`. Do not generate a new one, ask for one, or treat the missing argument as a fresh start—you are continuing under the same identifier. Your workstreams are those matching \`~/.zeus/workstreams/*-${zeusId}-*\`.`,
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
  const identity = `This instance's identity is already established as \`${zeusId}\` (restored from the trusted marker in Zeus's first response). The placeholders below have been replaced with that value, and the startup section has been removed because it does not apply to a session that is already running.`;

  return {
    hookSpecificOutput: {
      hookEventName: agent === "claude" ? "PostCompact" : "SessionStart",
      additionalContext: `This session's context has just been compacted. You are running it as Zeus.\n\n${identity}\n\nThe full authoritative instructions for the /zeus skill follow. Continue applying them in full even if the compacted context does not include them.\n\n${skillText}`,
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
