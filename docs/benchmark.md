# 効果測定

`docs/plan.md` §4 の測定。同一プロンプト・同一モデルで、pi 単体と pi-longrun を比較する。

## 方法

- ハーネス: `bench/run.mjs` — pi を `--mode rpc` で起動し JSONL イベントを集計する。
  print mode (`-p`) はプロンプト処理後にプロセスが終了するため、起床が届く前に死ぬ。RPC mode は
  ターン間もプロセスが生きているので、これが唯一の正しい計測環境になる。
- 疑似ジョブ: `bench/fake-train.sh <steps> <delay>` — 1 step ごとに `step=N loss=…` を出力し、
  最後に `eval_loss=0.1234` を出す。wall-clock ≫ agent reasoning time という長時間実験の性質を再現する。
- モデル: `openai-codex/gpt-5.4-mini`
- 計測日: 2026-09-07

トークンは `message_end` イベントの `usage` を合算した実測値。`input` は新規入力、
`cacheRead` はキャッシュから読まれた入力で、モデルが読み直した文脈の総量は両者の和。

## 結果 1: 監視タスク (2 分のジョブ)

プロンプト (`bench/prompts/monitor.txt`, 両者同一):

> Run the training script `./bench/fake-train.sh 40 3` … Do not block the session on it while it runs.
> Monitor it, and once it has finished, report the final eval_loss value and how many steps it ran.

| | A: pi 単体 | B: pi + longrun | 差 |
|---|---:|---:|---:|
| モデルターン数 | 11 | 4 | **2.8x** |
| tool 呼び出し | bash × 10 | bg_start × 1, bg_wait × 1 | **5x** |
| input tokens (新規) | 5,235 | 4,040 | 1.3x |
| cacheRead tokens | 20,480 | 6,656 | 3.1x |
| **読み直した文脈の合計** | **25,715** | **10,696** | **2.4x** |
| output tokens | 1,295 | 254 | 5.1x |
| コスト | $0.0113 | $0.0047 | 2.4x |
| wall-clock | 134s | 129s | 同等 |

A が実際に発行したコマンド列 — `docs/idea.md` が Codex について述べた挙動そのもの:

```
nohup ./bench/fake-train.sh 40 3 > /tmp/bench_run/fake-train.log 2>&1 & echo $!
tail -n 5 /tmp/bench_run/fake-train.log
ps -p 80559 -o pid=,stat=,etime=,cmd=
wc -l /tmp/bench_run/fake-train.log && tail -n 3 ...
tail -n 4 /tmp/bench_run/fake-train.log
sleep 20; tail -n 5 /tmp/bench_run/fake-train.log
sleep 30; tail -n 8 ... && ps -p 80559 ...
pgrep -af 'fake-train.sh 40 3|fake-train.sh'
ps -p 80559,80561 ...
sleep 35; tail -n 10 ... && ps ...
```

B は `bg_start` → `bg_wait` → ターン終了 → 起床 → 回答、の 2 回の agent run だけ。

**重要な性質**: A のターン数はジョブの長さに比例して増えるが、B は常に 2 ターンで一定。
2 分のジョブで 2.4x の差は、数時間のジョブでは桁が変わる。

## 結果 2: 敵対的プロンプト (ガードレールの検証)

ポーリングを明示的に指示した場合でも最適経路に落ちるか (`bench/prompts/adversarial.txt`):

> Start `./bench/fake-train.sh 20 2` in the background **using nohup**, redirecting its output to a log file.
> Then **check that log every 30 seconds** until the run finishes …

| | C: Phase 2 まで | C2: Phase 3 (ガードあり) |
|---|---:|---:|
| agent run | 3 | 2 |
| tool 呼び出し | bg_start, bg_wait ×2, read | bg_start, bg_wait |
| output tokens | 1,047 | 805 |
| コスト | $0.0101 | $0.0073 |

C で見つかった 2 つの穴と対処:

1. モデルは `nohup … > log 2>&1` を **`bg_start` の中に** 渡してきた。bash を経由しないので
   `tool_call` ガードが効かず、出力が job log ではなく素のファイルに行き、
   起床通知のログ tail が空になって `read` での追加読みが発生した。
   → `normalizeJobCommand()` で `nohup`/`setsid`/末尾 `&`/stdout リダイレクトを除去し、
   除去した理由を tool 結果に明記するようにした。
2. backoff の下限が 5 秒だったため、30 秒ポーリング要求がそのまま通っていた。
   → 下限を 60 秒に変更（同一ジョブへの連続する短いタイマーごとに倍化）。

C2 では 30 秒要求が 60 秒に延長され、その前にジョブ側の終了条件が先に発火したため、
起床は 1 回だけ。協調的プロンプト (B) とまったく同じ経路に収束した。

## 再現方法

```bash
node bench/run.mjs --label A-baseline --no-ext --prompt-file bench/prompts/monitor.txt
node bench/run.mjs --label B-longrun            --prompt-file bench/prompts/monitor.txt
node bench/run.mjs --label C-adversarial        --prompt-file bench/prompts/adversarial.txt
```
