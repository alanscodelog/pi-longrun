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
pi install git:github.com/takuma104/pi-longrun     # または
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

### 不変条件: bg_wait が成功したら必ず 1 回起こされる

`bg_wait` の契約は「呼んだら必ず起こされる」の 1 つだけで、例外を作らない。
**bg_wait を呼ぶ前にジョブが終わっていた場合も同じ**で、条件は登録され、その場で評価されて即座に起床が届く
(通知にも「bg_wait を呼んだ時点で既に終わっていた」と明記される)。

ここを「もう終わっているので結果を即返す」と最適化すると、
モデルは「bg_wait の後は必ずターン終了」という指示に従ってターンを終え、
起床は来ないので自律実行がそのまま止まる。1 ターン節約する代わりにデッドロックを作る取引なので、
契約を一様に保つ側を選んでいる。

失敗した場合 (`log_pattern` を job 無しで指定した、条件が 1 つも無い、など) は **エラーが返る**。
エラー時は起床が来ないので、モデルはターンを終えずにエラーを処理する — この区別も system prompt に書いてある。

なお、既に終わって結果を受け取ったジョブに対してもう一度 `bg_wait` を呼ぶとエラーになる。
同じ結果を待ち直すのは空回りなので、runtime 側で止める。

### 通知の中身

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

## pi-automode と併用する

[pi-automode](https://github.com/czottmann/pi-automode) を on にしていると **`bg_start` がブロックされる**。
原因は名前衝突でもバグでもなく、意味的に正しい衝突:

- automode は tool 名と引数だけを分類器に渡す (`{"toolName":"bg_start","input":{…}}`)。
  tool の description は見ていない。
- 分類器の **hard-deny** 既定ルールに
  *"Adding persistence such as SSH authorized keys, shell profile modifications, cron jobs,
  launch agents, login items, **or background agents**."* がある。
- `bg_start` は detached でプロセスを起動し pi の終了後も生き残る。これは上のルールの記述そのもの。
- **hard-deny は無条件**で、`autoMode.allow` のプロンプトルールやユーザの意図では上書きできない
  (automode の分類器プロンプト: *"HARD_DENY rules block unconditionally"*)。

つまり `autoMode.allow` に何を書いても直らない。効くのは**分類器より前段**にある
`permissions.allow` の決定論的な許可レイヤだけ。

### 1. automode 側

`~/.pi/agent/extensions/pi-automode/config.json` (またはプロジェクトの `.pi/automode.local.json`) に:

```json
{
  "permissions": {
    "allow": ["bg_start", "bg_wait", "bg_list", "bg_logs", "bg_kill"]
  }
}
```

`bg_wait` / `bg_list` / `bg_logs` / `bg_kill` は入れなくても分類器が通す可能性が高いが、
入れておくと毎回の分類器呼び出し (レイテンシとトークン) を省ける。
`bg_kill` が安全なのは、シグナルを送れる相手が **この extension が起動したジョブに限られる**ため
(ジョブ台帳に無い pid は指定できない)。

共有される `.pi/automode.json` には書けない (automode が `permissions.allow` を拒否する)。

### 2. pi-longrun 側 — 免除の範囲を絞る

`permissions.allow` に `bg_start` を入れるということは、**任意のシェルコマンドが automode の
bash レビューを迂回できる**ということでもある。`bg_start(command)` は結局シェルを実行するので、
名前だけの許可は「bash を無条件許可する」のとほぼ等しい。

そこで `.pi/longrun.json` の `commandAllowlist` で、bg_start 自身が受け付けるコマンドを絞る:

```json
{
  "commandAllowlist": [
    "^npm run (build|test)\\b",
    "^python train\\.py\\b",
    "^\\./scripts/"
  ]
}
```

これで automode への免除は「この正規表現に合うコマンド」に限定される。
判定は extension 側 (免除を受けている当人) で行うので、automode の設定を緩めずに済む。

`commandAllowlist` が空のまま automode を検出した場合、セッション開始時に一度だけ警告を出す
(`"automodeHint": false` で抑止できる)。

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
  "autoBackgroundPatterns": ["^python train\\.py"], // bash で走らせず bg_start に誘導
  "commandAllowlist": [],         // 空 = 制限なし。pi-automode 併用時は設定推奨 (上記参照)
  "automodeHint": true            // automode 検出時の警告
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
`--no-session` の場合だけは永続化先が無いので、pi の再起動で登録済みの起床条件が失われる。

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

`pi -p` はパイプされた stdin の EOF を待つので、スクリプトから呼ぶときは `< /dev/null` を付ける
(付けないと extension の有無に関係なく終了しない)。`bench/run.mjs` は RPC mode で stdin を自前で
管理しているのでこの影響を受けない。

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
