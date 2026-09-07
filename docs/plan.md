# pi-longrun: 長時間ジョブ用 pi extension 実装プラン

`docs/idea.md` で指摘された「Codex 型 pull/polling」と「Claude Code 型 push/scheduled-wakeup」の差を、
pi (0.74.2) の extension として埋める。

## 状況 (2026-09-07)

Phase 0-5 まで実装・実機検証済み。使い方は [README.md](../README.md)、実測は [benchmark.md](benchmark.md)。
以下は着手時に立てたプランで、記録として残している。

## 決定事項

- **スコープ: 汎用の長時間ジョブ基盤**。ML 学習に限らず、ビルド・テスト・デプロイ待ちにも効く形にする。
  ML 固有のメトリクス抽出は Phase 4 で「設定ファイル駆動の薄い層」として載せる（コアには入れない）。
- **運用前提: tmux 常駐の interactive TUI**。RPC daemon（旧 Phase 5 後半）は**作らない**。
  完成は Phase 4 まで、Phase 5 は配布のみ。

---

## 0. 調査結果（実装の前提となる確定事項）

pi 本体 `@earendil-works/pi-coding-agent@0.74.2` のソース/docs を直接確認した結果:

| 項目 | 事実 | 出典 |
|---|---|---|
| built-in `bash` に background 実行は**無い** | `bashSchema = { command, timeout? }` のみ。`timeout` は「optional, **no default timeout**」 | `dist/core/tools/bash.d.ts`, `dist/core/tools/bash.js:16` |
| pi は意図的に background bash / subagent / MCP を持たない | 「core を小さく保ち、extension に出す」という設計方針 | pi README / docs |
| 外部から turn を起こせる | `pi.sendMessage({customType, content, display}, { triggerTurn: true })` | `docs/extensions.md:1268`, `examples/extensions/file-trigger.ts` |
| 配送タイミングを選べる | `deliverAs: "steer" \| "followUp" \| "nextTurn"` | `docs/extensions.md:1268-1290` |
| tool 呼び出しをブロック/書き換えできる | `pi.on("tool_call")` は `{block:true, reason}` を返せる。`event.input` は**mutable**（再バリデーション無し） | `docs/extensions.md:672-720` |
| system prompt を毎ターン差し込める | `before_agent_start` が `{ systemPrompt }` を返すとチェーンされる。tool 側は `promptSnippet` / `promptGuidelines` | `docs/extensions.md:464-500`, `1217-1240` |
| 状態の永続化 | `pi.appendEntry()`（LLM context に入らない）+ `session_start` で `sessionManager.getBranch()` から復元 | `docs/extensions.md:1319`, `1626-1660` |
| background resource の作法 | factory では起動せず `session_start` で起動、`session_shutdown` で冪等に片付ける | pi docs（明文化されたルール） |
| モード別の生存 | Interactive: idle でもプロセス常駐。**`-p` print mode はプロンプト処理後に終了** | `docs/extensions.md:2506` |

**結論: pi の extension API には、Claude Code の `Bash(run_in_background)` + 完了通知 + `ScheduleWakeup` を
再現するのに必要な primitive が全部揃っている。** 足りないのは実装だけ。

---

## 1. 何を作るか

拡張名: **`pi-longrun`**（仮）。3 レイヤ構成。

### レイヤ A: background job（Claude Code の `run_in_background` 相当）

```
bg_start(command, cwd?, name?, env?)  -> { jobId, pid, logPath }
```

- `child_process.spawn(..., { detached: true, stdio: ['ignore', fd, fd] })` + `unref()`。
  **pi が落ちてもジョブは生き残る**（ここは Claude Code より強い保証）。
- stdout/stderr は `~/.pi/agent/longrun/<jobId>.log` に直接 fd で書く（Node を経由しない = ログ量が context に一切乗らない）。
- ジョブ台帳を `~/.pi/agent/longrun/jobs.json` に永続化（pid / cmd / 開始時刻 / 状態 / セッション ID）。

補助 tool（**意図的に「使いにくく」書く**、後述）:
```
bg_list()                            -> 走っているジョブ一覧
bg_logs(jobId, tail?, grep?)         -> ログ末尾/フィルタ
bg_kill(jobId, signal?)
```

### レイヤ B: wakeup（Claude Code の完了通知 + `ScheduleWakeup` 相当）★ 本命

```
bg_wait({
  jobId?,            // そのジョブが終了したら起こす
  afterSeconds?,     // N 秒後に起こす（ScheduleWakeup 相当）
  atTime?,           // 絶対時刻に起こす
  logPattern?,       // ログに正規表現がマッチしたら起こす（jobId 必須）
  filePath?,         // ファイルが出現/更新されたら起こす（checkpoint 用）
  maxWaitSeconds?,   // 保険のタイムアウト
  note               // 起床時に自分に返してほしいメモ（必須にする）
}) -> "登録した。ターンを終了せよ。起こす。"
```

- **tool は即座に return する**。LLM はそのままターンを終える → **待機中の inference = 0**。
- 条件成立時に extension 側が:
  ```ts
  pi.sendMessage(
    { customType: "longrun-wake", content: <構造化サマリ>, display: true },
    { triggerTurn: true, deliverAs: "followUp" }
  )
  ```
- 通知本文に**次の判断に必要な情報を全部載せる**（追加 tool 呼び出しを誘発しないため）:
  - イベント種別 / 経過時間 / exit code
  - ログ末尾 N 行
  - 抽出済みメトリクス（`loss=…, step=…`。後述の抽出ルール）
  - `note`（LLM が待機前に書いた自分向けメモ）
- **合体（coalescing）**: 数秒のウィンドウで複数イベントを 1 通知にまとめる → 起床ターン数を最小化。
- 監視は `logPattern` を軸にすると「30 分ごとに見る」ではなく「eval が出たら見る」になり、起床回数が激減する。

### レイヤ C: 反ポーリングのガードレール（idea.md §6 の Claude Code 挙動の再現）

1. **`tool_call` フックで blocking sleep を止める**
   `bash` の command が `sleep <閾値超>` / `while …; do … sleep …; done` / `tail -f` / `wait` にマッチしたら
   ```ts
   return { block: true, reason: "長時間の待機は bg_wait を使え。完了時に通知される。" }
   ```
   ← Claude Code が実際に返しているメッセージと同じ思想。
2. **system prompt 注入**（`before_agent_start`）
   - 「ログを覗くな。通知を信じろ」（Claude Code の *Don't peek. Trust the completion notification.*）
   - 現在走っているジョブと予約中の wakeup を**動的に列挙**して毎ターン提示 → モデルが状況を再確認するための tool 呼び出しを潰す。
3. **`promptGuidelines`**（tool 有効時のみ Guidelines に入る）
   - "Use bg_start for any command expected to run longer than ~60s."
   - "Use bg_wait instead of polling bg_logs. bg_logs is only for after a wake notification."
4. **バックオフ**: 短い `afterSeconds` を繰り返し要求してきたら、extension 側で最小間隔を強制し「なぜ延ばしたか」を通知に書く。
   （モデルの我慢のなさをハーネス側で矯正する = idea.md §9 の「Claude も完璧ではない」への対策）

### 付随: UI / 運用

- footer status: `▶ 2 jobs · next wake 47m` (`ctx.ui.setStatus`)
- `/jobs` コマンド: 一覧・kill・ログを人間が見る（LLM の context を消費せずに）
- `registerMessageRenderer("longrun-wake", …)` で起床通知を見やすく
- 起床ターン数と推定トークンをジョブごとに集計して `/jobs` に表示 ← **効果測定そのものが機能になる**

---

## 2. 明示しておく制約（設計上のトレードオフ）

1. **pi が生きていないと起こせない。**
   `sendMessage(triggerTurn)` は常駐プロセス前提。想定運用は interactive TUI（tmux 常駐）。
   `-p` は 1 プロンプトで終了するので wakeup は成立しない。
   → 緩和策: ジョブは detached なので pi が死んでも走り続け、次回 `session_start` で
   「留守中に終わったジョブ」を検出して即通知（**リプレイ**）する。
   運用は tmux 上で pi を常駐させる前提とする（RPC daemon は今回作らない）。
2. **起床 1 回 = フルコンテキスト 1 ターン**は避けられない。
   だから「起床回数を減らす」「1 回の通知を自己完結させる」が設計の中心になる。
   長時間ギャップは prompt cache が切れるので、なおさら起床回数が効く。
3. **`tool_call` ブロックは諸刃**。`sleep 2` のような正当な短待機まで殺さないよう閾値（既定 60s）と
   設定での無効化を用意する。
4. `event.input` の書き換えは再バリデーションされない → 自動 background 化（Phase 4）は opt-in にする。

---

## 3. 実装フェーズ

| Phase | 内容 | 成果 |
|---|---|---|
| **0** | リポジトリ整備。`package.json`（`pi.extensions`）、TS 設定、`pi -e ./src/index.ts` の開発ループ、vitest | 動く空 extension |
| **1** | `bg_start` / `bg_list` / `bg_logs` / `bg_kill` + ジョブ台帳 + footer status | 長時間ジョブをブロックせず投げられる |
| **2** ★ | `bg_wait`（exit / timer / logPattern / file）+ 通知配送 + coalescing + 起動時リプレイ | **待機中トークン ≈ 0 を達成** |
| **3** | 反ポーリング: sleep ブロック、system prompt 注入、promptGuidelines、バックオフ | 挙動が Claude Code 型に矯正される |
| **4** | ML 向け: メトリクス抽出ルール（`.pi/longrun.json` の regex → key/value）、ETA 起床、クラッシュ即通知（`deliverAs:"steer"`）、opt-in の自動 background 化 | 実験ベビーシッターとして実用 |
| **5** | 配布: `pi install git:github.com/...` 対応、README、tmux 常駐の運用手順 | 共有可能 |

Phase 2 まで到達した時点で idea.md の主題（トークン消費の桁違いの差）は解消する。3 以降は再発防止と快適さ。
Phase 4 の ML 向け機能は `.pi/longrun.json` の設定で有効化する opt-in とし、コアの汎用性を汚さない。

---

## 4. 効果測定（作る前に決めておく）

擬似トレーニングスクリプト（例: 30 分かけて 30 秒ごとに `step=… loss=…` を吐く）を用意し、同一プロンプトで比較:

| 条件 | 測るもの |
|---|---|
| A: 素の pi（extension なし） | 総 input トークン / モデルターン数 / wall-clock |
| B: pi-longrun あり | 同上 |

`pi --mode json` のイベントストリームから usage を集計すればスクリプト化できる。
「9.5 分待つのに 90 ターン / 21.6M input トークン」（Codex issue #38495）に対して、
B が **2〜3 ターン**で終わることを合格ラインにする。

---

## 5. リポジトリ構成（案）

```
pi-extension/
├── package.json          # { "pi": { "extensions": ["./src/index.ts"] } }
├── src/
│   ├── index.ts          # ExtensionAPI factory: tool/command/hook 登録のみ
│   ├── jobs.ts           # spawn / 台帳 / 永続化 / 復元
│   ├── watchers.ts       # exit / timer / log regex / file の監視と合体
│   ├── notify.ts         # sendMessage の組み立て（本文フォーマット）
│   ├── guards.ts         # tool_call sleep ブロック + system prompt 注入
│   ├── metrics.ts        # ログからのメトリクス抽出
│   └── ui.ts             # status / /jobs / renderer
├── test/                 # vitest
├── bench/                # 効果測定スクリプト
└── docs/
    ├── idea.md
    └── plan.md
```

---

## 6. 最初の一歩

Phase 0+1 を一気に作り、`pi -e ./src/index.ts` で
`bg_start("bash -c 'for i in $(seq 100); do echo step=$i; sleep 10; done'")` が
即 return してログが溜まることを確認する。ここが通れば Phase 2 は素直に載る。
