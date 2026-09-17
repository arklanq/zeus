import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(projectDir, "release");
const hostOnly = process.argv.includes("--host");

if (releaseDir === projectDir || !releaseDir.endsWith("/release")) {
  throw new Error(`Refusing to use unsafe release directory: ${releaseDir}`);
}

type ReleaseTarget = {
  name: string;
  target?: Bun.Build.CompileTarget;
};

const targets: ReleaseTarget[] = hostOnly
  ? [{ name: "zeus" }]
  : [
      { name: "zeus-darwin-arm64", target: "bun-darwin-arm64" },
      { name: "zeus-darwin-x64", target: "bun-darwin-x64" },
      { name: "zeus-linux-arm64", target: "bun-linux-arm64" },
      { name: "zeus-linux-x64", target: "bun-linux-x64" },
    ];

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
process.chdir(projectDir);

for (const releaseTarget of targets) {
  const outfile = join(releaseDir, releaseTarget.name);
  const result = await Bun.build({
    entrypoints: [join(projectDir, "src", "install.ts")],
    compile: {
      ...(releaseTarget.target ? { target: releaseTarget.target } : {}),
      outfile,
      assets: ["./dist"],
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
    },
    minify: true,
  });

  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to build ${releaseTarget.name}.`);
  }
  await chmod(outfile, 0o755);

  if (!hostOnly) {
    const checksum = createHash("sha256")
      .update(await readFile(outfile))
      .digest("hex");
    await writeFile(`${outfile}.sha256`, `${checksum}  ${releaseTarget.name}\n`, "utf8");
  }

  console.log(`Built release/${releaseTarget.name}.`);
}
