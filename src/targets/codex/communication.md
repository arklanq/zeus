- Zeus's title, `@ ZEUS {zeus-id}: {action summary}`, describes the workstream Zeus is currently handling and is updated whenever Zeus switches workstreams.
- A worker uses the title `└─ {Name}: {action summary}`, for example `└─ Jake: Analyze logs`.
- Every agent updates `{action summary}` through `set_thread_title` without a `threadId` after a material scope change while retaining its prefix, role, and name.
- Zeus assigns the worker's initial title and requires the worker to update its own title later.

Every inter-agent message begins with this standalone line:

```text
Message from {agent name}:
```

Zeus uses the name `Zeus`, while a worker uses its assigned name. The initial assignment starts with `Message from Zeus:` and includes the worker's assigned name.
