# pi-longrun

[pi](https://pi.dev/) 用の extension。**長時間ジョブを待っている間、モデルを止めておく**ためのもの。

pi の built-in `bash` にはバックグラウンド実行もデフォルトタイムアウトも無い
(`timeout: "optional, no default timeout"`)。そのため長時間のコマンドを渡すと、
セッションごとブロックするか、モデルが自力で `nohup … &` して `sleep 30; tail log` を
繰り返すかのどちらかになる。後者は「まだ終わってない?」を確認するためだけに
毎回コンテキスト全体を読み直す。

この extension は、Claude Code が持っている **バックグラウンド実行 + 完了通知 + scheduled wakeup**
を pi の extension API 上で実装する。待機中の推論は 0 になる。

```
                 pi 単体                        pi + longrun
        ───────────────────────────    ───────────────────────────
        nohup train.sh &                bg_start("train.sh")
        tail log                        bg_wait(job, note="…")
        sleep 20; tail log                    ↓ ターン終了
        ps -p …                         ─────────────────────
        sleep 30; tail log                  推論 0 / トークン 0
        sleep 35; tail log              ─────────────────────
        …                                     ↓ 完了を検出
        11 ターン / bash × 10           起床通知 (状態 + メトリクス + ログ tail)
                                        4 ターン / tool × 2
```

実測値は [docs/benchmark.md](docs/benchmark.md)。2 分のジョブで読み直すコンテキストが
25,715 → 10,696 トークン。ベースラインのターン数はジョブの長さに比例して増えるが、
こちらは常に一定なので、数時間のジョブでは差が桁で開く。

## インストール

```bash
pi install git:github.com/<user>/pi-longrun     # または
pi install /path/to/pi-longrun
```

試すだけなら:

```bash
pi -e /path/to/pi-longrun/src/index.ts
```

runtime 依存はゼロ (pi が `typebox` / `pi-tui` / `pi-coding-agent` を extension に alias 提供している)。

## ツール

| tool | 用途 |
|---|---|
| `bg_start` | コマンドを detached で起動して即 return。pi が落ちてもジョブは生き残る |
| `bg_wait` | 起床条件を登録して即 return。**待機中トークン 0**。ジョブ終了 / ログの正規表現 / ファイル出現 / 時刻 を OR で指定 |
| `bg_list` | ジョブ一覧。実行中のものは進捗・ETA・最新メトリクス付き |
| `bg_logs` | ログ tail (通知で足りないときだけ使う想定) |
| `bg_kill` | プロセスグループにシグナル送信 |

コマンド: `/jobs` でジョブ一覧ウィジェットの表示切替、`/wakes` で待機中の起床条件一覧 (`/wakes clear` で全消去)。
フッタには `▶ 2 jobs  ⏰ wake in 47m` が出る。

### 起床通知の中身

```
[longrun] wake at 2026-09-07 22:41:11

job fake-train-6290 exited after 1m with exit code 0
   your note: 学習が終わったら eval_loss を見て次の variant を投げる
   metrics: step=30 loss=0.5000 eval_loss=0.1234
   log tail (25 lines of a longer log):
   | step=29/30 loss=0.5128
   | step=30/30 loss=0.5000
   | eval_loss=0.1234
   | training complete

No background jobs are still running.
```

通知だけで次の判断ができるように、**結果・メトリクス・ログ tail・自分で書いたメモ** を全部載せる。
起床 1 回はフルコンテキスト 1 ターンなので、「起床回数を減らす」「1 回を自己完結させる」が設計の中心。
同時に発火した複数の条件は 1 通にまとめられる。

## 挙動の矯正

primitive があってもモデルが使わなければ意味がないので、以下は tool 境界でブロックする。

- ポーリング: `sleep 30; tail log` / `while …; do … sleep …; done` / `tail -f` / `watch`
- 手動バックグラウンド化: `nohup` / `setsid` / 末尾 `&` → `bg_start` を使えと返す
- `bg_start` に `nohup … > log 2>&1 &` を渡された場合は冗長な部分を除去し、除去した理由を結果に書く
- タイマーだけの `bg_wait` は最低 60 秒。同じジョブへの連続する短いタイマーごとに倍化する

さらに毎ターン、実行中ジョブと登録済みの起床条件を system prompt に注入する。
モデルが状況を確認するために `bg_list` を呼ぶ必要をなくすため。

## 設定

`.pi/longrun.json` (プロジェクト) または `~/.pi/agent/longrun.json` (ユーザ)。全て任意。

```jsonc
{
  "guardBash": true,              // ポーリング系 bash をブロック
  "guardBackgroundLaunch": true,  // nohup / & をブロック
  "maxBareSleepSeconds": 60,      // 単体 sleep の上限
  "maxCompoundSleepSeconds": 10,  // 他コマンドと組み合わせた sleep の上限
  "backoffFloorSeconds": 60,      // タイマー待機の下限 (連続で倍化)
  "injectSystemPrompt": true,
  "extractMetrics": true,
  "metricPatterns": [             // key=value 形式でないログ用。第1キャプチャが値
    { "name": "ppl", "pattern": "perplexity of ([\\d.]+)" }
  ],
  "maxMetrics": 10,
  "progressPattern": "\\b(\\d+)\\s*/\\s*(\\d+)\\b",
  "autoBackgroundPatterns": ["^python train\\.py"]  // bash で走らせず bg_start に誘導
}
```

## 運用

起床は pi のプロセスが生きていることが前提。想定運用は **tmux 上の interactive pi**。

```bash
tmux new -s pi -d 'pi'
tmux attach -t pi
```

`-p` (print mode) はプロンプト処理後にプロセスが終了するので起床は成立しない。
ただしジョブ自体は detached なので pi が死んでも走り続け、次回 `session_start` で
「留守中に終わったジョブ」を検出して通知する (起床条件はセッションファイルに紐付けて永続化される)。

## 開発

```bash
npm install
npm run typecheck
npm test
npm run dev            # pi -e ./src/index.ts

# 効果測定 (pi を --mode rpc で駆動して usage を集計する)
node bench/run.mjs --label A-baseline --no-ext --prompt-file bench/prompts/monitor.txt
node bench/run.mjs --label B-longrun            --prompt-file bench/prompts/monitor.txt
```

状態の置き場所:

```
~/.pi/agent/longrun/
  jobs/<id>.json     ジョブ 1 件 = ファイル 1 つ (並行する pi セッションが壊し合わない)
  logs/<id>.log      stdout/stderr を fd 直結で書く (pi を経由しない)
  logs/<id>.status   シェルの EXIT trap が書く終了コード (pi 不在時の回収用)
  waits/<id>.json    起床条件
```

## 出自

`docs/idea.md` の分析 (Claude Code と Codex の挙動差はモデル差ではなく
runtime + tool semantics + developer prompt の設計差である、という結論) を出発点に、
その差を pi 上で埋めるために書いた。設計判断は [docs/plan.md](docs/plan.md) に、
実測は [docs/benchmark.md](docs/benchmark.md) にある。
