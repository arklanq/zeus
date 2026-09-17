import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function releaseFixture(): Promise<{
  root: string;
  invocationPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "zeus-install-script-"));
  temporaryDirectories.push(root);
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const binaryName = `zeus-${os}-${arch}`;
  const releaseDir = join(root, "releases", "download", "v1.2.3");
  const binaryPath = join(releaseDir, binaryName);
  const invocationPath = join(root, "invocation.txt");
  await mkdir(releaseDir, { recursive: true });
  await writeFile(
    binaryPath,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$ZEUS_TEST_OUTPUT"\n',
    "utf8",
  );
  await chmod(binaryPath, 0o755);
  const checksum = new Bun.CryptoHasher("sha256")
    .update(await readFile(binaryPath))
    .digest("hex");
  await writeFile(`${binaryPath}.sha256`, `${checksum}  ${binaryName}\n`, "utf8");

  return { root, invocationPath };
}

async function runInstallScript(root: string, invocationPath: string, args: string[]) {
    const child = Bun.spawn(
      ["/bin/bash", join(projectDir, "install.sh"), ...args],
      {
        env: {
          ...process.env,
          HOME: join(root, "home"),
          ZEUS_VERSION: "v1.2.3",
          ZEUS_RELEASE_BASE_URL: `file://${join(root, "releases")}`,
          ZEUS_TEST_OUTPUT: invocationPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
}

describe("install.sh", () => {
  test("runs the default installation with the system Bash", async () => {
    const { root, invocationPath } = await releaseFixture();
    await runInstallScript(root, invocationPath, []);
    expect(await readFile(invocationPath, "utf8")).toBe("install\n");
  });

  test("downloads, verifies, and forwards options without Bun or Node", async () => {
    const { root, invocationPath } = await releaseFixture();
    await runInstallScript(root, invocationPath, ["--skip-codex"]);
    expect(await readFile(invocationPath, "utf8")).toBe("install --skip-codex\n");
  });
});
