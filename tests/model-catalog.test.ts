import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexModelCatalogProvider,
  findCodexRuntime,
  parseClaudeCatalog,
  parseCodexModelList,
  validateBundledCatalogs,
  type CodexRuntimeEnvironment,
} from "../src/model-catalog.ts";
import bundledCatalogs from "../src/model-catalog.bundled.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const overview = `# Models overview

## Compare models

| Feature | Claude Big 2.1 | Claude Mid 2 | Claude Small 1.5 |
| :--- | :--- | :--- | :--- |
| Model page | [Claude Big 2.1](https://example.test/big) | [Claude Mid 2](https://example.test/mid) | [Claude Small 1.5](https://example.test/small) |
| Claude API ID | \`claude-big-2-1\` | \`claude-mid-2\` | \`claude-small-1-5-20250101\` |
| [Default effort](https://example.test/effort) | \`high\` | \`medium\` | Not supported |

* **Claude API ID:** Notes.

## Using the Models API
`;

const effort = `### Effort levels

| Level    | Description | Typical use case |
| -------- | ----------- | ---------------- |
| \`max\`    | Absolute maximum. Available on Claude Big 2.1, Claude Old 1.9, and Claude Mid 2. | Hard tasks |
| \`xhigh\`  | Extended capability. Available on Claude Big 2.1 and Claude Old 1.9. | Long tasks |
| \`high\`   | The default. | Complex reasoning |
`;

function runtimeEnvironment(overrides: Partial<CodexRuntimeEnvironment>): CodexRuntimeEnvironment {
  return {
    homeDir: "/Users/test",
    platform: "darwin",
    which: () => null,
    exists: () => false,
    findAppBundles: () => [],
    ...overrides,
  };
}

describe("Claude catalog", () => {
  test("reads model IDs and effort levels from the documentation tables", () => {
    expect(parseClaudeCatalog(overview, effort)).toEqual([
      {
        id: "claude-big-2-1",
        displayName: "Claude Big 2.1",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "high",
      },
      {
        id: "claude-mid-2",
        displayName: "Claude Mid 2",
        efforts: ["low", "medium", "high", "max"],
        defaultEffort: "medium",
      },
      {
        id: "claude-small-1-5-20250101",
        displayName: "Claude Small 1.5",
        efforts: [],
      },
    ]);
  });

  test("rejects documentation without the expected table", () => {
    expect(() => parseClaudeCatalog("# Models overview\n", effort)).toThrow(
      'no "## Compare models" section',
    );
    expect(() =>
      parseClaudeCatalog(overview.replace("Claude API ID", "API name"), effort),
    ).toThrow('no "Claude API ID" row');
  });
});

describe("Codex catalog", () => {
  test("maps visible models from model/list", () => {
    const page = parseCodexModelList({
      data: [
        {
          model: "gpt-a",
          displayName: "GPT-A",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
          ],
        },
        {
          model: "gpt-hidden",
          displayName: "Hidden",
          hidden: true,
          isDefault: false,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [],
        },
      ],
      nextCursor: "next",
    });

    expect(page).toEqual({
      models: [
        {
          id: "gpt-a",
          displayName: "GPT-A",
          efforts: ["low", "medium"],
          defaultEffort: "medium",
          isDefault: true,
        },
      ],
      nextCursor: "next",
    });
  });

  test("prefers codex from PATH", () => {
    expect(findCodexRuntime(runtimeEnvironment({ which: () => "/usr/local/bin/codex" }))).toBe(
      "/usr/local/bin/codex",
    );
  });

  test("finds the runtime bundled with the desktop app", () => {
    const bundled = "/Users/test/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    expect(findCodexRuntime(runtimeEnvironment({ exists: (path) => path === bundled }))).toBe(
      bundled,
    );
  });

  test("finds an app bundle in a custom location", () => {
    const bundled = "/Volumes/Apps/Codex.app/Contents/Resources/codex";
    expect(
      findCodexRuntime(
        runtimeEnvironment({
          exists: (path) => path === bundled,
          findAppBundles: () => ["/Volumes/Apps/Codex.app"],
        }),
      ),
    ).toBe(bundled);
  });

  test("does not look for app bundles outside macOS", () => {
    expect(
      findCodexRuntime(runtimeEnvironment({ platform: "linux", exists: () => true })),
    ).toBeUndefined();
  });

  test("lists models through the app-server protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zeus-codex-runtime-"));
    temporaryDirectories.push(directory);
    const runtime = join(directory, "codex");
    const page = (data: unknown[], nextCursor: string | null) =>
      JSON.stringify({ data, nextCursor }).replaceAll("'", "");
    const model = (name: string) => ({
      model: name,
      displayName: name.toUpperCase(),
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
    });
    await writeFile(
      runtime,
      `#!/bin/bash
[ "$1" = "app-server" ] || exit 2
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
    *'"method":"model/list"'*'"cursor":null'*) echo '{"method":"notice"}'; echo '{"id":2,"result":${page([model("gpt-a")], "c2")}}' ;;
    *'"method":"model/list"'*'"cursor":"c2"'*) echo '{"id":3,"result":${page([model("gpt-b")], null)}}' ;;
  esac
done
`,
      "utf8",
    );
    await chmod(runtime, 0o755);

    const catalog = await new CodexModelCatalogProvider(runtime).getCatalog();
    expect(catalog.source).toContain(runtime);
    expect(catalog.models.map(({ id }) => id)).toEqual(["gpt-a", "gpt-b"]);
  });

  test("reports an app-server that exits without answering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zeus-codex-runtime-"));
    temporaryDirectories.push(directory);
    const runtime = join(directory, "codex");
    await writeFile(runtime, "#!/bin/bash\nexit 0\n", "utf8");
    await chmod(runtime, 0o755);

    await expect(new CodexModelCatalogProvider(runtime).getCatalog()).rejects.toThrow(
      "exited before answering initialize",
    );
  });
});

describe("bundled catalog", () => {
  test("is valid for both agents", () => {
    const catalogs = validateBundledCatalogs(bundledCatalogs);
    expect(catalogs.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(catalogs.catalogs.claude.models.length).toBeGreaterThan(0);
    expect(catalogs.catalogs.codex.models.length).toBeGreaterThan(0);
  });
});
