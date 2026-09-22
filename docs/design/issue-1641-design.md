# Issue #1641 — 設計

## 原因

### Android

`Bot.threadGroups()` は `listedThreads`（ピン、次に `updatedAt ?: createdAt`、同点は保存順）で並べる。注意順は `orderedThreads` に残している。失敗した検査だけが、一覧に古い注意順を期待していた。対象スレッドはすべて `createdAt = 1` で `updatedAt` が無いので、見える行の一覧順は保存順 `current, unread, busy, waiting, queued` である。`quiet` は閉じた idle なので畳む。`run` は routine 実行なので一覧に出ない。

### handoff

製品コードは #1637 で `roomHandoffs` の busy を変えていない。`e8729497` でも、enqueue 直後は `queued`、約 250ms の tick の後は `running` になる。peer の承認スレッドは `waiting-on-you` のまま、別スレッド `@Mailbox Chief` が `working` になる。既定の同時スレッド数は 3 で、承認中の 1 本は枠を使い切らない。

これは #1589（`ec8e79dc`）の契約である。direct の fresh work は bot 全体の busy では待たず、宛先スレッドが空いていて枠があれば開始する。#1278 までは fresh work だけ bot 全体の busy で待っていたが、#1589 がその条件を外した。検査コメントは #1278 以前の文言のまま残った。

#1626 が `expect(status).toBe("queued")` を `expect.poll(...).toBe("queued")` に変えた。状態は最初から `queued` で、tick の後に `queued` ではなくなる。poll は最初の観測が tick より後だと 10 秒 `running` を見続けて失敗する。速い観測は tick 前の `queued` で通る。マージ CI の macOS 成功と Windows 失敗、ローカルで遅延を入れると `e8729497` でも失敗すること、はこのレースで説明できる。`running` になってから承認しても、結果は 1 回だけ別スレッドに届き、開いているスレッドには `MAILBOX_REVIEW` が入らない。

### comms

`TypeError: fetch failed` / `read ECONNRESET`。#1637 の差分に `server/comms.test.ts` は無い。今回も変えない。

## 変更

- Android の core 検査は一覧順と `orderedThreads` の注意順を両方断言する。`threadGroups` の KDoc は「注意が行を動かす」と書かない。
- `TaskRules.tasks` も同じ一覧順で、開いている帯・閉じた帯・アーカイブの帯に分けたあと各帯の中を並べる。core の失敗で app の単体テストまで進んでいなかったので、`TaskRulesTest` の注意順期待も合わせる。KDoc も合わせる。
- handoff 検査は、送信元ターンを終えたあと ledger が `running` になることを 10 秒 poll する。承認ソケットが空であることと、その後の 1 回配送は残す。検査名は「空きスレッドで動き、兄弟の承認は未回答のまま」にする。

## 影響範囲

| 対象 | 箇所 | 種別 | 方針 |
| --- | --- | --- | --- |
| `threadGroups` の説明 | `android/core/.../ThreadNavigation.kt` | コメントのみ | 実装に合わせる。並びのコードは変えない |
| 一覧検査 | `ThreadNavigationTest.kt` の当該関数 | テスト | 一覧順 + `orderedThreads` |
| シートの並び | `TaskRules.kt` の KDoc と `TaskRulesTest.kt` | コメントとテスト | 実装は `listedThreads` のまま。期待を帯の中の保存順 / 更新順に合わせる |
| handoff 検査 | `server/independent-threads-api.test.ts` の当該 `it` | テスト | `running` を待つ。製品の busy は変えない |

`listedThreads` / `orderedThreads` / `roomHandoffs` の busy 実装は変更しない。呼び出し元の挙動は変わらない。

## テスト

- 変更した vitest を隔離フィクスチャとして実行する。ローカルは `node:sqlite` がある Node 22.19.0。CI と `package.json` の `engines.node` は 24。この検査の期待は Node の版に依存しない。
- 変異: busy を「direct かつ bot が busy なら待たせる」に戻すと、`running` の poll が落ちる。確認後に戻す。
- Android の Gradle は JVM 17 以上が必要で、このマシンは JDK 16 のみ。当該検査は CI の Kotlin job で確認する。断言は完全一致なので、`threadGroups` が注意順に戻ると一覧の期待が落ち、`orderedThreads` が注意順をやめると二番目の期待が落ちる。

## 非対象

iOS UI、`comms.test.ts`、ピンと `updatedAt` の製品動作。
