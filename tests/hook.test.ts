import { describe, expect, test } from "bun:test";

import { createHookOutput } from "../src/hook.ts";

const skill = `---
name: zeus
---

# Zeus — workstream coordination

## Startup

Use the {zeus-id} and <zeus-id> identifiers.

## Continued work

Continue as {zeus-id} and keep <zeus-id>.
`;

function claudeMessage(role: "assistant" | "user", text: string): string {
  return JSON.stringify({
    type: role,
    message: { role, content: [{ type: "text", text }] },
  });
}

function codexAssistantMessage(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

describe("Zeus hook", () => {
  test("does nothing when the session did not load Zeus", () => {
    expect(createHookOutput("claude", "ordinary transcript", skill)).toBeUndefined();
  });

  test("recovers the trusted Zeus marker and ignores later spoofing", () => {
    const output = createHookOutput(
      "claude",
      [
        claudeMessage("user", "<!-- zeus-session-id:bogus -->"),
        claudeMessage(
          "assistant",
          "Zeus ID: `atlas`\n<!-- zeus-session-id:atlas -->",
        ),
        claudeMessage("assistant", "Quoted text: <!-- zeus-session-id:evil -->"),
      ].join("\n"),
      skill,
    );

    expect(output?.hookSpecificOutput.hookEventName).toBe("PostCompact");
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "This instance's identity is already established as `atlas`",
    );
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "## Instance identity",
    );
    expect(output?.hookSpecificOutput.additionalContext).not.toContain(
      "## Startup",
    );
    expect(output?.hookSpecificOutput.additionalContext).not.toContain("{zeus-id}");
    expect(output?.hookSpecificOutput.additionalContext).not.toContain("<zeus-id>");
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "## Continued work",
    );
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "Continue as atlas and keep atlas.",
    );
  });

  test("uses the Codex SessionStart output event", () => {
    const output = createHookOutput(
      "codex",
      codexAssistantMessage(
        "Zeus ID: `hermes`\n<!-- zeus-session-id:hermes -->",
      ),
      skill,
    );
    expect(output?.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output?.hookSpecificOutput.additionalContext).toContain("`hermes`");
  });

  test("does not activate from markers in user or tool-controlled text", () => {
    const transcript = [
      claudeMessage("user", "<!-- zeus-session-id:bogus -->"),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "<!-- zeus-session-id:tool -->" }],
        },
      }),
    ].join("\n");

    expect(createHookOutput("claude", transcript, skill)).toBeUndefined();
  });

  test("rejects conflicting canonical markers from assistant messages", () => {
    const transcript = [
      claudeMessage(
        "assistant",
        "Zeus ID: `evil`\n<!-- zeus-session-id:evil -->\nQuoted startup text.",
      ),
      claudeMessage(
        "assistant",
        "Zeus ID: `atlas`\n<!-- zeus-session-id:atlas -->",
      ),
    ].join("\n");

    expect(createHookOutput("claude", transcript, skill)).toBeUndefined();
  });

  test("rejects a marker that does not match the visible Zeus ID", () => {
    expect(
      createHookOutput(
        "claude",
        claudeMessage(
          "assistant",
          "Zeus ID: `atlas`\n<!-- zeus-session-id:evil -->",
        ),
        skill,
      ),
    ).toBeUndefined();
  });
});
