# 差の原因を比較!

**User:** Anonymous  
**Created:** 9/5/2026 14:47:31  
**Updated:** 9/5/2026 14:51:40  
**Exported:** 9/5/2026 19:10:06  
**Link:** [https://chatgpt.com/c/6a9bac3f-8f1c-83e8-a588-ea3ee84503d9](https://chatgpt.com/c/6a9bac3f-8f1c-83e8-a588-ea3ee84503d9)  

## Prompt:
2026/9/5 14:47:30

claude codeとcodexで、LLMのトレーニング実験(数時間〜数日オーダー)をそれぞれ回してもらっているのですがこの2つにかなりの挙動の差がみられます。claude codeでは1時間とか場合によっては数時間の長時間スリープに入ってtokenの使用量を抑えるような挙動をしているのですが、codexは数分おきにログを確認するなどかなりのtoken使用量になってしまうようです。この差はどこから来るかを調べてもらえますか? モデルの差というよりはツールのsystem promptの差かなあと思っているのですが

## Response:
2026/9/5 14:47:31

かなりあり得る仮説です。モデル差だけでなく、**エージェント実行ループ側のポーリング方針・system prompt・ツールAPIの設計**を切り分けて調べます。Claude Code / Codex の公開ドキュメントや既知の実装挙動を確認しつつ、「長時間ジョブを待つとき誰が sleep 間隔を決めているのか」に焦点を当てます。

いまの時点で、かなり「モデルの性格」ではなく**ハーネス差**を示す材料が出ています。特に Codex 側は、長時間プロセスの完了通知が push されず、モデルが `wait` / `write_stdin` で取りに行く設計がトークン浪費の直接原因になっている、という非常に具体的な報告があります。

一方 Claude Code 側には、background task の**完了通知**や `ScheduleWakeup` のような「モデルをあとで起こす」仕組みが実際に存在しており、数分〜数時間空ける挙動をハーネス側が可能にしています。

> **ウェブを検索中**
>
> [Code-mode `exec` silently degrades a long-running command into a full-context model polling loop (34.6M tokens burned after the task already completed) · Issue #38495 · openai/codex · GitHub](https://github.com/openai/codex/issues/38495)
> [Unrolling the Codex agent loop | OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/)
> [WHITE PAPER](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf)
>
> **3件のウェブサイトを検索しました**
>
> 
>
> **ウェブを検索中**
>
> [codex/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs at main · openai/codex · GitHub](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs)
>
> **整理待機方式**
>
> 長時間の待機では、直接停止するより、処理をバックグラウンド化して完了通知を受ける設計が有効そうです。短い確認間隔の反復は非効率で、環境の待機上限や通知機能に合わせた運用が必要だと考えています。
>
> **1件のウェブサイトを検索しました**
>
> 
>
> 27s考えました

はい。調べた限り、観察されている差は **「Claude と GPT のモデル性格の差」より、かなり強くエージェント・ハーネス／tool definition／developer-system prompt の差から来ている**と考えてよさそうです。

しかも Codex 側については、ほぼそのものズバリの issue とソースコード上の根拠が見つかりました。

### 結論

ざっくり構造を書くと、

```text
Claude Code
 training start
      │
      ├─ background task
      │
      ├─ 「完了したら通知して」
      │          ↓
      │      runtime が待つ
      │          ↓
      └──── completion notification ──→ Claude 再起動

       この間 LLM inference ≈ 0
```

に対して、Codex は現状かなりのケースで

```text
Codex
 training start
      │
      ├─ exec_command
      │    ↓ 10～30 sec
      ├─ still running
      │
LLM ──┤
      ├─ write_stdin / wait
      │    ↓
LLM ──┤
      ├─ write_stdin / wait
      │
     ...
```

になっています。

つまり、ユーザーさんが見ている

> Claude Code は1時間〜数時間寝る  
> Codex は数分ごとにログを見る

という差は、かなり実装上必然的です。

---

## 1. Codexには「長時間待つ」という問題が実際にある

OpenAI の Codex リポジトリで、非常に直接的な報告があります。

2026年8月の issue #38495 では、長時間 command が `exec_command` の yield 時間を超えると、

1. process は background に残る
2. Codex に session/cell ID が返る
3. **process 完了時に Codex を wake up する push notification がない**
4. Codex自身が `wait()` を呼ばないと終了したか分からない

という構造が解析されています。([GitHub](https://github.com/openai/codex/issues/38495?utm_source=chatgpt.com))

しかも `wait()` 一回ごとに **LLM の新しい inference turn** が発生します。

その報告では、わずか9.5分の filesystem operationを待つだけで、

- 90 model turns
- input 21.6M tokens
- output 約3.8k tokens

になっています。つまり、

> 「まだ終わってない？」

という確認のためだけに毎回巨大な context を読み直す。

これはまさにユーザーさんが観測している現象です。([GitHub](https://github.com/openai/codex/issues/38495?utm_source=chatgpt.com))

---

## 2. Codexのtool API自体が短い待ち時間を前提にしている

ここはソースコードまで公開されています。

現在の Codex の unified exec では、

```rust
fn default_exec_yield_time_ms() -> u64 {
    10_000
}
```

つまり初期の `exec_command` はデフォルト **10秒**。([GitHub](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec.rs?utm_source=chatgpt.com))

さらに yield は、

```rust
MAX_YIELD_TIME_MS = 30_000
```

つまり原則30秒に clamp されます。([GitHub](https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/mod.rs?utm_source=chatgpt.com))

なので例えば、

```bash
python train.py
```

を実行して1日かかるとしても、

```text
0 sec    train.py開始
10 sec   exec_command returns "still running"
          ↓
       LLMに制御が戻る
```

という構造になってしまいます。

そのあと Codex が持っている基本的な手段が `write_stdin` です。

現在の config にも、

> Maximum poll window for background terminal output (`write_stdin`)  
> Default: 300000 (5 minutes)

と明示されています。([GitHub](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json?utm_source=chatgpt.com))

したがってユーザーさんの

> 数分おきにログを確認する

という挙動は、**5分という値を考えても非常に納得できます**。

---

# 3. さらに重要：Codexの developer prompt にも「長く待つな」がある

ここがユーザーさんの予想に一番近いところです。

Codex repo の issue #31935 に、GPT-5.6向け developer prompt の文言として、

> Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.

が報告されています。

つまり要旨として、

> **60秒を超える blocking sleep / wait は避けろ**

と Codex に指示されているわけです。([GitHub](https://github.com/openai/codex/issues/31935?utm_source=chatgpt.com))

issue を立てた人自身も、

> これのせいで数十分〜数時間のビルドを pointless polling loop で待つことになる

と指摘しています。

なので、

> system promptの差かなあ

は **かなり正しいです**。

ただし正確には、

**system/developer prompt だけではなく、tool APIそのものもその方針に合わせて設計されている**

というのが重要です。

---

# 4. 一方Claude Codeには「寝る」ためのruntime primitiveがある

Claude Code側が面白いです。

Claude Codeには background Bash / Agent の **completion notification** があります。

Claude Codeの tool description 自体に、background agentについて、

> Don't peek.  
> do not Read or tail it.  
> You get a completion notification; trust it.

という趣旨の指示が存在することが、Claude Code issue 上で確認できます。([GitHub](https://github.com/anthropics/claude-code/issues/55153?utm_source=chatgpt.com))

つまり思想として、

```text
agent
  │
  ├─ start job
  │
  └─ return/yield
       │
       │   ← LLMは動いていない
       │
 runtime waits
       │
 completion
       ↓
 task-notification
       ↓
 Claude inference
```

です。

Codex の、

```text
LLM → poll → LLM → poll → LLM → poll
```

とは根本的に違います。

---

## 5. Claudeにはさらに `ScheduleWakeup` がある

そしてユーザーさんが見ている

> 1時間、場合によっては数時間 sleep

の正体としてかなり可能性が高いのがこれです。

Claude Code には **`ScheduleWakeup`** という runtime primitive が存在します。

実際、

```text
ScheduleWakeup(... delaySeconds: 240)
```

のように、

> 240秒後に自分を再開する

という使い方が報告されています。([GitHub](https://github.com/anthropics/claude-code/issues/51304?utm_source=chatgpt.com))

これは重要で、

```text
Claude:
「1時間待とう」
↓
ScheduleWakeup(+3600 sec)
↓
agent turn終了
↓
──────── 1 hour ────────
       LLM token = 0
↓
runtime event
↓
new Claude turn
```

とできます。

なので画面上では「Claudeが1時間sleepしている」ように見えても、実際には **LLMが sleep syscall を保持しているわけではなく、runtime に control を返している**可能性が高いです。

これは理想的な構造です。

---

# 6. 面白いことにClaudeはむしろ普通の `sleep` を禁止している

さらに裏付けになるのがこれです。

Claude Code は Bash で、

```bash
sleep 30 && ...
```

のような長い sleep をむしろブロックすることがあります。

返される説明が、

> Run blocking commands in the background with `run_in_background: true` - you'll get a completion notification when done.

というものです。([GitHub](https://github.com/anthropics/claude-code/issues/48280?utm_source=chatgpt.com))

つまりClaude Codeの設計思想はかなり明確で、

```text
× LLM turn内で sleep 3600

○ background process
      +
   runtime notification

または

○ ScheduleWakeup(3600)
```

となっています。

これは長時間ML experimentとの相性が非常に良いです。

---

# 7. なので「モデルの差」は二次的

重要度を私ならこんな感じに見積もります。

| 要因 | Claude Code vs Codexの差への寄与 |
|---|---:|
| **runtime / agent harness** | ★★★★★ |
| **tool API / tool description** | ★★★★★ |
| **developer/system prompt** | ★★★★☆ |
| modelそのもの | ★★☆☆☆ |

特に、

### Claude Code

```text
Bash(run_in_background=True)
        │
        └─ completion notification

ScheduleWakeup(delaySeconds=N)
```

がある。

tool promptでも

```text
Don't peek.
Trust completion notification.
```

と教えている。([GitHub](https://github.com/anthropics/claude-code/issues/55153?utm_source=chatgpt.com))

### Codex

```text
exec_command
   │
   └─ after ~10-30 sec → process ID

write_stdin(session_id)
write_stdin(session_id)
write_stdin(session_id)
...
```

しかなく、background processは **calling agentをcompletion時にwakeしない**という報告があります。([GitHub](https://github.com/openai/codex/issues/15723?timeline_page=1&utm_source=chatgpt.com))

さらにdeveloper promptが

```text
Avoid blocking wait > 60 seconds
```

と指示。([GitHub](https://github.com/openai/codex/issues/31935?utm_source=chatgpt.com))

これなら現在の挙動差はかなり説明できます。

---

# 8. しかもOpenAI側でも問題として認識されている

Codex repoにはまさに、

> **Background subprocesses/subagents do not wake the calling agent on completion**

という issue があります。([GitHub](https://github.com/openai/codex/issues/15723?timeline_page=1&utm_source=chatgpt.com))

また最近の issue では、

> polling background process のたびに full context model turn が走る

問題が具体的な token 数付きで報告されています。([GitHub](https://github.com/openai/codex/issues/38495?utm_source=chatgpt.com))

さらに提案されている改善策も、

> runtime should enqueue a completion notification for the parent thread even if it never polls `write_stdin`

です。([GitHub](https://github.com/openai/codex/issues/12921?utm_source=chatgpt.com))

つまり **Claude Code型に寄せようという提案そのもの**がCodex側に出ています。

---

## 9. Claude Codeも完璧ではない

ここは公平に言うと、Claude Codeでも polling loop に陥る報告はあります。

例えば Opus が background job の output file を何度も `Read` / `tail` して context を消費する問題があります。([GitHub](https://github.com/anthropics/claude-code/issues/16958?utm_source=chatgpt.com))

さらに、

> 「pollするな」とユーザーが明示しても15回以上pollした

という issue まであります。([GitHub](https://github.com/anthropics/claude-code/issues/44957?utm_source=chatgpt.com))

最近には30秒ごとの subagent polling で、

> 1 poll ≈ 146k-160k tokens

という報告もあります。([GitHub](https://github.com/anthropics/claude-code/issues/90443?utm_source=chatgpt.com))

なので **Claudeモデル自身が特別に「辛抱強い」わけではない**です。

ここも逆に「model差ではない」という証拠に近いと思います。

---

# 10. ML trainingではClaude Codeの設計がかなり有利

ユーザーさんの用途、

```text
launch training
 ↓
1～3 hours
 ↓
validation確認
 ↓
parameter変更
 ↓
launch next experiment
 ↓
6 hours
 ↓
...
```

では理想的なエージェントは、

```text
start experiment

schedule:
  wake at ETA - ε

OR

subscribe:
  process completion

────────────
zero inference
────────────

wake

tail -100 log
parse metrics
decide next experiment
```

です。

Claude Codeにはこのための primitive がかなり揃っています。

対してCodexの現状は、

```text
start
 ↓
wait 30s
 ↓
LLM
 ↓
wait
 ↓
LLM
 ↓
wait
 ↓
LLM
```

になりやすい。

これはML trainingのような**wall-clock time ≫ agent reasoning time**な用途では特に差が極端に出ます。

---

## ひとつ非常に興味深い点

OpenAI自身も2026年の Codex long-running work の資料で **Thread automations** を、

> heartbeat-style recurring wake-up calls attached to the current thread

として紹介しています。([OpenAI](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf?utm_source=chatgpt.com))

つまりOpenAI側も、

```text
continuous polling agent
```

ではなく、

```text
sleep/yield → scheduled wakeup
```

が長時間タスクには必要だと認識しているようです。

ただ、**通常の `exec_command → write_stdin` agent loop にまだうまく統合されていない**、という状態に見えます。

---

### まとめると

ユーザーさんの仮説を少し修正すると、

> **「ClaudeとCodexのモデル差ではなくsystem prompt差」**

というより、

> **Claude Code と Codex の「agent runtime + tool semantics + developer prompt」の設計思想の差**

です。

そして特に決定的なのは

**Claude Code: push / scheduled wakeup型**  
**Codex: pull / polling型**

という違いです。

これは数時間〜数日のML実験を任せると、**token消費に桁違いの差が出ても全く不思議ではありません**。

個人的には、今回見つかった Codex の `Avoid performing blocking sleep or wait calls longer than 60 seconds` という developer prompt と、Claude Code の `Don't peek ... You get a completion notification; trust it` の対比が、ユーザーさんの観測をかなりきれいに説明していると思います。([GitHub](https://github.com/openai/codex/issues/31935?utm_source=chatgpt.com))

もしよければ次に、**Codex側でClaude Codeに近い「数時間寝て、training完了/指定時刻だけwakeする」挙動を AGENTS.md や wrapper script で強制できないか**を、Codexの現行tool仕様を踏まえて具体的に設計してみるとかなり面白いです。

---

**Sources:**

- [Code-mode `exec` silently degrades a long-running command into a full-context model polling loop (34.6M tokens burned after the task already completed) · Issue #38495 · openai/codex · GitHub](https://github.com/openai/codex/issues/38495?utm_source=chatgpt.com)
- [WHITE PAPER](https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf?utm_source=chatgpt.com)



---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)