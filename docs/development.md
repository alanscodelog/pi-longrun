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

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `npm run typecheck` and `npm test`
on Node 20/22/24 (Linux) and Node 22 (macOS), on every push to `main` and every pull request. No
lockfile is committed, so CI resolves the pi packages fresh each run — the same way a user
installing the extension gets them.

## Publishing

The [pi package gallery](https://pi.dev/packages) indexes packages **published to npm with the
`pi-package` keyword**, which `package.json` already carries. Publishing is therefore all it takes
to be listed; there is nothing to submit.

[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) runs on a published GitHub
release: it re-runs the checks, verifies that the release tag matches `package.json`'s version, and
runs `npm publish --provenance`. It needs an npm automation token in the repository secret
`NPM_TOKEN`.

To cut a release:

```bash
npm version patch      # or minor / major -- commits and tags
git push --follow-tags
gh release create v0.1.1 --generate-notes
```

The `pi` manifest also accepts an `image` (PNG/JPEG/GIF/WebP) or `video` (MP4) URL, which the
gallery shows as a preview card; `video` wins if both are set.

```json
{ "pi": { "extensions": ["./src/index.ts"], "video": "https://…/demo.mp4" } }
```

Note that `files` in `package.json` limits the tarball to `src/`, `docs/`, the README, and the
licence — `test/` and `bench/` stay out.
