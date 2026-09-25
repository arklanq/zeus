import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClaudeModelCatalogProvider,
  CodexModelCatalogProvider,
  defaultCodexRuntimeEnvironment,
  findCodexRuntime,
  validateBundledCatalogs,
  type BundledCatalogs,
} from "./model-catalog.ts";

const outputPath = join(dirname(fileURLToPath(import.meta.url)), "model-catalog.bundled.json");
const homeDir = process.env.HOME;
if (!homeDir) {
  throw new Error("HOME is not set.");
}

const codexRuntime = findCodexRuntime(defaultCodexRuntimeEnvironment(homeDir));
if (!codexRuntime) {
  throw new Error("The Codex runtime was not found in PATH or in a Codex/ChatGPT app bundle.");
}

const [claude, codex] = await Promise.all([
  new ClaudeModelCatalogProvider().getCatalog(),
  new CodexModelCatalogProvider(codexRuntime).getCatalog(),
]);

const bundled: BundledCatalogs = validateBundledCatalogs({
  capturedAt: new Date().toLocaleDateString("sv-SE"),
  catalogs: {
    claude: { ...claude, source: "Anthropic documentation" },
    codex: { ...codex, source: "Codex app-server model/list" },
  },
});

await writeFile(outputPath, `${JSON.stringify(bundled, null, 2)}\n`, "utf8");
console.log(
  `Captured ${claude.models.length} Claude and ${codex.models.length} Codex models in src/model-catalog.bundled.json.`,
);
