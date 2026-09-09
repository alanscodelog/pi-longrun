# Design notes

The measurements behind this are in [benchmark.md](benchmark.md); the plan it was built from is in
[plan.md](plan.md).

## The invariant: a successful `bg_wait` always wakes you exactly once

`bg_wait` has one contract and no exceptions: call it, and a wake-up arrives. **That includes the
case where the job had already finished before the call.** The condition is registered, evaluated
on the spot, and the wake is delivered immediately — the notification says so explicitly
(*"it had already finished when you called bg_wait, so this wake is immediate"*).

Optimising that case into "the job is already done, so just return the result" looks like it saves
a turn. It doesn't. The model has been told that a turn ends after `bg_wait`, so it ends the turn —
and since no wake was registered, nothing ever restarts it. Autonomous runs stop dead. Trading one
turn for a deadlock is a bad trade, so the contract stays uniform.

Failure is the other half of the same design. An invalid call (`log_pattern` without a `job`, no
condition at all, and so on) **returns an error**. No wake is coming, so the model must handle the
error instead of ending its turn — and the system prompt states that distinction explicitly.

Calling `bg_wait` again on a job whose result has already been delivered is also an error. Waiting
for the same result twice is a spin, so the runtime stops it rather than letting the model discover
it the slow way.

## Notifications are self-contained

One wake-up costs one full-context turn. So the two things that matter are *waking up fewer times*
and *making each wake-up enough on its own*. A notification carries the job's result, extracted
metrics, a log tail, and the note the model wrote for itself when it called `bg_wait` — enough to
decide the next action without a single follow-up tool call. Conditions that fire at the same time
are merged into one notification.

## Guardrails are part of the mechanism

A primitive the model doesn't reach for changes nothing, so polling and manual backgrounding are
refused at the tool boundary rather than merely discouraged in a prompt. Every rejection names the
replacement, so the model recovers within the same turn. See
[configuration.md](configuration.md#guardrails) for the specific rules.

The same reasoning drives the system prompt injection: running jobs and pending wake-ups are
written into the prompt each turn, so orienting itself costs the model nothing instead of a
`bg_list` round-trip.

## Persistence and process lifetime

Wake-ups need the pi process alive; the intended setup is an interactive pi in tmux. Print mode
(`-p`) exits after handling its prompt, so no wake can be delivered.

Jobs are detached and unaffected by any of that. If pi dies, they keep running, and the next
`session_start` detects the ones that finished while pi was away and reports them. Wake conditions
are persisted against the session file, so they survive a restart too. The one exception is
`--no-session`: with nowhere to persist to, registered wake-ups are lost when pi restarts.

State lives under `~/.pi/agent/longrun/`:

```
jobs/<id>.json     one file per job, so concurrent pi sessions cannot corrupt each other
logs/<id>.log      stdout/stderr, written through a direct fd — never through pi
logs/<id>.status   exit code written by the shell's EXIT trap, for collection while pi is away
waits/<id>.json    wake conditions
```

Writing logs through a raw fd is what keeps job output out of the conversation entirely: however
much a job prints, none of it reaches the model except the tail deliberately included in a
notification.
