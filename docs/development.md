# Development

```bash
npm install
npm run typecheck
npm test               # vitest
npm run dev            # pi -e ./src/index.ts
```

## Benchmark harness

`bench/run.mjs` drives pi in `--mode rpc` and aggregates the usage reported in its JSONL events:

```bash
node bench/run.mjs --label A-baseline --no-ext --prompt-file bench/prompts/monitor.txt
node bench/run.mjs --label B-longrun            --prompt-file bench/prompts/monitor.txt
```

RPC mode is the only correct environment for this measurement: print mode (`-p`) exits once the
prompt is handled, so the process dies before any wake-up arrives.

`bench/fake-train.sh <steps> <delay>` is the stand-in job — it prints `step=N loss=…` per step and
`eval_loss=0.1234` at the end, reproducing the property that matters (wall-clock time greatly
exceeding agent reasoning time). Prompts live in `bench/prompts/`. Results are in
[benchmark.md](benchmark.md).

One caveat when scripting pi: `pi -p` waits for EOF on piped stdin, so calls from a script need
`< /dev/null` or they never exit — with or without this extension. `bench/run.mjs` manages stdin
itself in RPC mode and is unaffected.

## Layout

```
src/
  index.ts      extension entry: hooks, commands, session lifecycle
  tools.ts      bg_start / bg_wait / bg_list / bg_logs / bg_kill
  jobs.ts       job ledger, spawning, exit-code collection
  waits.ts      wake conditions and their persistence
  wake.ts       condition evaluation and notification delivery
  guards.ts     bash guardrails, command normalisation, wait backoff
  config.ts     .pi/longrun.json loading and defaults
  metrics.ts    metric and progress extraction from log tails
  ui.ts         job widget, footer status
  format.ts     shared formatting helpers
```

Runtime state layout is documented in [design.md](design.md#persistence-and-process-lifetime).
