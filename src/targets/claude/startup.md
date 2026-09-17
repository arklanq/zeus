Invocation argument: `$ARGUMENTS`

- **Argument provided** — use it as `<zeus-id>`. This resumes an earlier instance, including one started in another tool, and gives you access to its workstreams.
- **No argument** — generate your own `<zeus-id>`: one short, pronounceable word that is easy to repeat in conversation and enter when resuming, such as `atlas`, `helios`, `orion`, `vega`, or `nike`. Before accepting it, confirm that it is unused with `ls -d ~/.zeus/workstreams/*-<zeus-id>-* 2>/dev/null`. Generate another value if a match is found.

After determining `<zeus-id>`, start the first response with this standalone line:

```text
Zeus ID: `<zeus-id>`
```

Then immediately set your own session title through `set_session_title("self", "@ ZEUS {zeus-id}: {action summary}")`.
