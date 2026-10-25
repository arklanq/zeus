# Zeus

Run several streams of work in parallel from one conversation. Zeus turns Claude Code or Codex into a Coordinator: it scopes the work, splits it into workstreams, hands each one to its own Worker session and collects the results.

- **Parallel Workers.** Each workstream runs in a separate session that you can open, steer or stop.
- **Survives context compaction.** A hook restores the Coordinator's identity, so long sessions keep going.
- **Resume anywhere.** Each Coordinator has a short ID, like `atlas`. Pass it to `/zeus` to pick up the work later, even in the other tool.
- **Live dashboard.** An optional local dashboard follows every workstream as it changes.

## Install

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/zeus/main/install.sh | bash
```

The installer detects Claude Code and Codex, asks which ones to set up and which model and effort the Workers use, and shows every change before applying it. Add `--dry-run` to preview the changes, or `--yes` to accept the defaults.

Codex may ask you to approve the new hook in `/hooks`.

## Use

```text
/zeus            start a Coordinator
/zeus atlas      resume Coordinator atlas
/dashboard       open the live dashboard (needs Node.js 18+)
```

In Codex, call the skills as `$zeus` and `$dashboard`.

```bash
zeus status      # what is installed
zeus uninstall   # remove only what Zeus added
```

## Development

```bash
bun install
bun run check
bun run build:binary
```
