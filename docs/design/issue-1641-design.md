# Issue #1641 — 設計

## 原因

### Android

`Bot.threadGroups()` は `listedThreads`（ピン、次に `updatedAt ?: createdAt`、同点は保存順）で並べる。注意順は `orderedThreads` に残している。失敗した検査だけが、一覧に古い注意順を期待していた。対象スレッドはすべて `createdAt = 1` で `updatedAt` が無いので、見える行の一覧順は保存順 `current, unread, busy, waiting, queued` である。`quiet` は閉じた idle なので畳む。`run` は routine 実行なので一覧に出ない。

### handoff

`roomHandoffs` の fresh work は、相手の別スレッドが `waiting-on-you` でも空き枠があると次の tick で `running` になっていた。tick は 250ms 間隔なので、enqueue から次の tick までは 0〜250ms である。検査が tick 前の `queued` を読むと通り、負荷のかかった runner は 10 秒 `running` を見て落ちる。`e8729497` でも同じで、#1637 が busy を変えたわけではない。

承認カードのあいだ fresh work を待つのは #1128 のメールボックス契約である。#1278 は resume だけをスレッド単位にし、fresh work はカードのあいだ待たせると書いた。#1589 が空き枠を認めたのは、兄弟が実際に走っているときであり、承認カードの検査は `queued` のままだった。フックがカードと実行中を区別しなくなったのが回帰で、レースがそれを隠していた。

#1626 が `expect(status).toBe("queued")` を `expect.poll(...).toBe("queued")` に変えた。状態は最初から `queued` で、tick の後に `queued` ではなくなる。poll は最初の観測が tick より後だと 10 秒 `running` を見続けて失敗する。速い観測は tick 前の `queued` で通る。マージ CI の macOS 成功と Windows 失敗、ローカルで遅延を入れると `e8729497` でも失敗すること、はこのレースで説明できる。`running` になってから承認しても、結果は 1 回だけ別スレッドに届き、開いているスレッドには `MAILBOX_REVIEW` が入らない。

### comms

`TypeError: fetch failed` / `read ECONNRESET`。#1637 の差分に `server/comms.test.ts` は無い。今回も変えない。

## 変更

- Android の core 検査は一覧順と `orderedThreads` の注意順を両方断言する。`threadGroups` の KDoc は「注意が行を動かす」と書かない。
- `TaskRules.tasks` も同じ一覧順で、開いている帯・閉じた帯・アーカイブの帯に分けたあと各帯の中を並べる。core の失敗で app の単体テストまで進んでいなかったので、`TaskRulesTest` の注意順期待も合わせる。KDoc も合わせる。
- fresh work の busy は、宛先スレッド、枠、グループターンに加え、他スレッドの `waiting-on-you` でも待つ。resume は #1278 のままカードでは待たない。兄弟が `working` のときの空き枠開始（#1589）は維持する。
- handoff 検査は同時スレッド数 3 のまま、承認カードが開いているあいだ ledger が tick を超えて `queued` で、別スレッドは `busy` にならないことを見る。承認のあと 1 回届くことは残す。
- `orderedThreads` は画面から呼ばれていないので、その説明を「未使用の注意順ヘルパー」に直す。

## 影響範囲

| 対象 | 箇所 | 種別 | 方針 |
| --- | --- | --- | --- |
| `threadGroups` の説明 | `android/core/.../ThreadNavigation.kt` | コメントのみ | 実装に合わせる。並びのコードは変えない |
| 一覧検査 | `ThreadNavigationTest.kt` の当該関数 | テスト | 一覧順 + `orderedThreads` |
| シートの並び | `TaskRules.kt` の KDoc と `TaskRulesTest.kt` | コメントとテスト | 実装は `listedThreads` のまま。期待を帯の中の保存順 / 更新順に合わせる |
| handoff の busy | `server/index.ts` の `recipientAwaitingPerson` | 機能 | fresh work だけ、他スレッドの `waiting-on-you` で待つ。resume と、兄弟が `working` の空き枠は変えない |
| handoff 検査 | `server/independent-threads-api.test.ts` の当該 `it` | テスト | 枠が 3 でも承認中は `queued` |

`listedThreads` / `orderedThreads` / `roomHandoffs` の busy 実装は変更しない。呼び出し元の挙動は変わらない。

## テスト

- 変更した vitest を隔離フィクスチャとして実行する。ローカルは `node:sqlite` がある Node 22.19.0。CI と `package.json` の `engines.node` は 24。この検査の期待は Node の版に依存しない。
- 変異: busy を「direct かつ bot が busy なら待たせる」に戻すと、`running` の poll が落ちる。確認後に戻す。
- Android の Gradle は JVM 17 以上が必要で、このマシンは JDK 16 のみ。当該検査は CI の Kotlin job で確認する。断言は完全一致なので、`threadGroups` が注意順に戻ると一覧の期待が落ち、`orderedThreads` が注意順をやめると二番目の期待が落ちる。

## 非対象

iOS UI、`comms.test.ts`、ピンと `updatedAt` の製品動作。
