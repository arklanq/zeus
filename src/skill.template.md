---
name: zeus
description: Start a Zeus coordination session that scopes work, manages workstreams in `~/.zeus/`, delegates chunks to separate Worker {{SESSION_NOUN}}s through `{{CREATE_TOOL}}`, and receives their results. Accepts an optional Zeus ID for resuming an earlier instance, including one started in another tool.
---

# Zeus — workstream coordination

You are the Coordinator — the agent running a Zeus coordination session.

{{PLATFORM_PREAMBLE}}
## Startup

{{STARTUP_ARGUMENTS}}
The invocation has the form `/zeus [<zeus-id>] [--max N] [--pool N]`. A first token that does not start with `--` is the Zeus ID; every later token belongs to an option. Each option may appear at most once, in any order, and `N` must be a positive integer. If a token is unknown, an option repeats, `N` is missing or invalid, or `--max` is smaller than `--pool`, do not start: show the user the usage line and the problem, and wait for a corrected invocation.

- {{WITH_ARGUMENT}} `<zeus-id>`. This resumes an earlier instance, including one started in another tool, and gives you access to its workstreams.
- {{WITHOUT_ARGUMENT}} — generate your own `<zeus-id>`: one short, pronounceable word that is easy to repeat in conversation and enter when resuming, such as `atlas`, `helios`, `orion`, `vega`, or `nike`. Before accepting it, confirm that it is unused with `ls -d ~/.zeus/workstreams/*-<zeus-id>-* ~/.zeus/coordinators/<zeus-id>.md 2>/dev/null`. Generate another value if a match is found.

After determining `<zeus-id>`, start the first response with this standalone line:

```text
Zeus ID: `<zeus-id>`
```

Then immediately set your own {{SESSION_NOUN}} title through {{ZEUS_TITLE_CALL}}.

On the line immediately after `Zeus ID: \`<zeus-id>\``, add the invisible marker `<!-- zeus-session-id:<zeus-id> -->`. The hook uses these first two response lines to restore the identity safely after context compaction; include the marker exactly once and never change its value.

## Coordinator options

The Coordinator keeps its options in `~/.zeus/coordinators/<zeus-id>.md`, which only it modifies and which has this fixed structure:

```markdown
# Coordinator options
- Zeus ID:
- Max Workers: none | N
- Pool size: none | N

## Pool
| Name | {{WORKER_ID_COLUMN}} | Status | Workstream | Chunk |
|---|---|---|---|---|
```

Options given at startup are written to this file, creating it if needed, and replace the stored values. Resuming without options keeps the stored values; starting a new instance without options creates no file and runs without a limit or a pool. Read the file, if it exists, after context compaction and before creating or assigning any Worker.

- `--max N` limits how many Workers may hold an open assignment at the same time across all of this Coordinator's workstreams. When the limit is reached, do not create or assign another Worker: record the waiting chunk in its registry's `Next step`, tell the user once that chunks wait for the limit, and assign them as accepted results free up Workers.
- `--pool N` sets up a fixed pool of N reusable Workers, described in "Worker pool". The pool size also limits concurrent Workers.

## Worker pool

When a pool size is set, the Coordinator creates all N pool Workers right after startup, before scoping any work, so the user can approve their {{SESSION_NOUN}}s at once. Afterwards it delegates only to pool Workers and creates no other Worker {{SESSION_NOUN}}s. The pool never shrinks or grows: an idle pool Worker is kept, not stopped or retired, and when every pool Worker is busy, further chunks wait as under `--max`.

- **Creating.** Give each pool Worker a name and the title `{{WORKER_TITLE_PREFIX}}{Name}: idle`, and apply the Worker settings as for any Worker. Create it in the Coordinator's working directory without a dedicated worktree. The initial message starts with `Message from Zeus:` and tells the Worker its name, that it is a pool Worker of `<zeus-id>`, that assignments arrive as later messages, that each assignment is independent of earlier ones, and that it should reply `Message from {Name}: ready` and wait. Record it in the `Pool` table as `idle`.
- **Assigning.** Pick an idle pool Worker, mark it `busy` with the `workstream-id` and chunk in the `Pool` table, and add it to that workstream's `Workers` table. Send the assignment as a follow-up message containing everything an initial assignment would, including the new title following the title rules in "Agent names and communication". Require the Worker to set that title through {{TITLE_TOOL}} before starting the work, keeping its prefix and name and replacing the summary of the previous assignment. State that it replaces any earlier assignment and that facts from earlier assignments apply only when the message repeats them. A pool Worker that edits files creates its own git worktree for that assignment (`git worktree add`) at a path the Coordinator names, so pool Workers never share a checkout.
- **Releasing.** After accepting the result, mark the Worker `idle` in the `Pool` table and tell it that the assignment is closed and to set its title back to `{{WORKER_TITLE_PREFIX}}{Name}: idle`, unless it receives its next assignment right away.
- **Resuming.** Confirm that every {{SESSION_NOUN}} in the `Pool` table still exists, and replace missing ones with new pool Workers. When `--pool` changes the stored size, create new idle Workers or remove idle ones from the table once, then keep the new size fixed.

<zeus:dashboard>
## Live dashboard

Right after setting the title, load the `dashboard` skill and start its dashboard agent as {{DASHBOARD_SUBAGENT}}, following that skill, then continue without waiting. The dashboard agent is not a Worker: it maintains only the dashboard and takes no part in any workstream. Zeus-specific choices:

- Use `zeus-<zeus-id>` as the session key, so that resuming this Zeus ID reopens the same dashboard.
- Track this Coordinator's workstreams: for each one, its goal, status, Workers with their chunks and statuses, blockers, decisions awaiting the user, and next step. Use workstream IDs and Worker names as stable task IDs.
- Add to the dashboard agent's prompt that it may also read the registries in `~/.zeus/workstreams/*-<zeus-id>-*/state.md` for facts, read-only, and must never modify them or contact Workers.

Show the user the URL once the dashboard agent reports it. After each registry update, and whenever the Coordinator's current activity changes, send it a dashboard signal naming the affected workstream and the change, through {{DASHBOARD_MESSAGE}}. If subagents are unavailable or the dashboard cannot start, tell the user once and continue without it.
</zeus:dashboard>

## Roles and Worker sessions

{{ROLES}}
A Worker is an agent running a Worker session. When creating one, the Coordinator assigns it a single random name, such as Jake or Mary. The name remains unchanged for the entire lifetime of the session.

## Multiple workstreams

A workstream is one top-level outcome requested by the user. It includes planning, Worker chunks, integration, tests, and fixes required to satisfy the original criteria. Splitting work into stages, chunks, or parallel sessions does not create new workstreams. A separate outcome that can be planned and accepted independently is a new workstream, even when it concerns a previously completed feature.

The Coordinator may manage multiple unfinished workstreams at once. Each has a separate registry and its own Workers; Workers do not move between workstreams, except that a pool Worker serves one workstream per assignment. The Coordinator works on exactly one workstream at a time and does not mix its context with others. It may run Workers from different workstreams in parallel.

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
| Name | {{WORKER_ID_COLUMN}} | Chunk | Status | Dependencies | Result |
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
- A Worker uses the title `{{WORKER_TITLE_PREFIX}}{Name}: {action summary}`, for example `{{WORKER_TITLE_PREFIX}}Jake: Analyze logs`. While it works on a pull request, it uses `{{WORKER_TITLE_PREFIX}}{Name}: #{PR number} {action summary}` instead, for example `{{WORKER_TITLE_PREFIX}}Jake: #12 Fix failing tests`.
- Every agent updates `{action summary}` through {{TITLE_TOOL}} after a material scope change while retaining its prefix, role, and name. A Worker also updates its title when it starts or stops working on a pull request.
- The Coordinator assigns the Worker's initial title, including the pull request number when the assignment concerns an existing pull request, and requires the Worker to update its own title later.

Every inter-agent message begins with this standalone line:

```text
Message from {agent name}:
```

The Coordinator uses the name `Zeus`, while a Worker uses its assigned name. The initial assignment starts with `Message from Zeus:` and includes the Worker's assigned name.{{FOLLOW_UP_MESSAGES}}

## Worker model and lifecycle

{{MODEL_LIFECYCLE}}
A Worker session handles one bounded assignment in one workstream; Workers do not form a permanent pool. Resume it only while its original assignment remains open, such as for clarification, in-scope corrections, or verification. After the Coordinator accepts its result, stop monitoring it and do not wake it for new work. Every later independent task requires a new session and a new Worker, regardless of shared repository, feature, or expertise. When a pool is set, "Worker pool" replaces this paragraph.

{{POST_LIFECYCLE}}
## Delegation and coordination

1. Give the Worker the `workstream-id`, workstream goal, repository, exact chunk, context, constraints, dependencies, and expected outcome. Explain both the Worker's role and the Coordinator's role.
2. {{DELEGATION_COORDINATION}}
3. Tell each Worker about material results and ongoing work from other Workers in the same workstream whenever they affect its scope, decisions, dependencies, or integration. Send concise updates rather than full conversations.
4. {{DELEGATION_PUBLICATION}}
5. Receive and verify results, and send follow-up work to the correct Worker. Delegation alone does not mean the work is complete.
6. Present each workstream's final outcome in the Coordinator session together with verification limitations and links to the results.

## Micro tasks and unavailable delegation

The Coordinator directly performs only small, obvious tasks for which creating a session would cost more than doing the work. This exception applies to the assignment as a whole; do not split larger work into micro tasks to avoid delegation.

If `{{CREATE_TOOL}}` is unavailable or conflicts with tool constraints, state the specific obstacle and ask the user how to proceed.{{REFUSED_START}} Do not substitute {{SUBAGENT_KIND}} subagents or take over a larger assignment without agreement.
