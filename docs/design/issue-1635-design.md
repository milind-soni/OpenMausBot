# Issue #1635 — Design

要件: `docs/requirements/issue-1635-requirements.md`

## レビュー反映

要件・設計の初回レビュー（Claude / Grok。Codex は実装前に取り込む）で、コードと突き合わせて残したもの。

- スレッド一覧の比較は新しい `orderedThreadList`。既存の `orderedSidebarThreads` は注意順のまま残し、ベル、折りたたみ中の他スレッド、All-threads の注意セクションはそれを使い続ける。iOS の Updates / Live Activity も `threadGroups` ではなく注意順の専用列を使う。
- All-threads ピッカー（`ConversationTaskPicker` / `groupThreadTasks`）とチャンネル一覧も `orderedThreadList` で並べる。
- 6 件は、ピンと「注意が必要」を数に入れず、開いているスレッドを更新が新しい順に 6 件。ピンは閉じていてもアーカイブされていても残る。モバイルの Archived セクションへはピンを送らない。
- デスクトップのフォルダ順は、見えているスレッドの先頭が上になるように直す。今の比較は逆順で、コメントと一致していない。
- チャンネルのピンは、作業中でも付け外しできる。タイトル変更は今どおり作業中は 409。クライアントは `{ pinned, title: 今のタイトル }` を送る。古いサーバは未知の `pinned` を無視して同じタイトルを書き戻すだけで、空タイトルにして「Untitled」にしない。
- `updatedAt` は進むだけ。起動時は未設定、または SQLite の `MAX(at)` の方が新しいときだけ直す。メッセージ行の削除は無いので、下げない。レガシー JSON の取り込みのあとで行う。`appendMessage` / `insertMessageAfter` / `branchMessage` / `importTranscript` がメモリを進める。`saveBots` はメッセージのたびに呼ばない。
- クライアントはスナップショットで `updatedAt` を `max(手元, サーバ)` にする。デスクトップは背面スレッドの early-return と、アクティブでないチャンネルタスクでも進める。楽観送信は進め、取り消しは残っているメッセージの最大に戻す。iOS / Android の `Store` の message 適用でもタスクを進める。
- `pinned: false` は `saveBots` / `saveGroups` の直前に落とす。`TASK_PATCH_FIELDS` に `pinned` を入れる。
- チームバックアップは `pinned` を運び、復元時の `updatedAt` はバックアップ内メッセージの最大 `at`（無ければ `createdAt`）。
- 文言は既存の `sidebar.bot.pin` / `sidebar.bot.unpin` を使う。モバイルのピンラベルは Archive と同じく画面側の英語。

マスター設計書はこのリポジトリに無い。このファイルが決定の記録である。

## 決定

### 並び

表示順は次の比較だけにする。注意ランクは使わない。

1. `pinned === true` が先
2. `updatedAt ?? createdAt` の降順
3. 同じなら、入力配列での元の位置（安定）

`activeId` は順位に使わない。呼び出し側の引数は残し、可視性（今開いている行を 6 件制限から外す）にだけ使う。

検索結果もこの順にする。一致条件は変えない。フォルダ名に一致したフォルダの中身も、この順である。

### 更新時刻

`updatedAt` は `WireTask` と `GroupTask` の任意の epoch ms。

- 作成時は `createdAt` と同じ値を入れる。
- `Store.appendMessage` と `Store.insertMessageAfter` がメッセージを確定したあと、その `threadId` を持つボットタスクとチャンネルタスクのメモリ上の `updatedAt` をメッセージの `at` にする。ここでは `saveBots` / `saveGroups` を呼ばない。
- 起動時に、各タスクの `updatedAt` が欠けるか、そのスレッドの `MAX(messages.at)` より古いときだけ、SQL の最大値（無ければ `createdAt`）へ直して一度保存する。メッセージ削除で最新行が消えたあとも、次の起動で追いつく。
- クライアントは `messageAdded`（背面スレッドのバッファに入る場合を含む）と楽観的送信で、ローカルの `updatedAt` を `max(既存, message.at)` にする。次の bot/group スナップショットがサーバ値で上書きする。

`updatedAt` は `TASK_PATCH_FIELDS` にも HTTP の許可キーにも入れない。

### ピン

`pinned?: true` を `WireTask` と `GroupTask` に足す。`true` だけを保存し、外すときはプロパティを消す。`false` をディスクに残さない。

- ボット: `PATCH /api/bots/:id/tasks/:threadId` の許可キーに `pinned` を足す。boolean 以外は 400。`patchTask` のあと `pinned !== true` なら `delete task.pinned`。
- チャンネル: `PATCH /api/groups/:id/tasks/:threadId` は今日タイトル専用である。`pinned` を受け、タイトルが無いリクエストでは `renameGroupTask` を呼ばない。未知キーは 400。DM は従来どおり 400。
- 作業中でもピンは変えられる。アーカイブと削除の busy 制限は変えない。

### デスクトップの 6 件

`visibleSidebarThreads` は、検索でも「すべて表示」でもないとき、更新時刻の降順に見てから数える。

- ピンした行は常に残す（閉じていてもアーカイブされていても）
- 閉じた行・アーカイブした行は、注意が必要なときだけ残す（現行の `demandsAttention`）
- それ以外の開いている行は、更新が新しい順に 6 件

そのあと `orderedSidebarThreads` がピン＋更新順に並べる。グループのスレッド一覧も同じ関数を通す（今日は可視フィルタだけで、注意順すら通していない）。

### 行の操作

- デスクトップ: `SidebarThreadRow` のメニューに Pin / Unpin。行にピンアイコン。`onPin` が無い行（渡していない呼び出し）には出さない。
- iOS: 管理シートの context menu と swipe に Pin / Unpin。ツリーとシートの `BotThreadRow` にピンアイコン。相対時刻は `updatedAt ?? createdAt`。
- Android: スレッドシートの Archive の隣に Pin / Unpin。行の相対時刻は同じ。ピンアイコンを出す。

文言は `en.json` の `task.pin` / `task.unpin` のみ足す。他言語は英語へフォールバックする。

### 変えないもの

- `ios/Sources/CompanionCore/AttentionInbox.swift` と `android/.../ui/AttentionInbox.kt` の attention 順位
- フォルダの保存順（モバイル）。デスクトップのフォルダは、今日どおり「見えているスレッドの最先頭」に付いて動く。順序が変わるので、ピンや直近の更新を含むフォルダが上に来る。
- ルーチン内部実行（`routineRunId`）は一覧から除外したまま
- bot-to-bot DM はタスク配列を持たない

## 影響範囲

### 変更対象

| 対象 | 変更 |
|---|---|
| `shared/wire.ts` `WireTask` / `GroupTask` | `pinned?: true`、`updatedAt?: number` |
| `server/store.ts` `TaskRecord`（`WireTask` を extends）、`GroupTaskRecord` | 同じフィールド。作成・追記・起動時の埋め |
| `server/message-db.ts` | スレッドごとの `MAX(at)` |
| `server/index.ts` タスク PATCH | `pinned` の許可と検証 |
| `src/state/store.tsx` `Task` / `GroupTask` | 同じフィールド。メッセージ受信で `updatedAt` を進める |
| `src/components/SidebarThreadRow.tsx` | 順序と比較、メニュー |
| `src/components/Sidebar.tsx` | 検索とグループ一覧も同じ順 |
| iOS `Models.swift` `BotTask`、`ThreadNavigation.swift`、`BotThreadRow.swift`、`TaskManagerView.swift`、`Client.swift` | デコード、順序、ピン操作 |
| Android `Models.kt` `BotTask`、`ThreadNavigation.kt`、`BotThreadRow.kt`、`TaskSheet.kt`、`Client.kt` | 同じ |

`TaskRecord` は `WireTask` を継承し、`toWireTask` は私有キーを除いた残りを返す（`server/store.ts` の `TaskWireProjectionIsExact`）。新しい公開フィールドは `WireTask` に足せばワイヤへ乗る。私有キーには入れない。

### 影響箇所

順序の消費者（表示が変わる）:

- `orderedSidebarThreads` の呼び出し: `Sidebar.tsx`、`SidebarBotActivity.tsx`、`TaskPicker.tsx`
- `visibleSidebarThreads` の呼び出し: `Sidebar.tsx`（ボットとグループ）
- `Bot.threadGroups` の呼び出し: iOS `BotThreadTree.swift`、`TaskManagerView.swift`、`ChatListView.swift`、`Updates.swift`。Android `BotThreadTree.kt`、`TaskSheet.kt`、`TaskRules.kt`
- `orderedThreads` / `attentionRank`（スレッド一覧用）: `ThreadNavigation.kt`。Android `TaskRules.kt`

順序を変えてはいけないもの:

- `AttentionInbox.swift` の `attentionRank`、`AttentionInbox.kt` の `attentionRank`。別関数。スレッド一覧の `attentionRank` を消してもこちらは残す。

永続化とワイヤ:

- `saveBots` はタスクから `busy` / `activity` を除いて書く。`pinned` と `updatedAt` は残る。`updatedAt` はメッセージのたびに保存しない。
- コンパニオンの JSON は未知キーを無視する（Android `CompanionJson.ignoreUnknownKeys = true`、iOS `JSONDecoder` の既定）。古いアプリは新しいフィールドが付いても落ちない。

### 影響種別

- 機能: 一覧の順序が変わる。注意が必要な古いスレッドは、更新が新しければ上、古ければ下。6 件の外でも可視性は残す。
- 互換: 新しい任意フィールドのみ。PATCH の未知キーは今日も 400 なので、古いサーバに新しいアプリが `pinned` を送ると 400 になる。失敗は既存のタスク更新エラーとして見せる。
- セキュリティ: ピンは既存のタスク PATCH と同じ認可。承認モードやモデルは変えない。
- 性能: 起動時にスレッドごとの `MAX(at)` を一回。メッセージごとにはメモリ更新だけ。

### 対応方針

- 三クライアントのテストを、同じ例（ピンが先、更新が新しい順、同時刻は元の順、注意状態は順位を動かさない）に揃える。
- デスクトップの既存テストは、時刻が全員同じなら元の配列順のままなので、6 件制限の多くはそのまま通る。注意順を期待している `orderedSidebarThreads` のテストは書き換える。
- 起動時の埋めは「SQL の最大値が保存値より新しい、または未設定」のときだけ書き、毎回 `bots.json` を汚さない。

### 未影響の根拠

- Attention inbox は別の `attentionRank` であり、`orderedSidebarThreads` を呼ばない。
- ルーチン定義や webhook の `updatedAt` は別型。タスクのフィールド追加はそれらを変えない。
- DM は `group.tasks` を持たず、`createGroupTask` が拒否する。

## テスト

- `src/components/SidebarThreadRow.test.ts`: ピン、更新順、同時刻の安定、6 件が更新順、ピンと attention は 6 件の外でも残る、閉じたピンは残る。
- `server` のタスク API テスト: `pinned: true` が再読込後に残る、`false` でキーが消える、boolean 以外は 400、`updatedAt` を PATCH しても 400、メッセージ追記でワイヤの `updatedAt` が進む、メッセージの無いタスクは `createdAt`。
- iOS `ThreadNavigationTests`、Android `ThreadNavigationTest`: 同じ順序契約。
- 変異: ピン比較を外すとピンのテストが落ちる。`updatedAt` の比較を外すと更新順のテストが落ちる。6 件を配列順のままに戻すと「古い行を更新したら入る」テストが落ちる。

## UI 確認

デスクトップは隔離したフィクスチャで、ピンと更新順をサイドバーで操作する。iOS / Android はユニットテストで順序と PATCH ボディを固定し、実機の headed 操作はこの環境ではしない。
