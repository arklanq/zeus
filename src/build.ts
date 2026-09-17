import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TargetConfig = {
  workerIdColumn: string;
  delegationCoordination: string;
  delegationPublication: string;
};

const targetNames = ["claude", "codex"] as const;
const outputMode = 0o644;
const blockFiles = {
  HEADER: "header.md",
  PLATFORM_PREAMBLE: "platform-preamble.md",
  STARTUP: "startup.md",
  ROLES: "roles.md",
  COMMUNICATION: "communication.md",
  WORKER_SESSION_CREATION: "worker-session-creation.md",
  MODEL_LIFECYCLE: "model-lifecycle.md",
  POST_LIFECYCLE: "post-lifecycle.md",
  UNAVAILABLE: "unavailable.md",
} as const;
const optionalBlocks = new Set([
  "PLATFORM_PREAMBLE",
  "WORKER_SESSION_CREATION",
  "POST_LIFECYCLE",
]);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(projectDir, "src");
const outputDir = join(projectDir, "dist");

if (outputDir === projectDir || !outputDir.endsWith("/dist")) {
  throw new Error(`Refusing to use unsafe output directory: ${outputDir}`);
}

function renderTemplate(template: string, values: Record<string, string>): string {
  const getValue = (key: string): string => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Missing template value: ${key}`);
    }

    return value;
  };

  let rendered = template.replace(
    /^\{\{([A-Z0-9_]+)}}\r?\n/gm,
    (_match, key: string) => {
      const value = getValue(key).trimEnd();
      return value ? `${value}\n\n` : "";
    },
  );

  rendered = rendered.replace(/\{\{([A-Z0-9_]+)}}/g, (_match, key: string) => {
    return getValue(key);
  });

  const unresolved = rendered.match(/\{\{[A-Z0-9_]+}}/g);
  if (unresolved) {
    throw new Error(`Unresolved template values: ${unresolved.join(", ")}`);
  }

  return `${rendered.trimEnd()}\n`;
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function createOutputs(): Promise<Map<string, string>> {
  const skillTemplate = await readFile(join(sourceDir, "skill.template.md"), "utf8");
  const outputs = new Map<string, string>();

  for (const targetName of targetNames) {
    const targetDir = join(sourceDir, "targets", targetName);
    const config = JSON.parse(
      await readFile(join(targetDir, "target.json"), "utf8"),
    ) as TargetConfig;
    const values: Record<string, string> = {
      WORKER_ID_COLUMN: config.workerIdColumn,
      DELEGATION_COORDINATION: config.delegationCoordination,
      DELEGATION_PUBLICATION: config.delegationPublication,
    };

    for (const [key, filename] of Object.entries(blockFiles)) {
      const path = join(targetDir, filename);
      values[key] = optionalBlocks.has(key)
        ? await readOptional(path)
        : await readFile(path, "utf8");
    }

    outputs.set(join(targetName, "SKILL.md"), renderTemplate(skillTemplate, values));
  }

  return outputs;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );

  return files.flat();
}

async function build(outputs: Map<string, string>): Promise<void> {
  await rm(outputDir, { recursive: true, force: true });

  for (const [relativePath, content] of outputs) {
    const path = join(outputDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    await chmod(path, outputMode);
  }

  console.log(`Generated ${outputs.size} files in ${relative(projectDir, outputDir)}.`);
}

async function check(outputs: Map<string, string>): Promise<void> {
  const expectedPaths = [...outputs.keys()].sort();
  let actualPaths: string[];

  try {
    actualPaths = (await listFiles(outputDir))
      .map((path) => relative(outputDir, path))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("dist is missing; run `bun run build`.");
    }

    throw error;
  }

  if (actualPaths.join("\n") !== expectedPaths.join("\n")) {
    throw new Error("dist contains missing or unexpected files; run `bun run build`.");
  }

  const staleFiles: string[] = [];

  for (const [relativePath, expectedContent] of outputs) {
    const path = join(outputDir, relativePath);
    const [content, metadata] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);

    if (content !== expectedContent || (metadata.mode & 0o777) !== outputMode) {
      staleFiles.push(relativePath);
    }
  }

  if (staleFiles.length > 0) {
    throw new Error(`Generated files are stale: ${staleFiles.join(", ")}`);
  }

  console.log(`Verified ${outputs.size} generated files.`);
}

const outputs = await createOutputs();

if (Bun.argv.includes("--check")) {
  await check(outputs);
} else {
  await build(outputs);
}
