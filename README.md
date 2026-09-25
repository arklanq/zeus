# Zeus

Zeus coordinates parallel workstreams across Claude Code and Codex.

## Installation

On macOS or Linux, install Zeus with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash
```

The shell installer detects the operating system and CPU architecture, downloads the matching standalone executable from GitHub Releases, verifies its SHA-256 checksum, and runs it.

The executable is installed to `~/.local/bin/zeus`. It installs the appropriate SKILL for each agent, merges the hook configuration idempotently into `~/.claude/settings.json` and `~/.codex/hooks.json`, and enables and trusts the exact Codex hook definition in `~/.codex/config.toml`. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `ZEUS_BIN_DIR` are respected when set.

Pin a release or limit the installation when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --version v1.0.0
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --skip-codex
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --dry-run
```

### Worker model and effort

In a terminal, the installer asks which model and effort Zeus's worker sessions use, separately for Claude and Codex; choose with the arrow keys and confirm with Enter. The previous choice is preselected. The choice is saved in `~/.zeus/config.json` and written into each installed SKILL; run the installer again to change it.

- **Codex** models and effort levels come from the local Codex runtime (`codex app-server`, `model/list`). The `codex` CLI does not have to be in `PATH`: the runtime bundled with the Codex desktop app is found in `/Applications`, `~/Applications`, or through Spotlight.
- **Claude** models and effort levels come from the official Anthropic documentation. This lists what each model supports, not what your account can use; if a chosen model is unavailable, run the installer again and pick another one.
- If a live catalog cannot be loaded, the installer says why and uses the catalog bundled with Zeus, showing its capture date.

Without a terminal, the installer reuses the saved choice and fails when there is none. Pass the choice explicitly to skip the wizard; the effort defaults to the model default:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- \
  --claude-worker-model claude-opus-5-5 --claude-worker-effort high \
  --codex-worker-model gpt-6-sol --codex-worker-effort high
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

`bun run catalog:update` refreshes the bundled model catalog (`src/model-catalog.bundled.json`) from the Anthropic documentation and the local Codex runtime; run it before a release.

`bun run release:build` creates standalone executables and SHA-256 sidecars for macOS and Linux on arm64 and x64. Pushing a `v*` tag publishes those files through the release workflow.
