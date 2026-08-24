# DSH-GPTLoop

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

**DeepSeek Harness のための外側ループ。**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）を、プロジェクト推論・独立レビュー・人間による権限判断を担う持続的な GPT Web の外側ループへ接続します。

**速い内側ループ。持続する外側ループ。ひとつのプロジェクト。**

DSH は、ローカル実行、ツール、テスト、サンドボックス、セッション、サブエージェント、権限、承認、再開といった得意領域をそのまま担います。DSH-GPTLoop が追加するのは、より広いプロジェクト会話が蓄積されている GPT Web への不足しているブリッジだけです。

> **第二の Agent フレームワークは作りません。サンドボックスも重複させません。セッションシステムも重複させません。不足している外側ループだけを補います。**

## 内側ループ + 外側ループ

```text
                 GPT Web
            持続する外側ループ
    プロジェクト文脈 / 推論 / レビュー
                 ↑
                 │
            DSH-GPTLoop
       GovernLoop bridge + DSH adapter
                 │
                 ↓
        DeepSeek Harness
            高速な実行ループ
   plan / act / tools / test / resume
```

製品境界はシンプルです。

- **DSH = 高速なローカル実行 / 内側ループ**
- **GPT Web = 持続的なプロジェクト推論 + 独立レビュー / 外側ループ**
- **DSH-GPTLoop = 両者をつなぐブリッジ**

設計原則は **native first** です。DSH が既に提供している機能は、そのまま利用し、再実装しません。

## なぜ GPT Web が重要なのか

重要なのは、単なる「もう一度モデルを呼ぶこと」ではありません。人がすでにプロジェクトについて考えている **既存の GPT Web 会話**です。そこには、アーキテクチャ、調査、トレードオフ、レビュー履歴、プロダクト判断、ブロッカー解消、そして長い会話の中で蓄積された文脈があります。

ローカル Coding Agent はマシンを操作することに強く、GPT Web はより上位のプロジェクト会話を保持する場所になりやすい。DSH-GPTLoop はこの2つの作業面をつなぎ、人間がクリップボード役になる必要を減らします。

特に次の利用者に有効です。

- **Solo builder / OPC（一人会社）：** 1人が Product Owner、アーキテクト、研究者、レビュアー、オペレーターを同時に担うことがあります。持続的な外側ループはコンテキスト切り替えを減らし、ローカル実行 Agent が GPT Web に蓄積されたプロジェクト文脈を参照できるようにします。
- **Vibe Coding ワークフロー：** 実装速度が非常に速くなるほど、重要な checkpoint における独立レビューの価値は高まります。重要判断、破壊的操作、ブロッカー、予期しない状態だけを GPT Web に送ることで、すべてのローカルステップを追加のモデル会話に変える必要がありません。
- **プロフェッショナルなエンジニアリングチーム：** 実行とレビューを同じ Agent コンテキストに閉じ込める必要はありません。ローカル runtime はコード、テスト、サンドボックス、権限を引き続き担当し、GPT Web は独立した推論/レビュー面として機能できます。機密コードや証拠を扱う場合は、組織のセキュリティおよびデータ取扱ポリシーに従う必要があります。

目的は GPT Web を実行エンジンにすることではありません。**実行はローカルに残しながら、プロジェクト推論と独立レビューを接続し続けること**が目的です。

## GPT Web をプロジェクトの外側ループとして使う

GPT Web は review surface だけに限りません。**関連ツールが接続され、利用権限がある場合**、開発ライフサイクル全体にまたがって各システムの文脈を1つの持続的な reasoning workspace に集約できます。

```text
                      GPT Web
              persistent project outer loop

        research / product / architecture / review
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
       Linear          GitHub       Docs / Drive
   issues / planning   PR / CI      specs / evidence
          │              │              │
          └──────────────┼──────────────┘
                         ↓
                    DSH-GPTLoop
                         ↓
                  DeepSeek Harness
                   local execution
                         ↓
               code / tools / tests
```

実際のソフトウェア開発は「コード生成」だけではありません。

**Idea / Research → Product Decision → Issue → Implementation → Test → Review → PR → CI → Merge → Release → Documentation → Follow-up**

DSH が最も強いのは、この中の高速なローカル実行です。一方 GPT Web は、関連ツールが利用可能なとき、周辺のプロジェクト文脈を接続できます。たとえば、調査とプロダクト推論、Linear の issue / blocker、GitHub repository / PR / CI evidence、ドキュメント、release-readiness review、follow-up work です。

ただし、これは権限を GPT Web に移すことを意味しません。

- GitHub は repository content、commit、PR、repository lifecycle state の authority のままです。
- Linear を利用する場合、issue / project tracking の authority は Linear のままです。
- CI は verification evidence であり、green check 自体が Merge / Release authorization になるわけではありません。
- DSH は native runtime、execution、sandbox、permission、session、approval behavior の authority のままです。
- 必要な consequential lifecycle authority は人間が保持します。

GPT Web はそれらを置き換えません。**それらの文脈をつなぎます。**

> **ローカル Agent は「今なにをしているか」を知る。外側ループは「なぜこのプロジェクトがそれをしているのか」を知る。**

Coding Agent が速くなるほど、この分離の価値は高まります。

> **内側ループが速くなるほど、外側ループは重要になる。**

詳細：[`docs/product/DSH-GPTLoop-outer-loop.md`](docs/product/DSH-GPTLoop-outer-loop.md)。

## どのギャップを埋めるのか

DeepSeek Harness はすでに実行フレームワークを提供しています。一方で、実行中の DSH Agent を、人間がプロジェクト文脈を維持している既存の GPT Web 会話に、信頼性高くつなぐ機能はネイティブにはありません。

DSH-GPTLoop が補うのはこの部分だけです。

```text
DSH critical checkpoint
        ↓
thin native governloop-dsh adapter
        ↓
GovernLoop Core
session / evidence / Neutral Relay
        ↓
existing GPT Web conversation
        ↓
independent review + read-back
        ↓
human authority when required
        ↓
DSH resumes
```

## なぜ価値があるのか

### 1. DSH と競合せず、DSH を補完する

DSH-GPTLoop は別の orchestration layer にはなりません。実行、サンドボックス、権限、セッション、サブエージェント、ネイティブ承認は引き続き DSH が権威を持ちます。adapter は DSH の lifecycle event を外部レビュー bridge に変換し、証拠とレビュー結果を戻すだけです。

### 2. 実際のループで検証済み

**Product Closure: VERIFIED（2026-08-24）。**

実際の DSH + 実際の GovernLoop Neutral Relay + Chrome/CDP + バインド済み GPT Web 会話による完全な end-to-end パスを検証済みです。

検証項目：

- 実際のメッセージ配信と evidence attachment；
- GPT の完全な応答 read-back；
- 明示的な人間承認後の exact retry authorization；
- relay failure、PO decline、missing attachment が fail closed；
- GPT Web タブがバックグラウンドでも動作；
- automatic resend なし；
- production-default E2E 中に実際に発生した truncation-shaped response を自動検出し回復。

検証記録：[`docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md`](docs/verification/GovernLoop-DSH-Product-Closure-E2E-2026-08-24.md)。

### 3. 人間の clipboard relay をなくす

外側ループ bridge がない場合：

```text
DSH stops → human copies context → opens GPT Web → explains the issue
→ copies the answer back → tells DSH what happened → agent continues
```

DSH-GPTLoop を使う場合：

```text
DSH → checkpoint → GPT Web → review read-back → DSH resumes
```

重要な checkpoint だけを送信します。通常の進行はローカルに残り、evidence は自動添付され、応答は同じ DSH workflow に戻ります。繰り返しの copy/paste は不要です。

### 4. 追加 DSH model-token overhead はほぼゼロ

DSH-GPTLoop は DSH の内部 reasoning loop に別の LLM を挿入しません。classification、gating、evidence handling、transport、retry control は deterministic/local operation です。外部レビューは既に使っている GPT Web 会話で行われます。

そのため bridge mechanics 自体による **追加 DSH model-token overhead はほぼゼロ**です。これは外部 GPT review が token-free という意味ではなく、bridge を動かすためだけに追加の DSH model reasoning loop を必要としない、という意味です。

## DSH 単体 vs. DSH + DSH-GPTLoop

| Capability | DSH 単体 | DSH + DSH-GPTLoop |
|---|---|---|
| Agent execution | ✅ Native | ✅ Native |
| Sessions / subagents | ✅ Native | ✅ Native |
| Sandbox / permissions | ✅ Native | ✅ Native |
| Native approval | ✅ Native | ✅ Native |
| Existing GPT Web project context | Manual handoff | ✅ Connected |
| Persistent outer-loop project reasoning | Manual | ✅ Connected |
| Cross-tool project context (when connected) | Fragmented/manual | ✅ Available to outer loop |
| Independent external review | Manual | ✅ Automatic checkpoint |
| Evidence delivery | Manual copy/paste | ✅ Automatic attachments |
| Review read-back | Manual copy/paste | ✅ Automatic |
| Extra DSH model loop for bridge mechanics | — | **Near-zero** |
| Relay / malformed-response failure | Human-dependent | **Fail closed** |

## Quick start

技術 package は引き続き [`governloop-dsh/`](governloop-dsh/) にあります。完全なインストール、設定、テスト手順はその README にあります。

Prerequisites:

- pinned `@deepseek-ai/dsh@0.1.1-rc.2`；
- Neutral Relay と session manager を含む [GovernLoop Core](https://github.com/liangzhipengdamon-maker/GovernLoop)；
- Chrome を CDP（`--remote-debugging-port=9233`）で起動；
- GovernLoop session にバインドされた GPT Web 会話。

Install / mount:

```text
dsh plugin --profile <name> add governloop-dsh
```

または `governloop-dsh/cordis.patch.yml` を使ってローカル mount し、`GOVERLOOP_SESSION_MANAGER_PATH` を `governloop_session.py` に向けます。

完全な package guide：[`governloop-dsh/README.md`](governloop-dsh/README.md)。

## Safety boundary

- GPT review は advisory evidence であり、execution authority ではありません。
- 現在の DSH integration が人間承認を要求する箇所では、明示的な人間承認が必要です。
- failure は blocked のままです。automatic resend は行いません。
- DSH native sandbox、permission、session、approval behavior が引き続き authoritative です。
- 接続された project tool はそれぞれの authority を保持します。DSH-GPTLoop は GPT Web を universal execution authority や lifecycle authority にしません。
- DSH-GPTLoop は thin のままです。Core transport と evidence safety rule は GovernLoop Core に残ります。

## Compatibility

現在確認済みの組み合わせ：

| Technical package | @deepseek-ai/dsh | Status |
|---|---|---|
| `governloop-dsh` 0.1.0 | 0.1.1-rc.2 | Product Closure VERIFIED |

DSH は developer preview のため、upgrade 前に再検証してください。

## Naming

**DSH-GPTLoop** はこの README で使用する公開 product/display name です。既存 GitHub repository は現時点では `GovernLoop-DSH` のまま、technical package も `governloop-dsh` のままです。この PR では repository/package の rename は行いません。

## Research and verification history

AGE-60（research）、AGE-61（architecture）、AGE-65 validation slices は `docs/` に historical evidence として保存されています。これらは **current runtime authority ではありません**。

## License

[Apache-2.0](LICENSE)。

Repository working rules は [`AGENTS.md`](AGENTS.md) を参照してください。
