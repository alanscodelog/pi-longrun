# Configuration

Everything is optional; the defaults are what the extension ships with. Settings are read from
`.pi/longrun.json` (project) and `~/.pi/agent/longrun.json` (user), merged in that order over the
defaults — a project file wins over a user file, and either wins over a default.

```jsonc
{
  "guardBash": true,              // block polling-shaped bash commands
  "guardBackgroundLaunch": true,  // block nohup / setsid / trailing &
  "maxBareSleepSeconds": 60,      // ceiling for a standalone sleep
  "maxCompoundSleepSeconds": 10,  // ceiling for a sleep combined with other commands
  "backoffFloorSeconds": 60,      // floor for a timer-only bg_wait (doubles on repeats)
  "injectSystemPrompt": true,     // put running jobs and pending wakes in the system prompt
  "extractMetrics": true,         // pull key=value numbers out of log tails
  "metricPatterns": [             // for logs that are not key=value; capture group 1 is the value
    { "name": "ppl", "pattern": "perplexity of ([\\d.]+)" }
  ],
  "maxMetrics": 10,               // cap, so a chatty log cannot flood a notification
  "progressPattern": "\\b(\\d+)\\s*/\\s*(\\d+)\\b",   // capture groups: current, total
  "autoBackgroundPatterns": ["^python train\\.py"],   // never run these in bash
  "commandAllowlist": [],         // empty = unrestricted; set it when using pi-automode
  "automodeHint": true            // warn once per session when pi-automode is active
}
```

## Guardrails

### `guardBash`

Rejects `bash` calls that are a wait-and-check loop in disguise. Each rejection explains what to
use instead, so the model can recover on its own rather than retrying:

| blocked | example |
|---|---|
| `tail -f` | `tail -f train.log` → use `bg_wait` with a `log_pattern` |
| `watch` | `watch -n5 nvidia-smi` |
| loop with a sleep | `while ! test -f done; do sleep 10; done` |
| standalone `sleep` at or above `maxBareSleepSeconds` | `sleep 120` → use `bg_wait` with `after_seconds` |
| `sleep` totalling `maxCompoundSleepSeconds` or more alongside another command | `sleep 30; tail log` |
| anything matching `autoBackgroundPatterns` | opt-in per project |

A short standalone `sleep` and a short compound one both still run — the point is to stop polling,
not to ban `sleep`.

`autoBackgroundPatterns` is the opt-in half: list the commands this project knows are long-running
(`"^python train\\.py"`, `"^npm run e2e"`), and running them in `bash` is refused with a pointer to
`bg_start`. An unparseable regex is ignored rather than breaking the tool call.

### `guardBackgroundLaunch`

Rejects `nohup`, `setsid`, and a trailing `&` in `bash`. A process started that way has no entry in
the job ledger, so nothing can watch it, record its exit code, or notify anyone about it.

`bg_start` handles the same habit differently: instead of refusing
`nohup ./train.sh > out.log 2>&1 &`, it strips the redundant parts and reports what it removed in
the tool result. The redirect matters most — left in place, output goes to a file the job log never
sees, and `bg_logs` and wake notifications come back empty. Redirects to `/dev/null` and
stderr-only redirects are deliberate, and are kept.

### `backoffFloorSeconds`

A `bg_wait` with only `after_seconds` is raised to at least this many seconds, and each consecutive
short timer on the same job doubles the floor. Waking early only re-reads the context without
learning anything new; Claude Code clamps its own equivalent to 60s for the same reason. Waits with
a real condition (job exit, `log_pattern`, `file`) are not affected.

## Metrics and progress

When `extractMetrics` is on, numeric `key=value` pairs in the log tail (`loss=0.51`,
`eval_loss=0.1234`) are collected and shown in `bg_list` and in every wake notification, capped at
`maxMetrics`. Logs that don't use `key=value` get named rules through `metricPatterns`, where the
first capture group is the value:

```json
{ "metricPatterns": [{ "name": "ppl", "pattern": "perplexity of ([\\d.]+)" }] }
```

`progressPattern` needs two capture groups, current and total. The default matches `step 30/100`
and similar, and drives the progress and ETA columns in `bg_list` and the footer.

## `commandAllowlist`

When non-empty, `bg_start` only accepts commands matching one of these regexes:

```json
{
  "commandAllowlist": [
    "^npm run (build|test)\\b",
    "^python train\\.py\\b",
    "^\\./scripts/"
  ]
}
```

This exists for auto-approval setups. See [pi-automode.md](pi-automode.md).
