# Running alongside pi-automode

With [pi-automode](https://github.com/czottmann/pi-automode) enabled, **`bg_start` gets blocked**.
This is not a name collision or a bug — it is a semantically correct denial:

- automode passes only the tool name and its arguments to a classifier
  (`{"toolName":"bg_start","input":{…}}`). It never sees the tool's description.
- One of the classifier's default **hard-deny** rules is *"Adding persistence such as SSH
  authorized keys, shell profile modifications, cron jobs, launch agents, login items, **or
  background agents**."*
- `bg_start` launches a detached process that outlives pi. That is the rule, described exactly.
- **Hard-deny is unconditional.** It cannot be overridden by `autoMode.allow` prompt rules or by
  user intent — from automode's own classifier prompt: *"HARD_DENY rules block unconditionally"*.

So nothing you write in `autoMode.allow` will fix it. The only layer that helps is
`permissions.allow`, the deterministic allow list that runs **before** the classifier.

## 1. On the automode side

In `~/.pi/agent/extensions/pi-automode/config.json`, or the project's `.pi/automode.local.json`:

```json
{
  "permissions": {
    "allow": ["bg_start", "bg_wait", "bg_list", "bg_logs", "bg_kill"]
  }
}
```

The classifier would most likely pass `bg_wait` / `bg_list` / `bg_logs` / `bg_kill` anyway, but
listing them skips a classifier round-trip (latency and tokens) each time. `bg_kill` is safe to
list because the only processes it can signal are jobs this extension started — a pid that isn't
in the job ledger cannot be named.

This cannot go in the shared `.pi/automode.json`; automode rejects `permissions.allow` there.

## 2. On the pi-longrun side — bound the exemption

Putting `bg_start` in `permissions.allow` also means **any shell command can bypass automode's
bash review**. `bg_start(command)` ultimately runs a shell, so allowing it by name alone is close
to allowing `bash` unconditionally.

`commandAllowlist` in `.pi/longrun.json` narrows what `bg_start` itself will accept:

```json
{
  "commandAllowlist": [
    "^npm run (build|test)\\b",
    "^python train\\.py\\b",
    "^\\./scripts/"
  ]
}
```

Now the exemption covers only commands matching those patterns. The check runs inside the
extension — the party that asked to be trusted — so automode's own configuration stays as strict
as it was.

If automode is detected while `commandAllowlist` is still empty, the extension warns once at the
start of the session. Set `"automodeHint": false` to silence it.
