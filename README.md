# pi-longrun

[![CI](https://github.com/takuma104/pi-longrun/actions/workflows/ci.yml/badge.svg)](https://github.com/takuma104/pi-longrun/actions/workflows/ci.yml)

Background jobs, wake-up conditions, and completion notifications for [pi](https://pi.dev/) —
so the model spends **no tokens while a long job runs**.

pi's built-in `bash` has neither background execution nor a default timeout
(`timeout: "optional, no default timeout"`). Hand it a long-running command and you get one of
two outcomes: the session blocks until the command finishes, or the model backgrounds it by hand
with `nohup … &` and settles into `sleep 30; tail log` — re-reading its whole context every turn
just to ask "done yet?".

This extension implements what Claude Code has — background execution, completion notification,
scheduled wake-up — on top of pi's extension API.

```
                 pi alone                       pi + longrun
        ───────────────────────────    ───────────────────────────
        nohup train.sh &                bg_start("train.sh")
        tail log                        bg_wait(job, note="…")
        sleep 20; tail log                    ↓ turn ends
        ps -p …                         ─────────────────────
        sleep 30; tail log                 0 inference / 0 tokens
        sleep 35; tail log              ─────────────────────
        …                                     ↓ completion detected
        11 turns / 10 bash calls        wake-up (status + metrics + log tail)
                                        4 turns / 2 tool calls
```

Measured on a 2-minute job: the context the model re-reads drops from 25,715 to 10,696 tokens
([docs/benchmark.md](docs/benchmark.md)). The baseline's turn count grows with the length of the
job while this stays flat, so the gap widens by orders of magnitude on multi-hour runs.

## Install

```bash
pi install git:github.com/takuma104/pi-longrun     # or
pi install /path/to/pi-longrun
```

Just to try it out:

```bash
pi -e /path/to/pi-longrun/src/index.ts
```

No runtime dependencies — pi aliases `typebox` / `pi-tui` / `pi-coding-agent` into extensions.

## Tools

| tool | what it does |
|---|---|
| `bg_start` | Launch a command detached and return immediately. The job outlives pi |
| `bg_wait` | Register a wake-up condition and return immediately. **Zero tokens while waiting.** Job exit / log regex / file appearing / wall-clock time, OR-ed together |
| `bg_list` | List jobs, with progress, ETA, and latest metrics for the running ones |
| `bg_logs` | Tail a log (only when the notification wasn't enough) |
| `bg_kill` | Send a signal to a job's process group |

Commands: `/jobs` toggles the job-list widget, `/wakes` lists pending wake-ups
(`/wakes clear` drops them all). The footer shows `▶ 2 jobs  ⏰ wake in 47m`.

A wake-up carries everything needed to decide what to do next — result, metrics, log tail, and
the note the model left for itself — because one wake-up costs one full-context turn:

```
[longrun] wake at 2026-09-07 22:41:11

job fake-train-6290 exited after 1m with exit code 0
   your note: check eval_loss when training ends, then launch the next variant
   metrics: step=30 loss=0.5000 eval_loss=0.1234
   log tail (25 lines of a longer log):
   | step=29/30 loss=0.5128
   | step=30/30 loss=0.5000
   | eval_loss=0.1234
   | training complete

No background jobs are still running.
```

`bg_wait` has exactly one contract: **if the call succeeds, you will be woken exactly once** —
including when the job had already finished before the call. See
[docs/design.md](docs/design.md) for why that has no exceptions.

## Guardrails

A primitive the model never reaches for is worthless, so these are blocked at the tool boundary:

- polling — `sleep 30; tail log`, `while …; do … sleep …; done`, `tail -f`, `watch`
- manual backgrounding — `nohup`, `setsid`, a trailing `&`, answered with a pointer to `bg_start`
- timer-only `bg_wait` below 60s, doubled for each consecutive short timer on the same job

Running jobs and pending wake-ups are also injected into the system prompt every turn, so the
model never has to spend a `bg_list` call to work out where it stands.

## Configuration

Optional: `.pi/longrun.json` (project) or `~/.pi/agent/longrun.json` (user). Guardrail thresholds,
metric extraction patterns, and the `bg_start` command allowlist —
see [docs/configuration.md](docs/configuration.md).

**Using [pi-automode](https://github.com/czottmann/pi-automode)?** Its classifier hard-denies
`bg_start` as a "background agent". It takes a `permissions.allow` entry there plus a
`commandAllowlist` here — [docs/pi-automode.md](docs/pi-automode.md).

## Running it

Wake-ups require the pi process to stay alive, so the intended setup is an interactive pi under
tmux:

```bash
tmux new -s pi -d 'pi'
tmux attach -t pi
```

`-p` (print mode) exits once the prompt is handled, so no wake-up can arrive. Jobs themselves are
detached and keep running even if pi dies; the next `session_start` reports the ones that finished
while pi was away.

## Docs

- [docs/configuration.md](docs/configuration.md) — every option, and what each guardrail blocks
- [docs/pi-automode.md](docs/pi-automode.md) — running alongside pi-automode
- [docs/design.md](docs/design.md) — the `bg_wait` contract, notification design, persistence
- [docs/development.md](docs/development.md) — tests, benchmark harness, state layout
- [docs/benchmark.md](docs/benchmark.md) — measurements (Japanese)
- [docs/plan.md](docs/plan.md), [docs/idea.md](docs/idea.md) — design decisions and where this
  started: the difference between Claude Code and Codex on long jobs is a matter of runtime,
  tool semantics, and developer prompt, not of model (Japanese)

## License

MIT
