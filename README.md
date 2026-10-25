# Zeus

Zeus coordinates parallel workstreams across Claude Code and Codex.

## Installation

On macOS or Linux, install Zeus with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash
```

The shell installer detects the operating system and CPU architecture, downloads the matching standalone executable from GitHub Releases, verifies its SHA-256 checksum, and runs it.

In a terminal, the installer shows which agents it detected (CLI, desktop app or configuration directory) and asks which of them to configure; on a later run, the agents Zeus is already installed for are preselected. It then asks for the Worker settings, lists the changes and applies them after confirmation. Without a terminal, or with `--yes`, it configures every detected agent without asking.

The executable is installed to `~/.local/bin/zeus`; the installer says how to add that directory to `PATH` when it is missing there. For each chosen agent, it installs the appropriate SKILL into `~/.claude/skills` or, for Codex, `~/.agents/skills`, merges the hook configuration idempotently into `~/.claude/settings.json` or `~/.codex/hooks.json`, and enables and trusts the exact Codex hook definition in `~/.codex/config.toml`. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `ZEUS_BIN_DIR` are respected when set. Codex skills installed by earlier versions in `$CODEX_HOME/skills`, which Codex now treats as deprecated, are moved to `~/.agents/skills` on the next install; files the dashboard skill added itself move with it.

Pin a release, limit the installation, or preview the changes as diffs of the edited files:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --version v1.0.0
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --skip-codex
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- --dry-run
```

### Worker model and effort

In a terminal, the installer asks which model and effort the Coordinator's Worker sessions use, separately for Claude and Codex; choose with the arrow keys and confirm with Enter. The previous choice is preselected. The choice is saved in `~/.zeus/config.json` and written into each installed SKILL; run the installer again to change it.

- **Codex** models and effort levels come from the local Codex runtime (`codex app-server`, `model/list`). The `codex` CLI does not have to be in `PATH`: the runtime bundled with the Codex desktop app is found in `/Applications`, `~/Applications`, or through Spotlight.
- **Claude** models and effort levels come from the official Anthropic documentation. This lists what each model supports, not what your account can use; if a chosen model is unavailable, run the installer again and pick another one.
- If a live catalog cannot be loaded, the installer says why and uses the catalog bundled with Zeus, showing its capture date.

Without a terminal or with `--yes`, the installer reuses the saved choice and fails when there is none. Pass the choice explicitly to skip the wizard; the effort defaults to the model default. A Worker model flag also configures its agent when that agent was not detected:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash -s -- \
  --claude-worker-model claude-opus-5-5 --claude-worker-effort high \
  --codex-worker-model gpt-6-sol --codex-worker-effort high
```

### Live dashboard

The installer also asks whether to add the bundled `dashboard` skill (`skills/dashboard`, default: yes). It is an independent skill: run `/dashboard` in any session to follow the work in a live visual dashboard, which a subagent starts and keeps current from the main agent's signals. It needs Node.js 18+. When it is installed, the Zeus Coordinator starts it at `/zeus` and signals every workstream change to it. The installer never overwrites a `dashboard` skill it did not install; move it away or choose no dashboard. Turning the dashboard off or uninstalling removes only the files Zeus installed. The choice is saved in `~/.zeus/config.json`; pass `--dashboard` or `--no-dashboard` to skip the question.

Check what is installed, or remove only files and configuration entries owned by Zeus:

```bash
zeus status
zeus uninstall    # Asks for confirmation; --skip-claude or --skip-codex keeps one agent.
```

Codex may require approving a newly installed hook in `/hooks` before it runs.

## Development

Bun is required to build and test the repository:

```bash
bun install
bun run check
bun run build:binary
```

`skills/dashboard` is the source of the bundled dashboard skill; `bun run build` refreshes its installed file list, and `bun run test:dashboard` runs its runtime tests.

`bun run catalog:update` refreshes the bundled model catalog (`src/model-catalog.bundled.json`) from the Anthropic documentation and the local Codex runtime; run it before a release.

`bun run release:build` creates standalone executables and SHA-256 sidecars for macOS and Linux on arm64 and x64. Pushing a `v*` tag publishes those files through the release workflow.
