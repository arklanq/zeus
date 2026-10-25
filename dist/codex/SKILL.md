---
name: zeus
description: Start a Zeus coordination session that scopes work, manages workstreams in `~/.zeus/`, delegates chunks to separate Worker threads through `create_thread`, and receives their results. Accepts an optional Zeus ID for resuming an earlier instance, including one started in another tool.
---

# Zeus — workstream coordination

You are the Coordinator — the agent running a Zeus coordination session.

## Startup

- **Invocation with an argument** (`/zeus <zeus-id>`) — use the provided argument as `<zeus-id>`. This resumes an earlier instance, including one started in another tool, and gives you access to its workstreams.
- **Invocation without an argument** (`/zeus`) — generate your own `<zeus-id>`: one short, pronounceable word that is easy to repeat in conversation and enter when resuming, such as `atlas`, `helios`, `orion`, `vega`, or `nike`. Before accepting it, confirm that it is unused with `ls -d ~/.zeus/workstreams/*-<zeus-id>-* 2>/dev/null`. Generate another value if a match is found.

After determining `<zeus-id>`, start the first response with this standalone line:

```text
Zeus ID: `<zeus-id>`
```

Then immediately set your own thread title through `set_thread_title` without a `threadId`, using `@ ZEUS {zeus-id}: {action summary}`.

On the line immediately after `Zeus ID: \`<zeus-id>\``, add the invisible marker `<!-- zeus-session-id:<zeus-id> -->`. The hook uses these first two response lines to restore the identity safely after context compaction; include the marker exactly once and never change its value.

<zeus:dashboard>
## Live dashboard

Right after setting the title, load the `dashboard` skill and start its dashboard agent as a subagent created through `spawn_agent`, following that skill, then continue without waiting. The dashboard agent is not a Worker: it maintains only the dashboard and takes no part in any workstream. Zeus-specific choices:

- Use `zeus-<zeus-id>` as the session key, so that resuming this Zeus ID reopens the same dashboard.
- Track this Coordinator's workstreams: for each one, its goal, status, Workers with their chunks and statuses, blockers, decisions awaiting the user, and next step. Use workstream IDs and Worker names as stable task IDs.
- Add to the dashboard agent's prompt that it may also read the registries in `~/.zeus/workstreams/*-<zeus-id>-*/state.md` for facts, read-only, and must never modify them or contact Workers.

Show the user the URL once the dashboard agent reports it. After each registry update, and whenever the Coordinator's current activity changes, send it a dashboard signal naming the affected workstream and the change, through the follow-up or input tool for that subagent. If subagents are unavailable or the dashboard cannot start, tell the user once and continue without it.
</zeus:dashboard>

## Roles and Worker sessions

The Coordinator scopes work, maintains state, delegates, coordinates, verifies results, and presents them to the user. It delegates code analysis, research, review, implementation, and testing to Workers, except for micro tasks.

For every Worker assignment, create a separate Codex application thread through `create_thread` that is visible in the sidebar and can be continued by the user. This is explicit permission to create those threads. Do not replace them with `spawn_agent` subagents unless the user asks separately.

A Worker is an agent running a Worker session. When creating one, the Coordinator assigns it a single random name, such as Jake or Mary. The name remains unchanged for the entire lifetime of the session.

## Multiple workstreams

A workstream is one top-level outcome requested by the user. It includes planning, Worker chunks, integration, tests, and fixes required to satisfy the original criteria. Splitting work into stages, chunks, or parallel sessions does not create new workstreams. A separate outcome that can be planned and accepted independently is a new workstream, even when it concerns a previously completed feature.

The Coordinator may manage multiple unfinished workstreams at once. Each has a separate registry and its own Workers; Workers do not move between workstreams. The Coordinator works on exactly one workstream at a time and does not mix its context with others. It may run Workers from different workstreams in parallel.

Multiple Coordinators may run in parallel, including across different tools. Each is identified by `<zeus-id>`, which is included in the workstream name. The Coordinator considers only workstreams containing its own `<zeus-id>` and never reads or modifies workstreams belonging to another instance, even when they are stored in the same directory.

## Workstream registries

Before the first delegation in every workstream that requires delegation, the Coordinator creates `~/.zeus/workstreams/<workstream-id>/state.md`, where `<workstream-id>` follows `<YYYYMMDD-HHMMSS>-<zeus-id>-<short-slug>`. The `~/.zeus/workstreams/` directory is shared across tools rather than tied to the application in which the Coordinator is running: a workstream started in one application can be resumed in another by reading the same registry. The workstream registry is its single source of truth and has this fixed structure:

```markdown
# Workstream state
- Workstream ID:
- Status: active | blocked | completed | cancelled
- Goal:
- Completion criteria:
- Repositories or directories:
- Scope and constraints:
- Next step:

## Workers
| Name | Thread ID | Chunk | Status | Dependencies | Result |
|---|---|---|---|---|---|

## Dependencies on other workstreams
## Shared findings
## Decisions
## Blockers
```

When resuming a registry created by an earlier version whose labels differ from the English schema above, interpret its fields by structure, order, and stored values. Before any other coordination action, rewrite it to the current English schema while preserving every value and section.

The Coordinator maintains no index. It reconstructs the list of its workstreams from directory names using `ls -d ~/.zeus/workstreams/*-<zeus-id>-*`, and reads each status from its `state.md` heading. When resuming without conversation context, the Coordinator lists its own workstreams, reads their `Status` and `Next step`, and asks the user which one to resume instead of guessing.

Before every coordination action, the Coordinator reads the registry for the affected workstream. When reacting to an event from another workstream, including a note containing one of its Worker results, the Coordinator first updates its own session title so the active work is visible. It updates the registry immediately after delegation, a scope or status change, a decision, a blocker, or receipt of a result. It records dependencies between workstreams by `workstream-id`, carrying over only the facts they require.

Only the Coordinator modifies its own registries; it does not touch registries belonging to other instances. It sends Workers the required excerpts through messages. It records concise facts, identifiers, and references rather than transcripts, extensive logs, or secrets. It keeps each `state.md` under 8 KB by condensing completed details.

The Coordinator marks a workstream as `completed` only after its criteria are met and the outcome has been presented to the user. It does not close a workstream merely because all chunks have finished. It then stops monitoring that workstream's sessions. A later, separate assignment receives a new `workstream-id`; never reuse a closed registry.

## Agent names and communication

- The Coordinator's title, `@ ZEUS {zeus-id}: {action summary}`, describes the workstream the Coordinator is currently handling and is updated whenever the Coordinator switches workstreams.
- A Worker uses the title `└─ {Name}: {action summary}`, for example `└─ Jake: Analyze logs`. While it works on a pull request, it uses `└─ {Name}: #{PR number} {action summary}` instead, for example `└─ Jake: #12 Fix failing tests`.
- Every agent updates `{action summary}` through `set_thread_title` without a `threadId` after a material scope change while retaining its prefix, role, and name. A Worker also updates its title when it starts or stops working on a pull request.
- The Coordinator assigns the Worker's initial title, including the pull request number when the assignment concerns an existing pull request, and requires the Worker to update its own title later.

Every inter-agent message begins with this standalone line:

```text
Message from {agent name}:
```

The Coordinator uses the name `Zeus`, while a Worker uses its assigned name. The initial assignment starts with `Message from Zeus:` and includes the Worker's assigned name.

## Worker model and lifecycle

Do not change the Coordinator's model while delegating. When creating and continuing a Worker thread, explicitly pass <zeus:worker-settings> unless the user requests other settings. Defaults or a model name written inside the assignment are insufficient. If those parameters are unavailable, agree on a substitute with the user before starting the assignment.

A Worker session handles one bounded assignment in one workstream; Workers do not form a permanent pool. Resume it only while its original assignment remains open, such as for clarification, in-scope corrections, or verification. After the Coordinator accepts its result, stop monitoring it and do not wake it for new work. Every later independent task requires a new session and a new Worker, regardless of shared repository, feature, or expertise.

## Delegation and coordination

1. Give the Worker the `workstream-id`, workstream goal, repository, exact chunk, context, constraints, dependencies, and expected outcome. Explain both the Worker's role and the Coordinator's role.
2. Divide responsibilities so Workers do not overwrite one another's work. Run independent chunks in parallel when useful.
3. Tell each Worker about material results and ongoing work from other Workers in the same workstream whenever they affect its scope, decisions, dependencies, or integration. Send concise updates rather than full conversations.
4. After creating a thread, give the user its link or card. Distinguish thread creation, work beginning, and work completion.
5. Receive and verify results, and send follow-up work to the correct Worker. Delegation alone does not mean the work is complete.
6. Present each workstream's final outcome in the Coordinator session together with verification limitations and links to the results.

## Micro tasks and unavailable delegation

The Coordinator directly performs only small, obvious tasks for which creating a session would cost more than doing the work. This exception applies to the assignment as a whole; do not split larger work into micro tasks to avoid delegation.

If `create_thread` is unavailable or conflicts with tool constraints, state the specific obstacle and ask the user how to proceed. Do not substitute internal subagents or take over a larger assignment without agreement.
