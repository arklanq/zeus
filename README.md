# Zeus

Zeus coordinates parallel workstreams across Claude Code and Codex.

## Installation

On macOS or Linux, install Zeus with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/master/install.sh | bash
```

The shell installer detects the operating system and CPU architecture, downloads the matching standalone executable from GitHub Releases, verifies its SHA-256 checksum, and runs it.

The executable is installed to `~/.local/bin/zeus`. It installs the appropriate SKILL for each agent, merges the hook configuration idempotently into `~/.claude/settings.json` and `~/.codex/hooks.json`, and enables Codex hooks in `~/.codex/config.toml`. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `ZEUS_BIN_DIR` are respected when set.

Pin a release or limit the installation when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/master/install.sh | bash -s -- --version v1.0.0
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/master/install.sh | bash -s -- --skip-codex
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/master/install.sh | bash -s -- --dry-run
```

Remove only files and configuration entries owned by Zeus:

```bash
~/.local/bin/zeus uninstall
```

Codex may require approving a newly installed hook in `/hooks` before it runs.

## Development

Bun is required to build and test the repository:

```bash
bun install
bun run check
bun run build:binary
```

`bun run release:build` creates standalone executables and SHA-256 sidecars for macOS and Linux on arm64 and x64. Pushing a `v*` tag publishes those files through the release workflow.
