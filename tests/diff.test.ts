import { describe, expect, test } from "bun:test";

import { redactSecrets, renderDiff } from "../src/diff.ts";

describe("renderDiff", () => {
  test("shows removals before additions and folds distant context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "B", "c", "d", "e", "f", "g", "H"].join("\n");
    expect(renderDiff(before, after)).toBe(
      ["  a", "- b", "+ B", "  c", "  d", "  …", "  f", "  g", "- h", "+ H"].join("\n"),
    );
  });
});

describe("redactSecrets", () => {
  test("hides values on lines that look like credentials", () => {
    expect(redactSecrets('"API_KEY": "abc",\n"theme": "dark"')).toBe('"API_KEY": <redacted>\n"theme": "dark"');
  });
});
