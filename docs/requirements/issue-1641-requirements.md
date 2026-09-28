# Issue #1641 — main の CI を緑に戻す

## 目的

#1637 を `main`（`6d72b3ac`）へマージした push CI
https://github.com/milind-soni/OpenMausBot/actions/runs/35702797939
が落ちている。直前の `main`（`e8729497`）は緑だった。落ちている検査を、製品のピン留めと更新順を戻さずに通す。

## 失敗

1. Android `ThreadNavigationTest.closedThreadsRemainAccessibleWhenCurrentUnreadRunningWaitingOrManaging`。`threadGroups()` はピン + 更新順なのに、検査が古い注意順 `waiting, busy, queued, unread, current` を期待している。550 件中この 1 件だけ失敗。
2. `server/independent-threads-api.test.ts` の「peer の承認の後ろで coordinated work は queued のまま」という検査。Windows shard 1/4 で 10 秒間 `running` のまま。PR head では macOS と Windows の両方が同じ断言で落ちた。マージ後の macOS shard は先に `queued` を読んで通った。
3. Windows shard 3/4 の `server/comms.test.ts` は `fetch failed` / `ECONNRESET`。このファイルは #1637 も今回も変更しない。再現しない限り別件。

iOS UI は PR head で落ち、マージ後の run では通った。今回は触らない。

## 受け入れ

- Android の一覧検査は、同じスタンプなら保存順（見えるスレッドは `current, unread, busy, waiting, queued`）。注意順は `orderedThreads` が引き続き `waiting, busy, queued, unread, current` であること。
- `TaskRules.tasks` の検査も同じ契約にする。開いている帯の中は保存順または更新順で、注意順では並べない。ピンは帯の先頭。未読のアーカイブは開いている帯に残るが、同じ時刻なら保存位置のまま。routine 実行だけピッカーから隠す。
- 同時スレッド数が 3 でも、peer の承認カードが開いているあいだ fresh な coordinated work は tick を超えて `queued` のまま、別スレッドは動き出さない。承認すると 1 回だけ届く。兄弟が実行中のときの空き枠開始と、resume がカードで止まらないことは維持する。承認ソケットは無人で答えず、レビュー本文は人が開いているスレッドに入らない。
- ピン留め、更新順、`updatedAt` の付け方は変えない。

## 非スコープ

- handoff の busy 判定を bot 全体の busy に戻すこと（#1589 は空きスロットを開始する）。
- iOS のトグル検査。マージ後の CI では通っている。
- `comms.test.ts` の `ECONNRESET`。今回の差分では再現手順がない。
- Vercel のデプロイ認可。
