# Issue #1688 — 設計

## 変更

`STATIC_CLAUDE_MODELS` に `{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }` を `claude-opus-5` の直前へ足す。`default` は変えない。

`resolveClaudeTurnModel` は静的一覧にある id をローカル注入の探索から外す。新しい id がその一覧に入るので、追加の分岐は要らない。

`modelContextWindow` は、末尾がちょうど `claude-opus-5-5` または `claude-opus-5.5` のときだけ 1,000,000 にする。スラッシュまたはドットの直前までを転送元として許す（`openrouter/anthropic/claude-opus-5-5`、`anthropic.claude-opus-5-5`）。根拠は Anthropic のモデルページ（2026-09-22、id `claude-opus-5-5`、context window 1M tokens、https://platform.claude.com/docs/en/models/opus-5-5/overview ）。`claude-opus-5`、`claude-opus-5-50`、`claude-opus-5-5-local`、`claude-opus-5-5garbage` は汎用の Claude 規則のまま。`host::model` のローカル注入は対象外。カタログ行にも `contextWindow: 1_000_000` を置く。`contextWindowFor` はカタログの宣言をパターン表より先に使う。

同型の洗い出し: ラベルが 1M と書く行は Cursor の `claude-sonnet-5-thinking-high` が 1 件。モデルページが無いので、この PR では 200,000 のままにする。Fable 5.1 と Sonnet 5 もこの PR では従来の 200,000（`[1m]` 付きを除く）のままにする。1M にするかは別件。

Claude の harness compaction は `autoCompactWindow` の既定 200,000 のままです。1M は使用量チップの分母（`server/index.ts` の `modelContextWindow` 呼び出し）と、`contextWindowFor`（`server/context-budget.ts`）がカタログ宣言を読んだときの幅です。`--autocompact` の既定は動きません。

古い Claude Code が `claude-opus-5-5` を知らないと、そのモデルのターンは失敗します。フラグ用の version floor はモデル id には無く、Fable や Opus 5 を足したときと同じです。

## 影響範囲

| 対象 | 箇所 | 種別 | 方針 |
| --- | --- | --- | --- |
| Claude の静的一覧 | `server/drivers/claude.ts` `STATIC_CLAUDE_MODELS` | 機能 | 1 行追加。既定と既存ボットは不変 |
| コンテキスト幅 | `server/model-context-window.ts` | 機能 | Opus 5.5 と、スラッシュまたはドットで区切った転送形だけ 1M |
| 使用量チップ | `server/index.ts` の `modelContextWindow` | 機能 | カタログが窓を返さないときの分母。compaction は変えない |
| 窓の解決 | `server/context-budget.ts` `contextWindowFor` | 機能 | カタログの `contextWindow` をパターン表より先に使う |
| Droid の `MODELS` | `server/drivers/acp/droid.ts` | なし | Factory 側のスナップショットなので触らない |
| カタログ検査 | `claude-catalog.test.ts` | テスト | 位置と既定を固定 |
| 幅の検査 | `model-context-window.test.ts` | テスト | 5.5 は 1M、5 は 200k |

呼び出し側は一覧をそのままピッカーに出す。並びの契約は変えない。

## テスト

隔離した vitest で上記 2 ファイルを実行する。変異は静的一覧から `claude-opus-5-5` を外し、カタログ検査が落ちることを見る。確認後に戻す。
