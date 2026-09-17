## Creating a worker session

Create worker sessions through `spawn_task`. The card appears immediately, but the session starts only after the user clicks it, so at the beginning of a workstream tell the user how many clicks the planned chunks will require.

1. Before creating the card, obtain your own `session_id` through `get_session` with `"self"`. Without it, the worker cannot report back.
2. Create the card with the title `└─ {Name}: {action summary}` and a self-contained prompt because the card does not inherit Zeus's conversation. The session receives its own worktree.
3. In the card prompt, require the worker's first action after startup to be reporting to Zeus through `send_message` at Zeus's `session_id`, including the worker's own `session_id`. The card does not return the worker session ID to Zeus, and the startup notification does not wake an idle Zeus session; it arrives only when Zeus next wakes. This handshake is therefore both the only signal that the card has started and the only reliable source of its `session_id`.
4. A card accepts only `title`, `tldr`, `prompt`, and optional `cwd`; it cannot set the model, effort, or context. After receiving the handshake, record the `session_id` in the workstream registry, set the model and effort, and only then manage the session as a normal worker session.
5. Reply to the handshake through `send_message`. This reply is also the bootstrap message required for the reason described below.

### MCP servers in a worker session

A session started from a card does not initially have the full set of MCP servers, and the distinction is strict:

- **Locally configured servers** — local stdio servers and `claude mcp` entries such as `context7`, `codegraph`, `webstorm`, and `linear-server` — are available from the first turn.
- **claude.ai connectors** — UUID-named servers such as Linear, Gmail, Drive, Calendar, and Slack — appear only on the turn after the first message sent to the session. They are unavailable both during the autonomous turn and during the turn triggered by that message.

This produces three rules:

1. The worker's first turn must not depend on a claude.ai connector. Plan work that functions without them, such as repository orientation, code reading, or plan preparation.
2. Zeus's handshake reply is that first message. Connectors are available beginning with the worker's following turn.
3. Require the worker to check for the connector through `ToolSearch` using its exact name before reaching for its tool. If it is absent, the worker must not improvise, look for a public-API workaround, or declare the service unavailable. It should end the turn and report the absence to Zeus; the connector will be available on the next turn.

Use `session_connectors_status`, which is available in a card session from the first turn, to distinguish a missing connector from a service outage. Neither Zeus nor the worker can connect a server in the `needs_auth` state; only the user can sign in, so report this and do not plan a chunk that depends on that server. These rules are based on one measurement; if observed behavior differs, report it to the user instead of inventing a workaround.
