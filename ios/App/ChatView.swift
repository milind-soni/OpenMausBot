// One conversation: the transcript, the approval cards, and the composer.
//
// The transcript is whatever the harness folded — settled text, tool chips,
// option cards, screenshots. This renders those and nothing else; it does
// not re-derive anything from provider events, because the server already
// did that and having two folds is how two clients start disagreeing.
import SwiftUI
import CompanionCore
import PhotosUI
import UniformTypeIdentifiers
import ImageIO
// Unconditional, because the uses below are: `Color(uiColor:)` and
// `UIImage(data:)` are reached on every path through this file. A
// `canImport` guard around the import alone does not make the file portable
// — it only moves the failure from "no such module" to "no such type", and
// hides that this view is iOS-only behind something that looks like it
// isn't. The App target is iOS; CompanionCore is where the portable half
// lives.
import UIKit
import AVFoundation

struct ChatView: View {
    let chat: Chat
    @State private var selectedThreadId: String
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var liveCall: LiveCallController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// The composer's text. Held, not observed: a keystroke redraws the
    /// composer (`DraftReader`) and leaves this body and the transcript be.
    @State private var composerDraft = ComposerDraft()
    /// Where the transcript rows' taps go (see `TranscriptRouter`).
    @State private var router = TranscriptRouter()
    /// The last render's reading of the thread, reused while it is unchanged.
    @State private var snapshotMemo = TranscriptMemo()
    @State private var revealedMessageId: String?
    /// The reader has dragged this thread's transcript since it opened.
    @State private var readerScrolled = false
    /// The reader scrolled the transcript themselves and has not come back to
    /// its end: nothing scrolls it for them meanwhile. Known from the scroll
    /// phase (iOS 18); below that, only from the end being out of view.
    @State private var readerDetached = false
    /// Where the transcript's end last sat, kept by reference so a scrolled
    /// frame updates it without redrawing the screen.
    @State private var scrollReading = ScrollReading()
    @State private var showingTasks = false
    @State private var showingComputer = false
    @State private var showingPlus = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var shareFile: ShareFile?
    @State private var showingPhotoPicker = false
    @State private var showingFileImporter = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var attachments: [PendingMessageAttachment] = []
    private struct ComposerSnapshot {
        var text = ""
        var attachments: [PendingMessageAttachment] = []
        var error: String?
    }
    @State private var threadDrafts: [String: ComposerSnapshot] = [:]
    @State private var preparingAttachments = false
    @State private var sendingMessage = false
    @State private var steering = false
    @State private var attachmentError: String?
    @State private var openingFileName: String?
    @State private var fileOpenError: String?
    @State private var filePreview: FilePreviewItem?
    @State private var fileDownloadTask: Task<Void, Never>?
    @State private var fileDownloadRequestID: UUID?
    @State private var threadOpenTask: Task<Void, Never>?
    /// The bot whose Live call waits on the first-call disclosure.
    @State private var disclosingLiveCall: Bot?
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()
    /// The opening beat: the island grows with the bot's face in it, then
    /// shrinks away as the face settles into the header. `facePhase` is 1
    /// with the face in the island, 0 with it home in the header.
    @State private var islandExpanded = false
    @State private var islandVisible = false
    @State private var facePhase: CGFloat = 0
    /// Reading scrollback: the end of the transcript is below the screen, so
    /// the Jump to latest pill is offered. Tracked from two edges rather than
    /// a scroll offset, because iOS 16 has no scroll-position API.
    @State private var viewportBottom: CGFloat = 0
    @State private var showsJumpToLatest = false
    /// VoiceOver has heard "… is typing" for this turn.
    @State private var typingAnnounced = false
    /// Bumped by a send: the transcript goes to its end, wherever the
    /// reader had scrolled.
    @State private var sendJumps = 0

    @AppStorage(PrefKey.islandIntro) private var islandIntro = IslandIntro.oncePerBot.rawValue
    @AppStorage(PrefKey.islandSeen) private var islandSeen = ""
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.phoneDefault.rawValue
    @AppStorage(PrefKey.quickReplies) private var quickReplies = ""

    init(chat: Chat) {
        self.chat = chat
        _selectedThreadId = State(initialValue: chat.threadId)
    }

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"
    /// The last thing in the transcript, after any live bubble: where Jump to
    /// latest lands, and the edge measured to decide whether to offer it.
    static let transcriptEndId = "companion.end"
    /// How far the end may sit below the screen before the pill appears — a
    /// small overscroll or a half-hidden last line is not scrollback.
    static let jumpToLatestThreshold: CGFloat = 160
    /// How close to the end a scroll must come to rest for the transcript to
    /// follow new messages again: at the end, give or take a line.
    static let followSlack: CGFloat = 24

    /// The live chat record, so busy/unread stay current as frames land.
    private var current: Chat {
        switch chat {
        case let .bot(bot):
            if let view = session.state.bot(bot.id)?.projected(forThread: selectedThreadId) { return .bot(view) }
            // Keep the exact target until a removed thread dismisses. Never
            // briefly fall back to a sibling while the view is closing.
            var removed = bot
            removed.threadId = selectedThreadId
            removed.busy = false
            return .bot(removed)
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    /// Bot selection is local to this screen; another device's navigation
    /// must not move a draft, approval, or Stop action to a different thread.
    private var threadId: String { current.threadId }

    private var selectedThreadWasRemoved: Bool {
        guard case let .bot(bot) = chat else { return false }
        guard let live = session.state.bot(bot.id) else { return true }
        return live.tasks.map { !$0.contains { $0.threadId == selectedThreadId } } ?? false
    }

    /// A task changes a bot's thread, but it does not make it a new bot.
    /// Intro history follows the chat itself so switching tasks cannot replay
    /// a once-per-bot greeting.
    private var islandIntroID: String {
        switch current {
        case let .bot(bot): "bot.\(bot.id)"
        case let .room(room): "room.\(room.id)"
        }
    }

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: threadId)
    }

    /// The composer's text, for ChatView's own actions (send, switch
    /// threads, dictation). Reading it here does not observe it.
    private var draft: String {
        get { composerDraft.text }
        nonmutating set { composerDraft.text = newValue }
    }

    /// The transcript as the reader has asked to see it: every chip, folded
    /// runs, or none at all.
    private var detail: ActivityDetail { ActivityDetail(rawValue: activityDetail) ?? .phoneDefault }

    /// One render's reading of this thread. The session's branch walk ran
    /// once per caller before (the rows, the live narration twice, the
    /// status line, the approval check): now once, shared by all of them.
    private struct TranscriptSnapshot {
        /// The visible branch the rows were folded from.
        let messages: [Message]
        let rows: [TranscriptRow]
        let versions: [String?: [Message]]
        /// At Hidden, what a working bot has said so far in this turn: left
        /// out of the transcript and shown as one grey status line instead.
        let live: LiveNarration
        let hasPendingApproval: Bool
    }

    /// Reused while the thread, its messages, the bot's busy flag and the
    /// Activity setting are unchanged — which is every publish about another
    /// thread. Reuse is the point, not just the saved work: the rows are
    /// then the same arrays as last time, so each row's values are identical
    /// to the last render's (see `TranscriptRouter`).
    private var transcriptSnapshot: TranscriptSnapshot {
        let messages = self.messages
        let all = session.state.transcript(forThread: threadId)
        let busy = current.busy
        let detail = detail
        let key = TranscriptMemo.Key(threadId: threadId, busy: busy, detail: detail)
        if let reused = snapshotMemo.snapshot(for: key, messages: messages, all: all) { return reused }
        let live = liveNarration(messages, busy: busy, detail: detail)
        let shown = live.hiddenIds.isEmpty ? messages : messages.filter { !live.hiddenIds.contains($0.id) }
        let snapshot = TranscriptSnapshot(
            messages: messages,
            rows: transcriptRows(shown, detail: detail),
            versions: session.state.userMessageVersions(inThread: threadId),
            live: live,
            hasPendingApproval: messages.contains { $0.card?.isPending == true }
        )
        snapshotMemo.remember(snapshot, for: key, messages: messages, all: all)
        return snapshot
    }

    /// The last `TranscriptSnapshot` and what it was read from. A cache held
    /// by reference: filling it is not a change anything should redraw for.
    private final class TranscriptMemo {
        struct Key: Equatable {
            let threadId: String
            let busy: Bool
            let detail: ActivityDetail
        }

        private var key: Key?
        private var messages: [Message] = []
        private var all: [Message] = []
        private var snapshot: TranscriptSnapshot?

        /// An unforked thread's branch is its stored array, so while nothing
        /// arrives in it these compare by identity, not message by message.
        func snapshot(for key: Key, messages: [Message], all: [Message]) -> TranscriptSnapshot? {
            guard key == self.key, messages == self.messages, all == self.all else { return nil }
            return snapshot
        }

        func remember(_ snapshot: TranscriptSnapshot, for key: Key, messages: [Message], all: [Message]) {
            self.key = key
            self.messages = messages
            self.all = all
            self.snapshot = snapshot
        }
    }

    private var rows: [TranscriptRow] { transcriptSnapshot.rows }

    /// The transcript ends with the typing bubble: busy, not waiting on you,
    /// and the last row on screen is not a finished reply (`TurnTail`). A
    /// stream bubble takes the slot instead where the detail level shows one.
    private func showsTyping(_ snapshot: TranscriptSnapshot) -> Bool {
        let streaming = !(session.state.streaming[threadId] ?? "").isEmpty
            || !(session.state.reasoning[threadId] ?? "").isEmpty
        return current.showsTyping(messages: snapshot.messages, hiddenIds: snapshot.live.hiddenIds, streaming: streaming)
    }

    /// The status line's words: the reply as it streams, else the newest
    /// in-between message. Nil unless Hidden and the bot is working.
    private func liveStatusLine(_ snapshot: TranscriptSnapshot) -> String? {
        guard current.busy, detail == .hidden else { return nil }
        if let streaming = session.state.streaming[threadId], !streaming.isEmpty {
            return String(streaming.suffix(240))
        }
        return snapshot.live.latest
    }

    /// The composer's chip row, as edited in Settings.
    private var storedChips: [ActionChipItem] { StoredChips.chips(quickReplies) }

    /// Unread elsewhere — what the back pill's badge counts, like Messages.
    private var unreadElsewhere: Int {
        let mine = current.unread ? 1 : 0
        return max(0, session.state.unreadCount - mine)
    }

    var body: some View {
        // Read the transcript once for this render. Pagination changes the
        // array as a unit; repeatedly reaching through ObservableObject for
        // every row only recomputes the same value.
        let snapshot = transcriptSnapshot
        // A VStack with the composer as a sibling, rather than a scroll view
        // with `.safeAreaInset`. The inset version sized itself to its
        // content, so a short transcript left the composer floating in the
        // middle of the screen with black beneath it. Here the scroll area is
        // explicitly told to take everything the composer does not.
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                transcriptScrollView(proxy: proxy, snapshot: snapshot)
            }
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            liveCallBars
            composer(snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .bottom) { plusSheet }
        .overlay(alignment: .bottomTrailing) { busyFleetFixtureBadge }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        // Hiding the bar above also disarms the system edge-swipe back
        // gesture, which is wired to the bar's navigation controller.
        // Re-arm it so a rightward swipe from the left edge pops back to
        // Home, the way the rest of iOS behaves.
        .background(SwipeBackBridge())
        .navigationDestination(isPresented: $showingComputer) {
            if case let .bot(bot) = current { ComputerView(bot: bot) }
        }
        .task(id: threadId) { await enterThread() }
        .onValueChange(of: selectedThreadWasRemoved) { removed in
            if removed { dismiss() }
        }
        .onValueChange(of: session.state.hasLoadedPage(forThread: threadId)) { loaded in
            reloadIfPageDropped(loaded)
        }
        .onValueChange(of: current.unread) { unread in markReadIfNeeded(unread) }
        .onValueChangePair(of: threadId) { previous, next in switchThread(from: previous, to: next) }
        .onValueChange(of: session.connection?.id) { _ in
            steering = false
            cancelThreadOpen()
        }
        .onValueChange(of: heldSends.first?.queueId) { _ in steering = false }
        .onValueChange(of: current.busy) { busy in
            if !busy {
                steering = false
                typingAnnounced = false
            }
        }
        .onValueChange(of: threadId) { _ in
            steering = false
            typingAnnounced = false
        }
        .task(id: steering) { await expireSteering() }
        .onDisappear {
            dictation.stop()
            resetFilePreview()
            cancelThreadOpen()
        }
        .onValueChange(of: scenePhase) { phase in
            if phase != .active { dictation.stop() }
        }
        .onValueChange(of: showingComputer) { shown in
            if shown { dictation.stop() }
        }
        .onValueChange(of: showingTasks) { shown in
            if shown { dictation.stop() }
        }
        .onValueChange(of: showingProfile) { shown in
            if shown { dictation.stop() }
        }
        .onValueChange(of: showingPlus) { shown in
            if shown { dictation.stop() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
            stopDictation(ifInterruptedBy: note)
        }
        .onValueChange(of: dictation.transcript) { spoken in
            // Always join against the text frozen at capture start. A newer
            // partial then replaces the older partial instead of duplicating it.
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onValueChange(of: dictation.isListening) { listening in
            if listening { composerFocused = false }
        }
        // The sheet's hosting controller on iOS-on-Mac does not inherit
        // @EnvironmentObject; see the same note on ChatListView.
        .sheet(isPresented: $showingTasks) {
            if current.supportsTasks {
                TaskManagerView(chat: current) { selectedThreadId = $0 }
                    .environmentObject(session)
            }
        }
        .sheet(isPresented: $showingProfile) {
            if case let .bot(bot) = current {
                AgentProfileView(bot: bot)
                    .environmentObject(session)
            }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $selectedPhotos,
            maxSelectionCount: max(1, AttachmentPolicy.maximumItems - attachments.count),
            matching: .images,
            preferredItemEncoding: .current
        )
        .onValueChange(of: selectedPhotos) { items in
            guard !items.isEmpty else { return }
            Task { await importPhotos(items) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.content],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .fullScreenCover(item: $filePreview) { preview in
            FilePreviewView(item: preview) {
                filePreview = nil
            }
        }
        // A phone has no Live switch: its first call is where Live is turned
        // on, so that call says first what a call sends to OpenAI (the
        // settings sheet's sentence). Start call remembers it on this phone;
        // Cancel starts nothing and leaves it for the next try.
        .alert(
            Text("A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays on your computer."),
            isPresented: Binding(
                get: { disclosingLiveCall != nil },
                set: { if !$0 { disclosingLiveCall = nil } }
            ),
            presenting: disclosingLiveCall
        ) { bot in
            Button("Cancel", role: .cancel) {}
            Button("Start call") {
                LiveCallDisclosure().accept()
                startLiveCall(bot)
            }
        }
    }

    // MARK: - Transcript

    /// The transcript: its rows, the live tail, the header and face that
    /// float over it, and the scrolling that keeps the newest message in view.
    private func transcriptScrollView(proxy: ScrollViewProxy, snapshot: TranscriptSnapshot) -> some View {
        let transcript = snapshot.rows
        let actions = transcriptActions(proxy)
        return ScrollView {
            transcriptColumn(proxy: proxy, snapshot: snapshot, actions: actions)
        }
        // The header lives in the scroll view's top safe area: the
        // transcript starts below it and scrolls under it — that is
        // what the glass is for. An inset rather than a content
        // margin, because `.defaultScrollAnchor(.bottom)` anchored
        // unreliably against a margin and opened chats mid-way.
        // The blur is only the top strip — back, computer — the way
        // a system bar is; the transcript starts on that line and
        // scrolls under the face and name, which float over it.
        .safeAreaInset(edge: .top, spacing: 0) { headerBar }
        .overlay(alignment: .top) { headerFace }
        .overlay(alignment: .top) { floatingFace }
        // Reading scrollback — one tap back to the end, streaming or
        // not, the same pill the desktop chat offers.
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { bottom in
            viewportBottom = bottom
        }
        .overlay(alignment: .bottom) { jumpToLatestPill(proxy) }
        .task { await playIslandIntro() }
        // A conversation grows from the bottom: a transcript shorter
        // than the screen rests at the bottom, and opening a chat
        // starts on the newest message rather than the oldest.
        .scrollAnchorCompat(.bottom)
        // Tapping the transcript puts the keyboard away. The composer
        // is a sibling of this scroll view rather than inside it, so
        // nothing else here drops its focus — until this, the only way
        // back to the whole conversation was to leave the chat.
        // Simultaneous, not `.onTapGesture`: a tap that lands on a
        // link, a card button or a selected word still reaches the row
        // that owns it, and only also closes the keyboard.
        .simultaneousGesture(TapGesture().onEnded {
            if composerFocused { composerFocused = false }
        })
        // And a drag down over the transcript pushes it away, the way
        // it does in Mail and Messages.
        .scrollDismissesKeyboard(.interactively)
        .modifier(FollowsLatest(
            proxy: proxy,
            lastRowId: transcript.last?.id,
            streamLength: session.state.streaming[threadId]?.count ?? 0,
            // Read from the last layout, before this update's rows are
            // laid out: a tall new row that pushes the end off screen is
            // the transcript growing, not the reader leaving.
            follows: !readerDetached && !showsJumpToLatest,
            typing: showsTyping(snapshot),
            sendJumps: sendJumps,
            reduceMotion: reduceMotion
        ))
        // Neither of the above is enough on its own when the newest
        // message holds a table or a code block. Their horizontal
        // scroll views throw off the height the anchor measures on
        // the first pass, so the chat opened a table's height short
        // of the end; and the `initial` scroll above runs before
        // there is anything to scroll. One more scroll once the first
        // layout has settled lands on the end — again when the page
        // arrives from the computer, which can be after the push,
        // unless the reader has already scrolled away to read.
        .task(id: "\(threadId)|\(session.state.hasLoadedPage(forThread: threadId))") {
            await settleOnEnd(proxy)
        }
        // iOS 18 says when the reader starts and stops scrolling; below
        // that the transcript stops following only once its end is out of
        // view (`showsJumpToLatest`).
        .onUserScrollCompat { scrolling in readerScroll(scrolling) }
        .task(id: session.focusedMessageId) { revealFocusedMessage(proxy, in: transcript) }
    }

    /// The rows, then whatever is live, then the end marker.
    private func transcriptColumn(
        proxy: ScrollViewProxy, snapshot: TranscriptSnapshot, actions: TranscriptActions
    ) -> some View {
        let transcript = snapshot.rows
        let shared = RowShared(
            context: rowContext,
            today: RosterDay.today,
            pendingEditId: session.state.pendingEdits[threadId]?.placeholderId,
            versions: snapshot.versions,
            actions: actions
        )
        // VStack, not LazyVStack. A lazy stack does not know how
        // tall it is until its rows have been built, so
        // `.defaultScrollAnchor(.bottom)` anchors against an
        // estimate and the chat opens somewhere in the middle of
        // the conversation. Building all of it up front makes the
        // height exact and the anchor land on the newest message.
        // A thread holds 50 messages until you ask for more, so
        // there is nothing here worth being lazy about. Each row is
        // `.equatable()` on the values it draws: a publish or a
        // keystroke that changes none of them does not redraw it.
        return VStack(alignment: .leading, spacing: 6) {
            // room for the floating face when scrolled to the top
            Color.clear.frame(height: 72)

            if session.state.hasMore[threadId] == true {
                loadEarlierButton(proxy: proxy, transcript: transcript)
            }

            ForEach(Array(transcript.enumerated()), id: \.element.id) { index, row in
                rowView(row, at: index, in: transcript, shared: shared)
                    .equatable()
                    .id(row.id)
            }

            liveTail(snapshot)
            transcriptEnd
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: CompanionLayout.chatWidth, alignment: .leading)
        .frame(maxWidth: .infinity)
    }

    private func loadEarlierButton(proxy: ScrollViewProxy, transcript: [TranscriptRow]) -> some View {
        Button("Load earlier messages") {
            // keep the reader where they were: after older
            // messages are prepended, sit back on the one
            // that used to be at the top
            let anchor = transcript.first?.id
            Task {
                await session.loadOlder(threadId: threadId)
                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
            }
        }
        .font(.footnote)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    /// What every row of one render shares.
    private struct RowShared {
        let context: TranscriptRowContext
        let today: Date
        let pendingEditId: String?
        let versions: [String?: [Message]]
        let actions: TranscriptActions
    }

    /// The chat-wide values the rows draw from, read once per render
    /// rather than once per row.
    private var rowContext: TranscriptRowContext {
        let chat = current
        var bot: Bot?
        if case let .bot(value) = chat { bot = value }
        let connection = session.connection
        return TranscriptRowContext(
            threadId: chat.threadId,
            name: chat.name,
            color: chat.color,
            botId: bot?.id,
            busy: bot?.busy == true,
            editPending: session.state.pendingEdits[chat.threadId] != nil,
            claudeInstanceId: bot?.currentTaskModelSelection.instanceId,
            credentials: CredentialAccess(
                connectionId: connection?.id,
                pairedForSecrets: connection.map { $0.secretPublicKey != nil && $0.companionDeviceId != nil } ?? false,
                transportProtected: session.phoneCredentialTransportIsProtected,
                status: session.status,
                resetGeneration: session.credentialEntryResetGeneration
            )
        )
    }

    /// One row as plain values. The per-row lookups that used to happen in
    /// the row's own body (its pending edit, its routine's thread) happen
    /// here, once, so the row never reads the session.
    private func rowView(
        _ row: TranscriptRow, at index: Int, in transcript: [TranscriptRow], shared: RowShared
    ) -> TranscriptRowView {
        var versions: [Message] = []
        var routineRun: ThreadRef?
        var revealed: String?
        switch row {
        case let .message(message):
            if message.role == .user, message.kind == .text { versions = shared.versions[message.parentId] ?? [] }
            if message.kind == .routineRun, let card = message.routineRun {
                routineRun = session.state.routineExecutionRef(for: card)
            }
        case let .assistantTurn(turn):
            if let id = revealedMessageId, turn.messages.contains(where: { $0.id == id }) { revealed = id }
        case .activityRun:
            break
        }
        return TranscriptRowView(
            row: row,
            stamp: startsANewStretch(at: index, in: transcript) ? row.head.date : nil,
            today: shared.today,
            endsRun: endsRun(at: index, in: transcript),
            versions: versions,
            isPendingEdit: shared.pendingEditId == row.id,
            routineRun: routineRun,
            context: shared.context,
            revealedMessageId: revealed,
            actions: shared.actions
        )
    }

    /// What the rows may ask of this screen: a value that is the same from
    /// render to render. Binding the router here, rather than when the
    /// transcript appears, means it is bound before any row's own `onAppear`
    /// asks something of it; the router is a plain reference, so binding it
    /// redraws nothing.
    private func transcriptActions(_ proxy: ScrollViewProxy) -> TranscriptActions {
        router.bind(liveChat: { current }, navigate: { navigate($0, proxy: proxy) })
        return TranscriptActions(threadId: threadId, session: session, router: router)
    }

    private func navigate(_ request: TranscriptNavigation, proxy: ScrollViewProxy) {
        switch request {
        case let .thread(ref):
            openThread(ref)
        case let .file(path, messageId):
            openFile(path: path, messageId: messageId)
        case .refusedLink:
            fileOpenError = "This link can't be opened securely."
        case let .reveal(messageId):
            proxy.scrollTo(messageId, anchor: .center)
        }
    }

    /// The reply as it is typed. It sits after the last settled message and
    /// disappears the moment the real one arrives — the store clears it on
    /// the same frame that appends the message, so there is never a beat
    /// where both are on screen.
    /// At Hidden the words go to the status line above the composer; the
    /// transcript keeps the typing bubble, which says the bot is still on it.
    @ViewBuilder private func liveTail(_ snapshot: TranscriptSnapshot) -> some View {
        if current.busy, detail != .hidden, let live = session.state.streaming[threadId], !live.isEmpty {
            StreamingBubble(text: live, reasoning: nil, color: current.color)
                .id(Self.liveBubbleId)
        } else if current.busy, activityDetail != ActivityDetail.hidden.rawValue,
                  let thinking = session.state.reasoning[threadId], !thinking.isEmpty {
            // Only while there is no answer yet. Once tokens
            // of the reply exist, the reasoning is behind us
            // and showing both is just noise.
            StreamingBubble(text: nil, reasoning: thinking, color: current.color)
                .id(Self.liveBubbleId)
        } else if showsTyping(snapshot) {
            TypingIndicatorView(name: current.name)
                .id(Self.liveBubbleId)
                .onAppear(perform: announceTyping)
        }
    }

    /// VoiceOver hears "Pepper is typing" once a turn, when the bubble first
    /// appears. It comes and goes between steps, and saying it every time
    /// would be noise.
    private func announceTyping() {
        guard !typingAnnounced else { return }
        typingAnnounced = true
        guard UIAccessibility.isVoiceOverRunning else { return }
        UIAccessibility.post(notification: .announcement, argument: String(localized: "\(current.name) is typing"))
    }

    private var transcriptEnd: some View {
        Color.clear
            .frame(height: 1)
            .id(Self.transcriptEndId)
            // Only a change of answer touches state: this
            // fires on every scrolled frame.
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { end in
                noteTranscriptEnd(end)
            }
            .accessibilityHidden(true)
    }

    private func noteTranscriptEnd(_ end: CGFloat) {
        scrollReading.endGap = end - viewportBottom
        let reading = end - viewportBottom > Self.jumpToLatestThreshold
        if reading != showsJumpToLatest {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { showsJumpToLatest = reading }
        }
    }

    /// The reader started scrolling (`true`), or the scroll came to rest.
    /// Starting detaches the transcript from the end, so a reply streaming
    /// in cannot pull the page out from under their finger; coming to rest
    /// at the end attaches it again.
    private func readerScroll(_ scrolling: Bool) {
        if scrolling {
            readerScrolled = true
            if !readerDetached { readerDetached = true }
        } else if readerDetached, scrollReading.endGap <= Self.followSlack {
            readerDetached = false
        }
    }

    /// One face, in one layer, measured from the screen's top
    /// edge: it sits in the island while that is open and
    /// glides into its header slot when the island lets go.
    private var floatingFace: some View {
        let topInset = IslandGeometry.topInset
        let islandSide: CGFloat = 220
        // centred in the part of the square the hardware island does not cover
        let islandFaceCentre = IslandGeometry.top + IslandGeometry.size.height + (islandSide - IslandGeometry.size.height) / 2
        let headerFaceCentre = topInset + 26
        let faceSize = 60 + 72 * facePhase
        let faceCentre = headerFaceCentre + (islandFaceCentre - headerFaceCentre) * facePhase
        return ZStack(alignment: .top) {
            if islandVisible {
                IslandShell(expanded: islandExpanded, expandedSize: CGSize(width: islandSide, height: islandSide)) {
                    Color.clear
                }
            }
            ChatAvatarView(chat: current, size: faceSize, state: MausState.forChat(current, in: session.state), animated: MausState.forChat(current, in: session.state).showsActivity || islandExpanded, comets: islandExpanded)
                .offset(y: faceCentre - faceSize / 2)
                .allowsHitTesting(false)
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }

    @ViewBuilder private func jumpToLatestPill(_ proxy: ScrollViewProxy) -> some View {
        if showsJumpToLatest {
            Button {
                readerDetached = false
                withAnimation { proxy.scrollTo(Self.transcriptEndId, anchor: .bottom) }
            } label: {
                Label("Jump to latest", systemImage: "arrow.down")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
                    .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Jump to latest messages")
            .padding(.bottom, 10)
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    /// grow, hold a beat, shrink — the face rides along
    private func playIslandIntro() async {
        guard CompanionLayout.supportsIslandPresentation, !reduceMotion else { return }
        // The intro is a greeting, and a greeting repeated every
        // time you open a chat stops being one.
        let intro = IslandIntro(rawValue: islandIntro) ?? .oncePerBot
        switch intro {
        case .never:
            return
        case .oncePerBot:
            guard !IslandSeen.contains(islandIntroID, in: islandSeen) else { return }
            islandSeen = IslandSeen.adding(islandIntroID, to: islandSeen)
        case .always:
            break
        }
        islandVisible = true
        try? await Task.sleep(for: .milliseconds(40))
        withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) { islandExpanded = true; facePhase = 1 }
        try? await Task.sleep(for: .milliseconds(1000))
        withAnimation(.spring(response: 0.55, dampingFraction: 0.82)) { islandExpanded = false; facePhase = 0 }
        try? await Task.sleep(for: .milliseconds(600))
        islandVisible = false
    }

    /// One more scroll to the end once the first layout has settled, unless
    /// the reader has already scrolled away.
    private func settleOnEnd(_ proxy: ScrollViewProxy) async {
        try? await Task.sleep(for: .milliseconds(50))
        guard !Task.isCancelled, !readerScrolled, !rows.isEmpty else { return }
        proxy.scrollTo(Self.transcriptEndId, anchor: .bottom)
    }

    private func revealFocusedMessage(_ proxy: ScrollViewProxy, in transcript: [TranscriptRow]) {
        guard let messageId = session.focusedMessageId,
              messages.contains(where: { $0.id == messageId })
        else { return }
        revealedMessageId = messageId
        // Materialize the lazy folded row first. Its target bubble
        // scrolls itself into view once expansion has laid it out.
        let folded = transcript.first { row in
            if case let .assistantTurn(turn) = row {
                return turn.messages.contains { $0.id == messageId }
            }
            return false
        }
        proxy.scrollTo(folded?.id ?? messageId, anchor: .center)
        session.consumeFocus(messageId)
    }

    // MARK: - Thread lifecycle

    /// Opening a chat: remember it, load it, and mark it read.
    private func enterThread() async {
        if selectedThreadWasRemoved { dismiss(); return }
        let openedChat = current
        session.threadSelection.rememberThread(openedChat, connectionID: session.connection?.id)
        await session.loadThreadIfNeeded(openedChat.threadId)
        // opening a chat is what marks it read, exactly as on the desktop
        if openedChat.unread { await session.markRead(openedChat) }
#if DEBUG
        // `-open-plus`: the + sheet up, for the screenshot harness
        if ProcessInfo.processInfo.arguments.contains("-open-plus") { showingPlus = true }
        // Profile parity screenshots without automating a tap through the
        // animated island/header transition.
        if ProcessInfo.processInfo.arguments.contains("-open-profile") { showingProfile = true }
        // `-chat-typing-preview`: the turn starts a beat after the chat
        // opens, so the typing bubble arrives with no new message to follow.
        if ProcessInfo.processInfo.arguments.contains("-chat-typing-preview"), !openedChat.busy {
            try? await Task.sleep(for: .milliseconds(1500))
            if !Task.isCancelled { session.setPreviewTurn(busy: true, threadId: openedChat.threadId) }
        }
#endif
    }

    private func reloadIfPageDropped(_ loaded: Bool) {
        let requestedThread = threadId
        if !loaded { Task { await session.loadThreadIfNeeded(requestedThread) } }
    }

    /// A message can arrive while this chat is already on screen. The
    /// opening task will not run again, so clear that new unread bit here
    /// rather than leaving a badge on an open conversation.
    private func markReadIfNeeded(_ unread: Bool) {
        let readChat = current
        if unread { Task { await session.markRead(readChat) } }
    }

    /// The local task picker changed threads: park this one's draft, bring
    /// back the next one's, and drop what belonged to the old thread.
    private func switchThread(from previous: String, to next: String) {
        dictation.stop()
        threadDrafts[previous] = ComposerSnapshot(text: draft, attachments: attachments, error: attachmentError)
        let restored = threadDrafts.removeValue(forKey: next) ?? ComposerSnapshot()
        draft = restored.text
        attachments = restored.attachments
        attachmentError = restored.error
        selectedPhotos = []
        showCommandHUD = false
        showingPlus = false
        readerScrolled = false
        // The next thread opens on its newest message; the pill comes back
        // once its own end is measured below the screen.
        readerDetached = false
        showsJumpToLatest = false
        // A download started in the previous task must not open a sheet (or
        // surface its error) in the new one when the network reply arrives late.
        resetFilePreview()
        cancelThreadOpen()
    }

    private func expireSteering() async {
        guard steering else { return }
        try? await Task.sleep(for: .seconds(20))
        if !Task.isCancelled { steering = false }
    }

    private func stopDictation(ifInterruptedBy note: Notification) {
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
        let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt)
        if value == AVAudioSession.InterruptionType.began.rawValue {
            dictation.stop()
        }
    }

    @ViewBuilder private var busyFleetFixtureBadge: some View {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-busy-fleet-preview") {
            VStack(alignment: .trailing, spacing: 0) {
                Text("Offline busy-fleet fixture")
                    .font(.caption2)
                    .accessibilityIdentifier("busy-fleet-progress")
                    .accessibilityValue(session.state.cursor ?? "0")
                // Message rows drawn so far: ResponsivenessUITests checks
                // that typing and other threads' tokens add none.
                Text(verbatim: "rows \(TranscriptRedrawProbe.rows)")
                    .font(.caption2)
                    .accessibilityIdentifier("transcript-row-redraws")
                    .accessibilityValue(String(TranscriptRedrawProbe.rows))
            }
            .allowsHitTesting(false)
        }
#endif
    }

    // MARK: - Live call

    /// Dictation lets go of the microphone first: the call takes it.
    private func startLiveCall(_ bot: Bot) {
        dictation.stop()
        liveCall.start(bot: bot)
    }

    /// This phone's call on this chat, a call here from another device, or
    /// a banner back to this phone's call on some other chat. The bar and
    /// the controller live in LiveCallBar.swift / LiveCallController.swift;
    /// this is only the slot.
    ///
    /// The banner shows in every chat, rooms included: a call is going on
    /// whichever chat is open. Its tap switches thread when the call is on
    /// this bot, and otherwise goes back to the roster, whose own banner
    /// opens the call's chat. The bars are for bot chats only, as calls are.
    @ViewBuilder private var liveCallBars: some View {
        if case let .bot(bot) = current, liveCall.concerns(threadId: threadId) {
            LiveCallBar(botName: bot.name)
        } else if liveCall.machine.isActive {
            LiveCallBanner { target in
                if case let .bot(bot) = current, target.botId == bot.id {
                    selectedThreadId = target.threadId
                } else {
                    dismiss()
                }
            }
        } else if case let .bot(bot) = current,
                  let remote = liveCall.machine.remoteCall(session.state.liveCall, onThread: threadId) {
            RemoteLiveCallBar(call: remote, botName: bot.name)
        }
    }

    /// The phone icon starts a Live call. Hidden while this phone is on one,
    /// while this chat's bar says why its call stopped, and while another
    /// device holds the line. A call that stopped on some other chat does
    /// not hide it: that notice is only visible there.
    private var canStartLiveCall: Bool {
        liveCall.machine.allowsStart(onThread: threadId) && session.state.liveCall?.isRunning != true
    }

    // MARK: - Header

    /// Back on the left with the rest-of-app unread count, then the Live
    /// call button; threads and the bot's computer on the right — a blurred
    /// strip to the top edge.
    private var headerBar: some View {
        HStack(alignment: .top) {
            Button { dismiss() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                    if unreadElsewhere > 0 {
                        Text("\(unreadElsewhere)")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 22)
                            .background(Capsule().fill(Color.secondary.opacity(0.22)))
                    }
                }
                .foregroundStyle(Color.primary)
                .padding(.leading, 12)
                .padding(.trailing, unreadElsewhere > 0 ? 8 : 12)
                // At least as wide as it is tall: a circle alone, a pill
                // once the unread count joins it.
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel("Back")

            // Beside Back rather than the computer: the bot's face sits in
            // the middle of this strip, and one more round button on the
            // right pushes the Threads pill under it. Here, hiding it during
            // a call moves nothing else.
            if case let .bot(bot) = current, canStartLiveCall {
                GlassButton(systemImage: "phone", size: 44, weight: .medium) {
                    Haptics.selection()
                    if LiveCallDisclosure().isDue {
                        disclosingLiveCall = bot
                    } else {
                        startLiveCall(bot)
                    }
                }
                .accessibilityLabel("Start a Live call with \(current.name)")
                .accessibilityIdentifier("live-call-start")
            }

            Spacer(minLength: 4)

            HStack(spacing: 8) {
                if current.supportsTasks {
                    Button {
                        showingTasks = true
                    } label: {
                        Label("Threads", systemImage: "square.stack")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.primary)
                            .padding(.horizontal, 12)
                            .frame(height: 44)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .glassCapsule()
                    .accessibilityIdentifier("header-threads")
                }
                if case .bot = current {
                    GlassButton(systemImage: "display", size: 44, weight: .medium) {
                        showingComputer = true
                    }
                    .accessibilityLabel("Watch \(current.name)'s computer")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .frame(maxWidth: CompanionLayout.headerWidth)
        .frame(maxWidth: .infinity)
        .background(
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: 20)
                    }
                )
                .padding(.bottom, -20)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        )
    }

    /// The bot's face over its name pill, floating over the transcript
    /// between the two buttons.
    private var headerFace: some View {
        VStack(spacing: 6) {
            // Always here, following the island's face while that one is
            // the source: when the island lets go, this one flies home.
            // The face itself is drawn by the island layer above so there is
            // still only one animated avatar. This transparent seat becomes
            // its independent profile button once the opening transition has
            // settled.
            if case .bot = current {
                Button { showingProfile = true } label: {
                    Color.clear
                        .frame(width: 60, height: 60)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .allowsHitTesting(!islandVisible)
                .accessibilityHidden(islandVisible)
                .accessibilityLabel("Open \(current.name) settings")
                .accessibilityHint("Changes this bot's model, profile, notifications, and voice")
            } else {
                Color.clear.frame(width: 60, height: 60)
            }
            Button {
                if current.supportsTasks { showingTasks = true }
                else { showingPlus = true }
            } label: {
                HStack(spacing: 6) {
                    Text(current.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if current.supportsTasks || !current.subtitle.isEmpty {
                        Text(current.supportsTasks ? current.threadTitle : current.subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: current.supportsTasks ? "chevron.down" : "ellipsis")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.leading, 12)
                .padding(.trailing, 10)
                .frame(height: 32)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel(current.supportsTasks ? "Switch thread: \(current.threadTitle)" : "Open \(current.name) thread options")
            .accessibilityHint("Choose a conversation or start a new thread")
            .accessibilityIdentifier("thread-switcher")
        }
        .padding(.top, -4)
    }

    // MARK: - The + sheet

    /// What the composer's + opens: a glass sheet of the things you can do
    /// here, each with a line saying what it does. Rises above the composer;
    /// tapping anywhere else, or the × the + became, puts it away.
    @ViewBuilder
    private var plusSheet: some View {
        if showingPlus {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.snappy(duration: 0.28)) { showingPlus = false } }

                VStack(spacing: 0) {
                    ForEach(plusActions) { action in
                        Button {
                            withAnimation(.snappy(duration: 0.28)) { showingPlus = false }
                            action.run()
                        } label: {
                            HStack(spacing: 16) {
                                Image(systemName: action.systemImage)
                                    .font(.system(size: 20, weight: .medium))
                                    .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    .frame(width: 44, height: 44)
                                    .background(Circle().fill(Color.primary.opacity(0.10)))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(action.title)
                                        .font(.system(size: 19, weight: .medium))
                                        .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                    Text(action.subtitle)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Color.secondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 18)
                            .frame(height: 64)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(action.disabled)
                        .opacity(action.disabled ? 0.45 : 1)
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: CompanionLayout.chatWidth, alignment: .leading)
                .glassSheet(cornerRadius: 30)
                .padding(.horizontal, 12)
                .padding(.bottom, 70)
                .frame(maxWidth: .infinity)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .transition(.opacity)
        }
    }

    private struct PlusAction: Identifiable {
        let id: String
        let systemImage: String
        let title: LocalizedStringKey
        let subtitle: LocalizedStringKey
        var destructive = false
        var disabled = false
        let run: () -> Void
    }

    private var plusActions: [PlusAction] {
        let canAddAttachment = attachments.count < AttachmentPolicy.maximumItems
            && !preparingAttachments && !sendingMessage
        var out: [PlusAction] = [
            PlusAction(
                id: "photos", systemImage: "photo.on.rectangle", title: "Photo Library",
                subtitle: "Add a photo to this message", disabled: !canAddAttachment
            ) { showingPhotoPicker = true },
            PlusAction(
                id: "files", systemImage: "paperclip", title: "Choose File",
                subtitle: "Add a document from Files", disabled: !canAddAttachment
            ) { showingFileImporter = true },
        ]
        if case let .bot(bot) = current {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New thread",
                subtitle: "Start a fresh thread with \(bot.name)"
            ) { Task {
                if let created = await session.createTask(for: bot, title: nil) {
                    selectedThreadId = created.threadId
                }
            } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Threads",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(PlusAction(
                id: "settings", systemImage: "gearshape", title: "Bot settings",
                subtitle: "Model, profile, voice and notifications"
            ) { showingProfile = true })
            out.append(PlusAction(
                id: "computer", systemImage: "display", title: "Watch computer",
                subtitle: "Live view of what \(bot.name) is doing"
            ) { showingComputer = true })
        }
        if case let .room(room) = current, room.dm != true {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New thread",
                subtitle: "Start a fresh conversation in \(room.name)",
                disabled: current.busy || hasPendingApproval
            ) { Task { await session.createTask(for: room, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Threads",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
        }
        out.append(PlusAction(
            id: "share", systemImage: "doc.plaintext", title: "Share transcript",
            subtitle: "This thread as Markdown"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "markdown") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        out.append(PlusAction(
            id: "share-json", systemImage: "curlybraces", title: "Share as JSON",
            subtitle: "Structured transcript data"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "json") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        if current.busy, case let .bot(bot) = current {
            out.append(PlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) { Task { await session.interrupt(bot: bot) } })
        }
        return out
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in rows: [TranscriptRow]) -> Bool {
        guard index > 0 else { return true }
        return rows[index].at - rows[index - 1].endAt > 30 * 60 * 1000
    }

    /// True when the next message is from someone else (or there is none),
    /// which is where a run of bubbles gets its tail — one per run, like
    /// every messaging app, rather than one per bubble.
    private func endsRun(at index: Int, in rows: [TranscriptRow]) -> Bool {
        guard index + 1 < rows.count else { return true }
        let this = rows[index], next = rows[index + 1]
        if this.role != next.role { return true }
        if this.senderName != next.senderName { return true }
        // a card or a tool chip between two texts breaks the run visually
        return next.kind != .text
    }

    private func canSend(_ typed: String) -> Bool {
        (!typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !preparingAttachments && !sendingMessage
    }

    /// Messages the harness is holding for this thread. They sit above the
    /// composer rather than pretending to be part of the transcript: the
    /// turn that is still running owns the transcript's tail, and these
    /// words have not been said yet.
    private var heldSends: [QueuedSend] {
        session.state.pendingQueued[threadId] ?? []
    }

    private var hasPendingApproval: Bool {
        messages.contains { $0.card?.isPending == true }
    }

    /// Who the @ being typed can tag, filtered by what follows it. Empty
    /// while no tag is being typed, which is what keeps the picker closed.
    private func mentionChoices(_ typed: String) -> [MentionChoice] {
        ComposerMention.choices(for: typed, pool: ComposerMention.pool(for: current, bots: session.state.bots))
    }

    private var engineCanSteer: Bool {
        guard case let .bot(bot) = current else { return false }
        return attachments.isEmpty && session.steeringInstanceIds.contains(bot.modelSelection.instanceId)
    }

    private var composerPrompt: String {
        if sendingMessage { return "Sending…" }
        if dictation.isListening { return "Listening…" }
        if current.busy { return engineCanSteer ? "Sends into this turn" : "Sends after this turn" }
        return "Ask \(current.name)"
    }

    private func steerQueued(pendingApproval: Bool) -> (() -> Void)? {
        guard current.busy, !pendingApproval, case let .bot(bot) = current else { return nil }
        return {
            steering = true
            dictation.stop()
            Haptics.impact(.medium)
            Task { await session.interrupt(bot: bot) }
        }
    }

    private func submit(_ explicitText: String? = nil) {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let draftAtSend = draft
        let text = (explicitText ?? draftAtSend).trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingAttachments = attachments
        let chatAtSend = current
        guard !text.isEmpty || !outgoingAttachments.isEmpty,
              !preparingAttachments,
              !sendingMessage
        else { return }
        sendingMessage = true
        attachmentError = nil
        showCommandHUD = false
        showingPlus = false
        // Sending is the one time the transcript goes to its end even when
        // the reader had scrolled back: the message lands there.
        readerDetached = false
        sendJumps &+= 1
        Task {
            let sent = await session.send(
                text: text,
                attachments: outgoingAttachments,
                to: chatAtSend
            )
            sendingMessage = false
            guard sent else {
                let failure = session.actionError ?? "Couldn't send this message. Try again."
                if threadId == chatAtSend.threadId { attachmentError = failure }
                else { threadDrafts[chatAtSend.threadId]?.error = failure }
                session.actionError = nil
                return
            }
            if threadId != chatAtSend.threadId {
                if threadDrafts[chatAtSend.threadId]?.text == draftAtSend { threadDrafts[chatAtSend.threadId]?.text = "" }
                if threadDrafts[chatAtSend.threadId]?.attachments.map(\.id) == outgoingAttachments.map(\.id) {
                    threadDrafts[chatAtSend.threadId]?.attachments = []
                }
                return
            }
            // HUD commands expand `/diff` into a longer prompt. Compare with
            // what was actually in the field at tap time, not the expanded
            // text, so the command clears without erasing a newer edit.
            if draft == draftAtSend {
                draft = ""
            }
            if attachments.map(\.id) == outgoingAttachments.map(\.id) {
                attachments = []
            }
            SoundEffects.playSent()
            Haptics.impact(.medium)
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        guard !preparingAttachments, !sendingMessage else { return }
        let importingThread = threadId
        let existingAttachments = attachments
        let available = AttachmentPolicy.maximumItems - existingAttachments.count
        guard items.count <= available else {
            selectedPhotos = []
            attachmentError = "Send up to \(AttachmentPolicy.maximumItems) items at a time."
            return
        }

        preparingAttachments = true
        attachmentError = nil
        defer {
            preparingAttachments = false
            selectedPhotos = []
        }

        do {
            var imported: [PendingMessageAttachment] = []
            for (index, item) in items.enumerated() {
                guard let raw = try await item.loadTransferable(type: Data.self) else {
                    throw AttachmentImportError.unreadable("that photo")
                }
                let actualType = CGImageSourceCreateWithData(raw as CFData, nil)
                    .flatMap(CGImageSourceGetType)
                    .flatMap { UTType($0 as String) }
                let actualMime = actualType?.preferredMIMEType
                    .map(AttachmentPolicy.normalizedMIME)

                let data: Data
                let mime: String
                let fileExtension: String
                if let actualMime, AttachmentPolicy.imageMIMETypes.contains(actualMime) {
                    data = raw
                    mime = actualMime
                    fileExtension = actualType?.preferredFilenameExtension ?? "jpg"
                } else if let image = UIImage(data: raw),
                          let jpeg = image.jpegData(compressionQuality: 0.9) {
                    data = jpeg
                    mime = "image/jpeg"
                    fileExtension = "jpg"
                } else {
                    throw AttachmentImportError.unsupported("that photo")
                }

                let candidate = PendingMessageAttachment(
                    id: UUID(),
                    data: data,
                    name: items.count == 1 ? "Photo.\(fileExtension)" : "Photo \(index + 1).\(fileExtension)",
                    mime: mime,
                    kind: .image
                )
                try AttachmentPolicy.validate(existingAttachments + imported + [candidate])
                imported.append(candidate)
            }
            if threadId == importingThread { attachments.append(contentsOf: imported) }
            else { threadDrafts[importingThread, default: ComposerSnapshot()].attachments.append(contentsOf: imported) }
            Haptics.selection()
        } catch {
            if threadId == importingThread { attachmentError = error.localizedDescription }
            else { threadDrafts[importingThread]?.error = error.localizedDescription }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        guard case let .success(urls) = result else {
            if case let .failure(error) = result { attachmentError = error.localizedDescription }
            return
        }
        guard !urls.isEmpty else { return }
        Task { await importFiles(urls) }
    }

    private func importFiles(_ urls: [URL]) async {
        guard !preparingAttachments, !sendingMessage else { return }
        let importingThread = threadId
        let existingAttachments = attachments
        let available = AttachmentPolicy.maximumItems - existingAttachments.count
        guard urls.count <= available else {
            attachmentError = "Send up to \(AttachmentPolicy.maximumItems) items at a time."
            return
        }

        preparingAttachments = true
        attachmentError = nil
        defer { preparingAttachments = false }

        do {
            var imported: [PendingMessageAttachment] = []
            for url in urls {
                let usedBytes = (existingAttachments + imported).reduce(0) { $0 + $1.data.count }
                let remainingBytes = max(0, AttachmentPolicy.maximumTotalBytes - usedBytes)
                let candidate = try await Task.detached(priority: .userInitiated) {
                    try Self.readImportedFile(url, remainingBytes: remainingBytes)
                }.value
                try AttachmentPolicy.validate(existingAttachments + imported + [candidate])
                imported.append(candidate)
            }
            if threadId == importingThread { attachments.append(contentsOf: imported) }
            else { threadDrafts[importingThread, default: ComposerSnapshot()].attachments.append(contentsOf: imported) }
            Haptics.selection()
        } catch {
            if threadId == importingThread { attachmentError = error.localizedDescription }
            else { threadDrafts[importingThread]?.error = error.localizedDescription }
        }
    }

    nonisolated private static func readImportedFile(
        _ url: URL,
        remainingBytes: Int
    ) throws -> PendingMessageAttachment {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let values = try url.resourceValues(
            forKeys: [.contentTypeKey, .isRegularFileKey, .fileSizeKey]
        )
        guard values.isRegularFile != false else {
            throw AttachmentImportError.unreadable(url.lastPathComponent)
        }
        let name = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw AttachmentImportError.unreadable("that file") }
        let inferred = values.contentType ?? UTType(filenameExtension: url.pathExtension)
        let mime = AttachmentPolicy.normalizedMIME(
            inferred?.preferredMIMEType ?? "application/octet-stream"
        )
        guard let kind = AttachmentPolicy.kind(forMIME: mime) else {
            throw AttachmentImportError.unsupported(name)
        }
        let itemLimit = kind == .image
            ? AttachmentPolicy.maximumImageBytes
            : AttachmentPolicy.maximumFileBytes
        let readLimit = min(itemLimit, remainingBytes)
        if let fileSize = values.fileSize, fileSize > readLimit {
            throw AttachmentImportError.tooLarge(name, readLimit)
        }
        // Some document providers do not report a size. Never let that turn
        // into an unbounded read of a provider-controlled file: read one byte
        // past the remaining allowance and reject it before it can become a
        // large in-memory draft.
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: readLimit + 1) ?? Data()
        guard data.count <= readLimit else {
            throw AttachmentImportError.tooLarge(name, readLimit)
        }
        return PendingMessageAttachment(
            id: UUID(), data: data, name: name, mime: mime, kind: kind
        )
    }

    /// A chip that opened a thread on this bot switches this screen in
    /// place; one that opened a thread on a teammate pushes that chat.
    private func openThread(_ ref: ThreadRef) {
        cancelThreadOpen()
        let shownBotId: String? = current.isBot ? current.id : nil
        threadOpenTask = Task {
            let openedThreadId = await session.openThread(ref, shownBotId: shownBotId)
            guard !Task.isCancelled else { return }
            threadOpenTask = nil
            if let openedThreadId { selectedThreadId = openedThreadId }
        }
    }

    private func cancelThreadOpen() {
        threadOpenTask?.cancel()
        threadOpenTask = nil
    }

    /// A link in a message to a file on the computer: download it into a
    /// preview. (Which links are files is `TranscriptActions.openLink`.)
    private func openFile(path: String, messageId: String) {
        fileDownloadTask?.cancel()
        let requestID = UUID()
        fileDownloadRequestID = requestID
        let requestedThreadID = threadId
        fileOpenError = nil
        let name = URL(fileURLWithPath: path).lastPathComponent
        openingFileName = name.isEmpty ? "file" : name
        let task = Task {
            let downloaded = await session.downloadFile(
                threadId: requestedThreadID,
                messageId: messageId,
                path: path
            )
            if let downloaded, let preview = FilePreviewItem(downloaded: downloaded) {
                // Own the temporary file before checking cancellation so an
                // old link tap cannot strand it between Session and the sheet.
                guard !Task.isCancelled, fileDownloadRequestID == requestID else {
                    preview.cleanUp()
                    return
                }
                openingFileName = nil
                filePreview?.cleanUp()
                filePreview = preview
                fileDownloadRequestID = nil
                fileDownloadTask = nil
                return
            }
            guard !Task.isCancelled, fileDownloadRequestID == requestID else { return }
            openingFileName = nil
            fileDownloadRequestID = nil
            fileDownloadTask = nil
            guard downloaded != nil else {
                fileOpenError = session.actionError ?? "Couldn't open that file. Try again."
                session.actionError = nil
                return
            }
            fileOpenError = "The downloaded file couldn't be previewed."
        }
        fileDownloadTask = task
    }

    /// End the preview lifecycle owned by the task that just left the screen.
    private func resetFilePreview() {
        fileDownloadTask?.cancel()
        fileDownloadTask = nil
        fileDownloadRequestID = nil
        openingFileName = nil
        fileOpenError = nil
        filePreview?.cleanUp()
        filePreview = nil
    }

    // MARK: - Composer

    /// Pull a held send back into the composer to tweak or extend it. The
    /// computer drops it from the queue first; only a confirmed removal hands
    /// the words back, so a send that already joined the turn is never resent.
    private func editQueued(_ send: QueuedSend) {
        let targetThread = threadId
        let chat = current
        Task {
            guard await session.cancelQueued(send, threadId: targetThread, in: chat) else { return }
            if threadId == targetThread {
                draft = send.editDraft(keeping: draft)
                composerFocused = true
            } else {
                // The person switched tasks while the cancel was in flight.
                var snapshot = threadDrafts[targetThread] ?? ComposerSnapshot()
                snapshot.text = send.editDraft(keeping: snapshot.text)
                threadDrafts[targetThread] = snapshot
            }
        }
    }

    /// A round + and a glass pill with dictation and send inside it.
    ///
    /// Drawn inside `DraftReader`, the one view that observes the draft: a
    /// keystroke redraws the composer, not this screen and its transcript.
    private func composer(_ snapshot: TranscriptSnapshot) -> some View {
        DraftReader(draft: composerDraft) { text in
            composerStack(text, snapshot: snapshot)
        }
    }

    private func composerStack(_ text: Binding<String>, snapshot: TranscriptSnapshot) -> some View {
        let typed = text.wrappedValue
        return VStack(spacing: 6) {
            let mentions = composerFocused && !showCommandHUD && !dictation.isListening ? mentionChoices(typed) : []
            if !mentions.isEmpty {
                MentionPicker(choices: mentions, bots: session.state.bots) { choice in
                    Haptics.selection()
                    if let completed = ComposerMention.complete(draft, with: choice) { draft = completed }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let line = liveStatusLine(snapshot)?.trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty {
                LiveStatusLine(text: line, step: snapshot.live.latest)
                    .transition(.opacity)
            }
            if !heldSends.isEmpty {
                QueuedSendList(
                    sends: heldSends, steer: steerQueued(pendingApproval: snapshot.hasPendingApproval),
                    steering: steering, edit: editQueued
                ) { send in
                    Task { await session.cancelQueued(send, threadId: threadId, in: current) }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            composerNotices

            composerSuggestions(text, pendingApproval: snapshot.hasPendingApproval)

            if !attachments.isEmpty {
                attachmentStrip
            }

            composerBar(text)
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .frame(maxWidth: CompanionLayout.chatWidth)
        .frame(maxWidth: .infinity)
    }

    /// Progress and errors above the field: preparing or sending, a file
    /// opening, a failed send or attachment, a dictation failure.
    @ViewBuilder private var composerNotices: some View {
        if preparingAttachments || sendingMessage {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(preparingAttachments ? "Preparing attachments…" : "Sending…")
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        }

        if let openingFileName {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Opening \(openingFileName)…")
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(Color.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        }

        if let error = fileOpenError ?? attachmentError {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.orange)
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button("Dismiss") {
                    fileOpenError = nil
                    attachmentError = nil
                }
                .font(.system(size: 13, weight: .semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
        }

        if let error = dictation.error {
            Text(error)
                .font(.system(size: 13))
                .foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
        }
    }

    /// The slash-command HUD while one is being typed, else the Settings
    /// chips while there is nothing to say yet.
    @ViewBuilder
    private func composerSuggestions(_ text: Binding<String>, pendingApproval: Bool) -> some View {
        if showCommandHUD {
            CommandSkillHUDView(
                text: text,
                isVisible: $showCommandHUD,
                commands: current.isBot
                    ? CommandSkillHUDView.defaultCommands
                    : CommandSkillHUDView.defaultCommands.filter {
                        $0.id != "computer" && (current.supportsTasks || $0.id != "tasks")
                    },
                accentColor: MausPalette.color(current.color)
            ) { command in
                switch command.id {
                case "computer":
                    draft = ""
                    showingComputer = true
                case "tasks":
                    draft = ""
                    showingTasks = true
                default: submit(command.command)
                }
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if text.wrappedValue.isEmpty && attachments.isEmpty && !current.busy
                    && !pendingApproval && !storedChips.isEmpty {
            PredictiveActionChipsView(chips: storedChips, accentColor: MausPalette.color(current.color)) { chip in
                submit(chip.prompt)
            }
            .transition(.opacity)
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    PendingAttachmentChip(attachment: attachment) {
                        guard !preparingAttachments, !sendingMessage else { return }
                        attachments.removeAll { $0.id == attachment.id }
                        attachmentError = nil
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabledCompat()
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func composerBar(_ text: Binding<String>) -> some View {
        GlassGroup(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                plusButton

                HStack(alignment: .bottom, spacing: 6) {
                    commandButton
                    composerField(text)

                    // Stop sits in the bar while the turn runs, as it does
                    // on the desktop. The Interrupt action under + was the
                    // only way before, and rooms had none at all.
                    if current.canStop {
                        stopButton
                    }

                    dictationButton
                    sendButton(canSend: canSend(text.wrappedValue))
                }
                .frame(minHeight: 44)
                // A capsule at one line (44pt tall, 22pt corners) that
                // keeps those 22pt corners as the draft grows, the way
                // Messages does. A true Capsule would round to half the
                // height, and a five-line draft became a giant pill.
                .glassSheet(cornerRadius: 22)
            }
        }
    }

    private var plusButton: some View {
        Button {
            dictation.stop()
            composerFocused = false
            withAnimation(.snappy(duration: 0.28)) { showingPlus.toggle() }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(showingPlus ? Color(uiColor: .systemBackground) : Color.primary)
                .rotationEffect(.degrees(showingPlus ? 45 : 0))
                .frame(width: 44, height: 44)
                .background(Circle().fill(showingPlus ? Color.primary : Color.clear))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .disabled(preparingAttachments || sendingMessage)
        .accessibilityLabel(showingPlus ? "Close" : "More")
    }

    private var commandButton: some View {
        Button {
            dictation.stop()
            withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) {
                showCommandHUD.toggle()
            }
            Haptics.selection()
        } label: {
            Image(systemName: "command")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(showCommandHUD ? Color.primary : Color.secondary)
                .frame(width: 30, height: 32)
        }
        .buttonStyle(.plain)
        .disabled(preparingAttachments || sendingMessage)
        .accessibilityLabel("Slash commands")
        .padding(.leading, 6)
        .padding(.bottom, 6)
    }

    private func composerField(_ text: Binding<String>) -> some View {
        TextField(
            composerPrompt,
            text: text,
            axis: .vertical
        )
            .lineLimit(1...5)
            .font(.system(size: 17))
            .padding(.vertical, 11)
            .focused($composerFocused)
            .accessibilityIdentifier("message-input")
            // Partial transcripts rebuild from a frozen base;
            // prevent competing edits without dimming the text.
            .allowsHitTesting(
                !dictation.isListening && !dictation.isStarting
                    && !preparingAttachments && !sendingMessage
            )
            .onValueChange(of: text.wrappedValue) { value in
                withAnimation(.easeInOut(duration: 0.15)) {
                    showCommandHUD = value.hasPrefix("/")
                }
            }
            // The software keyboard's Return inserts a newline,
            // like Messages; only the arrow button sends. A
            // hardware Return still sends, Shift-Return breaks
            // the line. onKeyPress never sees the software
            // keyboard, so this cannot turn its Return into a send.
            .onHardwareReturn { submit() }
    }

    private var stopButton: some View {
        Button {
            Haptics.selection()
            Task { await session.interrupt(current) }
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.primary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Color.secondary.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .padding(.bottom, 6)
        .accessibilityLabel("Stop the current turn")
        .accessibilityIdentifier("composer-stop")
        .transition(.scale.combined(with: .opacity))
    }

    private var dictationButton: some View {
        let listening = dictation.isListening
        let fill: Color = listening ? Color.red.opacity(0.2) : Color.secondary.opacity(0.12)
        return Button {
            composerFocused = false
            dictation.toggle(capturing: draft)
        } label: {
            Image(systemName: listening ? "mic.fill" : "mic")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(listening ? Color.red : Color.primary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(fill))
                .pulseCompat(isActive: listening)
        }
        .buttonStyle(.plain)
        .disabled(preparingAttachments || sendingMessage || liveCall.machine.isActive)
        .padding(.bottom, 6)
        .accessibilityLabel(listening ? "Stop dictation" : "Start dictation")
    }

    private func sendButton(canSend: Bool) -> some View {
        let fill: Color = canSend ? BubbleColor.mine : Color.secondary.opacity(0.18)
        return Button { submit() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(canSend ? Color.white : Color.secondary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(fill))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .padding(.trailing, 6)
        .padding(.bottom, 6)
        .animation(.easeOut(duration: 0.15), value: canSend)
        .accessibilityLabel(current.busy
            ? engineCanSteer ? "Send into the running turn" : "Queue this message for when the turn finishes"
            : "Send message")
    }
}

/// The composer's text, by reference. ChatView keeps it in `@State`, which
/// holds an object without observing it, so ChatView's actions can read and
/// set the draft while only `DraftReader` redraws when it changes.
@MainActor
final class ComposerDraft: ObservableObject {
    @Published var text = ""
}

/// Draws `content` from the composer's draft, and is the only view that
/// redraws on a keystroke. Before, the draft was ChatView's own state, so
/// every keystroke re-ran ChatView's body: the branch walk, the folded rows
/// and a fresh row for every message in the transcript.
private struct DraftReader<Content: View>: View {
    @ObservedObject var draft: ComposerDraft
    let content: (Binding<String>) -> Content

    init(draft: ComposerDraft, @ViewBuilder content: @escaping (Binding<String>) -> Content) {
        self.draft = draft
        self.content = content
    }

    var body: some View { content($draft.text) }
}

/// The Settings chip row, decoded once per edit of the setting rather than
/// twice on every render of the composer.
@MainActor
private enum StoredChips {
    private static var memo: (raw: String, chips: [ActionChipItem])?

    static func chips(_ raw: String) -> [ActionChipItem] {
        if let memo, memo.raw == raw { return memo.chips }
        let chips = QuickReply.decode(raw).map {
            ActionChipItem(id: $0.id, title: $0.title, icon: $0.icon, prompt: $0.prompt)
        }
        memo = (raw, chips)
        return chips
    }
}

/// Where the transcript's end sits against the bottom of the screen, as of
/// the last scrolled frame. A reference held in `@State`: it changes on
/// every frame of a scroll, and nothing needs to redraw when it does.
private final class ScrollReading {
    var endGap: CGFloat = 0
}

/// Keeps the newest message in view while the reader is at the end, and
/// leaves them where they are once they have scrolled back to read.
///
/// Before, every new row (animated) and every batch of a streaming reply
/// scrolled to the bottom unconditionally, so a reader scrolled up to
/// re-read something was pulled back down twenty times a second.
private struct FollowsLatest: ViewModifier {
    let proxy: ScrollViewProxy
    let lastRowId: String?
    let streamLength: Int
    /// The reader was at the end as of the last layout, so before this
    /// update's rows were laid out.
    let follows: Bool
    /// The typing bubble is showing (`ChatView.showsTyping`).
    let typing: Bool
    let sendJumps: Int
    let reduceMotion: Bool
    /// The opening scroll has happened. Per thread: the transcript's scroll
    /// view, and so this, is rebuilt when the thread changes.
    @State private var landed = false

    func body(content: Content) -> some View {
        content
            // `initial: true` is what opens the chat on the newest
            // message where `scrollAnchorCompat` cannot (iOS 16). On 17 the
            // anchor has already put us there and this is a no-op. After
            // that, a new row is followed only from the end.
            // The end, not the last message: the typing bubble sits under
            // the message that started it, and landing on the message left
            // the bubble below the composer, where nobody saw it.
            .onValueChange(of: lastRowId, initial: true) { last in
                guard last != nil, follows || !landed else { return }
                landed = true
                withAnimation { proxy.scrollTo(ChatView.transcriptEndId, anchor: .bottom) }
            }
            // The bubble also comes and goes with no new message to follow:
            // the turn is accepted a frame after your message lands, a tool
            // step starts after a reply. Bring it into view then, unless you
            // are up in the scrollback reading.
            .onValueChange(of: typing) { shown in
                guard shown, follows else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo(ChatView.transcriptEndId, anchor: .bottom)
                }
            }
            // Follow the text as it arrives. Keyed on length rather than
            // the string so this fires once per delta batch, and without
            // animation — animating every token turns a smooth stream
            // into a stutter, because each scroll interrupts the last.
            .onValueChange(of: streamLength) { length in
                guard length > 0, follows else { return }
                proxy.scrollTo(ChatView.liveBubbleId, anchor: .bottom)
            }
            .onValueChange(of: sendJumps) { _ in
                proxy.scrollTo(ChatView.transcriptEndId, anchor: .bottom)
            }
    }
}

/// One message: its bubble or card, and what hangs off it (call label,
/// reactions, version switcher, the long-press menu).
///
/// Drawn from plain values and compared by them. It reads nothing from the
/// session while drawing (the per-row lookups are done by ChatView, once
/// per render, and passed in), and it asks for things through `actions`.
struct MessageRow: View, Equatable {
    let message: Message
    var versions: [Message] = []
    /// Last bubble of a run from the same side: the one that gets the tail.
    var endsRun = true
    /// The stand-in for an edit the computer has not answered yet. It has no
    /// server identity, so nothing may react to it or edit it again.
    var isPendingEdit = false
    /// Where a routine card's Open run goes: the same route an "Opened
    /// thread" chip takes, so the run lands on screen without joining the
    /// thread list. Nil (the run was deleted, or the phone holds no bot
    /// owning it) means no button.
    var routineRun: ThreadRef? = nil
    let context: TranscriptRowContext
    let actions: TranscriptActions
    @State private var editingText = ""
    @State private var showingEdit = false
    /// The text being selected, and the sheet's presentation in one value.
    @State private var selecting: SelectableText?
    /// A digest chip's parts, and its sheet's presentation.
    @State private var digest: DigestSummary?

    private static let reactionChoices = ["👍", "❤️", "😂", "🎉", "👀"]

    /// Everything the row draws, its own state aside.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.message == rhs.message && lhs.versions == rhs.versions && lhs.endsRun == rhs.endsRun
            && lhs.isPendingEdit == rhs.isPendingEdit && lhs.routineRun == rhs.routineRun
            && lhs.context == rhs.context && lhs.actions == rhs.actions
    }

    var body: some View {
#if DEBUG
        let _ = TranscriptRedrawProbe.noteRow()
#endif
        // Transport tags contain paths on the paired computer. They belong
        // in attachment cards, never on the clipboard or in the
        // text-selection UI. Parsed once per message: MessagePresentation.
        let presentation = MessagePresentations.of(message)
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            content(presentation)

            if message.isViaCall {
                // spoken on a Live call and transcribed; the label says why
                // the wording may read a little off
                Label("via call", systemImage: "phone")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
                    .accessibilityIdentifier("via-call-\(message.id)")
            }

            if let comm = message.comm {
                // the chip already says what happened ("Posted in Standup");
                // a linked chip is not always a message sent to someone
                Label(message.tool?.name ?? "Messaged \(comm.withName)", systemImage: "arrow.up.right.bubble")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }

            if let reactions = message.reactions, !reactions.isEmpty {
                reactionButtons(reactions)
            }

            if versions.count > 1, let index = versions.firstIndex(where: { $0.id == message.id }), context.isBot {
                versionSwitcher(at: index)
            }
        }
        .contextMenu { menu(presentation) }
        .alert("Edit and retry", isPresented: $showingEdit) {
            TextField("Message", text: $editingText)
            Button("Cancel", role: .cancel) {}
            if context.isBot {
                Button("Send") {
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await actions.edit(message, text: text) }
                }
            }
        } message: {
            Text("This creates a new version and continues from there.")
        }
        .sheet(item: $selecting) { SelectableTextSheet(text: $0.text) }
        .sheet(item: $digest) { DigestSheet(summary: $0) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-\(message.id)")
    }

    private func reactionButtons(_ reactions: [Reaction]) -> some View {
        HStack(spacing: 6) {
            ForEach(reactionGroups(reactions), id: \.emoji) { group in
                Button("\(group.emoji) \(group.count)") {
                    Haptics.selection()
                    Task { await actions.react(to: message, emoji: group.emoji) }
                }
                .font(.system(size: 13))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(group.mine ? Color.accentColor : Color.secondary)
            }
        }
    }

    private func versionSwitcher(at index: Int) -> some View {
        HStack(spacing: 8) {
            Button {
                Task { await actions.switchVersion(to: versions[index - 1]) }
            } label: { Image(systemName: "chevron.left") }
            .disabled(index == 0 || context.busy)
            Text("\(index + 1) of \(versions.count)")
            Button {
                Task { await actions.switchVersion(to: versions[index + 1]) }
            } label: { Image(systemName: "chevron.right") }
            .disabled(index + 1 >= versions.count || context.busy)
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Color.secondary)
    }

    @ViewBuilder
    private func menu(_ presentation: MessagePresentation) -> some View {
        if !isPendingEdit {
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) {
                    Haptics.selection()
                    Task { await actions.react(to: message, emoji: emoji) }
                }
            }
        }
        let visibleText = presentation.visibleText
        if !visibleText.isEmpty {
            Divider()
            Button("Copy", systemImage: "doc.on.doc") {
                PlatformBridge.copyToPasteboard(visibleText)
            }
        }
        // Copy above takes the whole reply. Selection happens in a sheet
        // because long-press on the bubble already opens this menu.
        if !visibleText.isEmpty {
            Button("Select Text", systemImage: "selection.pin.in.out") {
                selecting = SelectableText(text: visibleText)
            }
        }
        // An attachment edit cannot faithfully reconstruct the upload.
        // Hiding this action is safer than silently dropping the file or
        // sending its computer-local transport path back as prose.
        if message.role == .user,
           message.kind == .text,
           presentation.webhook == nil,
           presentation.attached.attachments.isEmpty,
           !isPendingEdit,
           context.isBot {
            Divider()
            Button("Edit and retry", systemImage: "pencil") {
                editingText = message.text ?? ""
                showingEdit = true
            }
            .disabled(context.busy || context.editPending)
        }
    }

    @ViewBuilder
    private func content(_ presentation: MessagePresentation) -> some View {
        switch message.kind {
        case .text:
            bubble(presentation)
        case .options:
            // A structured ask draws its own card: its answers are the
            // model's questions, not an allow/deny a tap could stand for.
            if message.card?.questions.isEmpty == false {
                QuestionCardView(message: message, context: context, actions: actions)
            } else {
                CardView(message: message, context: context, actions: actions)
            }
        case .secret:
            if let secret = message.secret {
                CredentialRequestCardView(message: message, secret: secret, context: context, actions: actions)
            } else if let text = message.text, !text.isEmpty {
                bubble(presentation)
            }
        case .activity:
            ActivityChip(
                tool: message.tool, threadRef: message.threadRef, openThread: actions.openThread,
                outputIsProse: message.isTeammateReport
            )
            // A turn that failed because Claude Code is too old for the
            // model: offer to run the updater for the engine this thread uses.
            if message.tool?.claudeUpdate == true, let instanceId = context.claudeInstanceId {
                ClaudeUpdateCard(instanceId: instanceId, tint: MausPalette.color(context.color), actions: actions)
            }
        case .compaction:
            ReceiptChip(icon: "square.3.layers.3d", label: message.compaction?.chipText ?? message.text ?? "") {
                selecting = SelectableText(text: message.compaction?.summary ?? message.text ?? "")
            }
        case .screen:
            ScreenShot(message: message, actions: actions)
        case .digest:
            // Not a bubble: a chip saying the turn did something, opening
            // onto what. `transcriptRows` already dropped the ones with
            // nothing to say, and all of them when activity is hidden.
            let summary = DigestSummary(text: message.text ?? "")
            if !summary.isEmpty {
                ReceiptChip(icon: "checklist", label: summary.chipLabel, hint: "Shows what this turn did") {
                    digest = summary
                }
            }
        case .routineRun:
            if let card = message.routineRun {
                RoutineRunCardView(
                    card: card,
                    at: message.date,
                    tint: MausPalette.color(context.color),
                    openRun: routineRun.map { ref in { actions.openThread(ref) } }
                )
            } else if let text = message.text, !text.isEmpty {
                // A computer that sent the kind without its card: the text
                // is written for exactly this reader.
                bubble(presentation)
            }
        case .unknown:
            // A message kind from a newer computer. Almost everything the
            // harness sends carries `text`, so showing it is usually the
            // whole message and always better than a gap in the transcript.
            // When there is nothing to show, show nothing — a placeholder
            // saying "unsupported" is a worse gap than the gap.
            if let text = message.text, !text.isEmpty {
                bubble(presentation)
            }
        }
    }

    private func bubble(_ presentation: MessagePresentation) -> TextBubble {
        TextBubble(message: message, presentation: presentation, context: context, tailed: endsRun, actions: actions)
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
    }
}

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// A message's text on its way to the selection sheet.
struct SelectableText: Identifiable {
    let id = UUID()
    let text: String
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct TextBubble: View {
    let message: Message
    /// What the text shows once its wrappers are off, worked out once per
    /// message by `MessageRow`.
    let presentation: MessagePresentation
    let context: TranscriptRowContext
    var tailed = true
    let actions: TranscriptActions

    var body: some View {
        let mine = message.role == .user
        let customCard = presentation.patch != nil
        // rooms attribute each line to the member who said it
        let speaker = message.from
        // No face beside the bubble: the bot's face is in the header, and in
        // a room the name line says who spoke. The bubble sits at the edge.
        HStack(alignment: .bottom, spacing: 0) {
            if mine { Spacer(minLength: 56) }

            VStack(alignment: .leading, spacing: 4) {
                if let speaker, !mine {
                    Text(speaker.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(MausPalette.color(speaker.color))
                }
                ForEach(message.voiceNotes) { note in
                    VoiceNoteBubble(note: note, tint: MausPalette.color(context.color), actions: actions)
                }
                ForEach(message.generatedImages, id: \.path) { attachment in
                    TranscriptAttachmentView(
                        attachment: attachment, messageId: message.id, actions: actions,
                        foreground: mine ? BubbleColor.mineText : .primary
                    )
                }
                // Documents, audio and video a bot sent with attach_file. The
                // card opens the full-screen viewer, which plays video.
                ForEach(message.attachedFiles, id: \.path) { attachment in
                    TranscriptAttachmentView(
                        attachment: attachment, messageId: message.id, actions: actions,
                        foreground: mine ? BubbleColor.mineText : .primary
                    )
                }
                words(mine: mine)
                if mine, message.steered == true {
                    Text("sent mid-turn")
                        .font(.system(size: 11))
                        .foregroundStyle(BubbleColor.mineText.opacity(0.72))
                }
            }
            .padding(.horizontal, customCard ? 0 : 15)
            .padding(.vertical, customCard ? 0 : 11)
            .background(
                Group {
                    if !customCard {
                        SpeechBubble(tail: tailed ? (mine ? .trailing : .leading) : .none)
                            .fill(mine ? BubbleColor.mine : BubbleColor.theirs)
                    }
                }
            )
            // leave room for the tail below, so the next row does not sit on it
            .padding(.bottom, !customCard && tailed ? SpeechBubble.tailDrop() : 0)

            if !mine { Spacer(minLength: 44) }
        }
    }

    /// Bots get markdown, you do not — the same split the desktop makes.
    /// Markdown you did not intend is worse than markdown you did: a
    /// message about `**` should show the asterisks.
    @ViewBuilder
    private func words(mine: Bool) -> some View {
        if let patch = presentation.patch {
            GitPRDiffCardView(filename: patch.filename, diffText: patch.diff)
        } else if let webhook = presentation.webhook {
            WebhookMessageBody(content: webhook)
        } else if mine {
            let shared = presentation.attached
            ForEach(Array(shared.attachments.enumerated()), id: \.offset) { _, attachment in
                TranscriptAttachmentView(attachment: attachment, messageId: message.id, actions: actions)
            }
            if !shared.text.isEmpty {
                Text(shared.text)
                    .font(.system(size: 17))
                    .foregroundStyle(BubbleColor.mineText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            MarkdownText(
                source: message.text ?? "",
                scrollIdentifier: "message-\(message.id)-scroll"
            ) { url in
                actions.openLink(url, messageId: message.id)
            }
                .foregroundStyle(Color.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A tool the bot ran. Deliberately quiet — these are the bulk of a busy
/// transcript and they are context, not content.
struct ActivityChip: View {
    let tool: ToolActivity?
    /// The thread this chip opened, when it opened one.
    var threadRef: ThreadRef? = nil
    var openThread: ((ThreadRef) -> Void)? = nil
    /// The output is a teammate's report, not a tool log.
    var outputIsProse = false

    var body: some View {
        if let tool {
            // Only a teammate's report expands. Ordinary tool chips also
            // carry raw output, and that log stays on the computer's side.
            let output = outputIsProse ? tool.expandableOutput : nil
            let receipt = SkillExecutionReceiptView(
                skillName: tool.label,
                status: tool.ok.map { $0 ? "success" : "error" } ?? "running",
                output: output ?? "",
                outputIsProse: outputIsProse
            )
            .padding(.leading, 2)

            if output != nil, let threadRef, let openThread {
                // The receipt's own button expands the report now, so the
                // thread gets a link of its own beneath it rather than
                // taking over the whole chip.
                VStack(alignment: .leading, spacing: 4) {
                    receipt
                    Button {
                        Haptics.selection()
                        openThread(threadRef)
                    } label: {
                        HStack(spacing: 4) {
                            Text("Open thread")
                            Image(systemName: "arrow.right")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 8)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open thread \(threadRef.title)")
                }
            } else if let threadRef, let openThread {
                // The receipt's own button has nothing to expand here, so the
                // whole chip is the link to the thread it names.
                Button {
                    Haptics.selection()
                    openThread(threadRef)
                } label: {
                    receipt.allowsHitTesting(false)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tool.label)
                .accessibilityHint("Opens the thread")
            } else {
                receipt
            }
        }
    }
}

/// A quiet capsule under a reply for the harness's receipts (the work
/// digest, a compaction record): one line, and the full text on tap.
struct ReceiptChip: View {
    let icon: String
    let label: String
    var hint = "Shows the full text"
    var open: (() -> Void)? = nil

    var body: some View {
        if !label.isEmpty {
            Button {
                Haptics.selection()
                open?()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .medium))
                    Text(label)
                        .font(.system(size: 12))
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().strokeBorder(.quaternary))
                .padding(.leading, 2)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityHint(hint)
        }
    }
}

/// A credential entered here is encrypted for the exact computer whose
/// public key was pinned by the pairing QR. Password AutoFill remains
/// provider-neutral: Apple Passwords works without another subscription,
/// while 1Password, Bitwarden and other enabled providers work as usual.
struct CredentialRequestCardView: View {
    let message: Message
    let secret: SecretRequestCardData
    /// The chat, and where this phone stands for secrets (`credentials`):
    /// values, so the card redraws when they change rather than whenever
    /// the session publishes.
    let context: TranscriptRowContext
    let actions: TranscriptActions
    @Environment(\.scenePhase) private var scenePhase
    @State private var value = ""
    @State private var fieldID = UUID()
    @State private var preparedSubmission: PreparedPhoneCredential?
    @State private var submissionTask: Task<Void, Never>?
    @State private var activeSubmissionID: UUID?
    @State private var submitting = false
    @State private var submitted = false
    @State private var submissionError: String?

    private struct RequestIdentity: Equatable {
        let connectionID: String?
        let botID: String?
        let threadID: String
        let messageID: String
        let target: String?
        let requestKey: String?
    }

    private var tint: Color { MausPalette.color(message.from?.color ?? context.color) }
    private var requester: String { message.from?.name ?? context.name }
    private var label: String { visible(secret.label) ?? "API credential" }
    private var accessibilityStatus: Text {
        if secret.provided == true {
            return secret.resumed == true
            ? Text("Saved securely. The task resumed.")
            : Text("Saved securely on your computer.")
        }
        if secret.dismissed == true { return Text("Not provided.") }
        if submitted { return Text("Encrypted and sent to your computer.") }
        if canEnterOnPhone { return Text("Enter it securely on this phone.") }
        if !hasSecurePairing { return Text("Pair again by QR code, or finish on your computer.") }
        return Text("Use secure phone access or Tailscale, or finish on your computer.")
    }

    private func visible(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private var helpURL: URL? {
        guard let raw = secret.helpUrl,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil
        else { return nil }
        return url
    }

    private var hasSecurePairing: Bool {
        guard secret.isPending,
              visible(secret.target) != nil,
              visible(secret.requestKey) != nil
        else { return false }
        return context.credentials.pairedForSecrets
    }

    private var hasProtectedTransport: Bool {
        context.credentials.transportProtected
    }

    private var canEnterOnPhone: Bool { hasSecurePairing && hasProtectedTransport }

    private var placeholder: String { visible(secret.placeholder) ?? label }

    private var canSubmit: Bool {
        guard canEnterOnPhone, !submitting, !submitted else { return false }
        return preparedSubmission != nil
            || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var requestIdentity: RequestIdentity {
        // A bot chat's own bot; in a room, the member who asked.
        let botID = context.isBot ? context.botId : message.from?.botId
        return RequestIdentity(
            connectionID: context.credentials.connectionId,
            botID: botID,
            threadID: context.threadId,
            messageID: message.id,
            target: secret.target,
            requestKey: secret.requestKey
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            heading

            if let description = visible(secret.description) {
                Text(description)
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            outcome

            if let submissionError = visible(submissionError) {
                Label(submissionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let error = visible(secret.error) {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let helpURL {
                Link(destination: helpURL) {
                    Label("Where to get this key", systemImage: "arrow.up.right")
                        .font(.system(size: 13, weight: .medium))
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.secondary.opacity(0.09))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(secret.isPending ? tint.opacity(0.65) : Color.clear, lineWidth: 1.25)
        }
        .accessibilityElement(children: canEnterOnPhone ? .contain : .combine)
        .accessibilityLabel("\(label). \(accessibilityStatus)")
        .onAppear {
            preparedSubmission = actions.preparedCredential(message: message, secret: secret)
        }
        .onValueChange(of: requestIdentity) { _ in resetForNewRequest() }
        .onValueChange(of: context.credentials.resetGeneration) { _ in
            suspendSensitiveEntry()
        }
        .onValueChange(of: context.credentials.status) { status in
            if status != .live { suspendSensitiveEntry() }
        }
        .onValueChange(of: scenePhase) { phase in
            // Password AutoFill and its Face ID sheet temporarily make the
            // scene inactive. Removing the SecureField at that point breaks
            // the very fill operation the user requested. A true background
            // transition (including locking the phone) still scrubs it.
            if phase == .background { suspendSensitiveEntry() }
        }
        .onDisappear {
            // The async request owns only ciphertext and is safe to finish.
            // Its envelope stays in Session so returning to this card can
            // retry the exact same operation after an ambiguous response.
            clearPlaintext()
            submissionError = nil
        }
    }

    private var heading: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "key.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 38, height: 38)
                .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.system(size: 16, weight: .semibold))
                Text("Requested by \(requester)")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    /// Where the request stands: answered, declined, waiting on this phone,
    /// or waiting on a connection this phone does not have.
    @ViewBuilder private var outcome: some View {
        if secret.provided == true {
            providedStatus
        } else if secret.dismissed == true {
            Label("Not provided", systemImage: "xmark.circle")
                .foregroundStyle(Color.secondary)
        } else if submitted {
            Label("Encrypted and saved on your computer", systemImage: "checkmark.shield.fill")
                .foregroundStyle(.green)
        } else if canEnterOnPhone {
            phoneEntry
        } else if !hasSecurePairing {
            pairAgainNotice
        } else {
            secureConnectionNotice
        }
    }

    private var providedStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                secret.resumed == true ? "Saved securely. The task resumed." : "Saved securely on your computer.",
                systemImage: "checkmark.shield.fill"
            )
            .foregroundStyle(.green)

            if secret.resumed != true, let preparedSubmission {
                Button(action: { send(preparedSubmission) }) {
                    HStack(spacing: 7) {
                        if submitting { ProgressView() }
                        Image(systemName: "arrow.clockwise")
                        Text(submitting ? "Resuming…" : "Try resuming the task")
                    }
                    .font(.system(size: 13, weight: .semibold))
                }
                .disabled(submitting || !hasProtectedTransport)
            }
        }
    }

    private var phoneEntry: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("Enter securely on this phone", systemImage: "lock.shield.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)

            if preparedSubmission == nil {
                secureField
            } else {
                preparedNotice
            }

            submitButton

            if preparedSubmission != nil, !submitting, submissionError != nil {
                Button("Enter a different value") {
                    discardPreparedSubmission()
                }
                .font(.system(size: 13, weight: .medium))
            }

            Text("Use Apple Passwords, 1Password, Bitwarden, or paste. The value is encrypted for your computer and never added to chat.")
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var secureField: some View {
        SecureField(placeholder, text: $value)
            .id(fieldID)
            .textContentType(.password)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .privacySensitive()
            .disabled(submitting)
            .submitLabel(.done)
            .onSubmit { submit() }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(
                Color.secondary.opacity(0.1),
                in: RoundedRectangle(cornerRadius: 11, style: .continuous)
            )
            .accessibilityLabel(label)
    }

    private var preparedNotice: some View {
        Label(
            submitting ? "Encrypted and saving…" : "Encrypted and ready to retry",
            systemImage: "lock.fill"
        )
        .font(.system(size: 13))
        .foregroundStyle(Color.secondary)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 12)
        .background(
            Color.secondary.opacity(0.1),
            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
        )
    }

    private var submitButton: some View {
        Button(action: submit) {
            HStack(spacing: 7) {
                if submitting { ProgressView().tint(.white) }
                Image(systemName: "lock.fill")
                Text(
                    submitting
                        ? "Saving securely…"
                        : preparedSubmission == nil ? "Save securely" : "Try again securely"
                )
            }
            .font(.system(size: 14, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 42)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(!canSubmit)
    }

    private var pairAgainNotice: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("Pair again to enter here", systemImage: "qrcode")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
            Text("This pairing predates secure phone entry. Scan a fresh QR from OpenMausBot, or finish this request on your computer.")
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private var secureConnectionNotice: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("Secure connection required", systemImage: "lock.shield.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
            Text("Switch to Secure phone access (HTTPS) or Tailscale, then try again. You can still finish this request on your computer.")
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    /// A different request landed in this card: start clean, with whatever
    /// envelope the session already holds for it.
    private func resetForNewRequest() {
        resetSensitiveState(clearPrepared: true)
        preparedSubmission = actions.preparedCredential(message: message, secret: secret)
        submitted = false
    }

    private func submit() {
        guard canSubmit else { return }
        submissionError = nil
        if let preparedSubmission {
            send(preparedSubmission)
            return
        }

        do {
            // Encryption happens synchronously. No task closure ever captures
            // the cleartext, and the native field is replaced immediately.
            let prepared = try actions.prepareCredential(
                value,
                message: message,
                secret: secret
            )
            clearPlaintext()
            preparedSubmission = prepared
            send(prepared)
        } catch {
            clearPlaintext()
            submissionError = error.localizedDescription
            Haptics.notification(.error)
        }
    }

    private func send(_ prepared: PreparedPhoneCredential) {
        submissionTask?.cancel()
        let submissionID = UUID()
        activeSubmissionID = submissionID
        submissionError = nil
        submitting = true

        submissionTask = Task { @MainActor in
            do {
                try await actions.provideCredential(prepared)
                guard !Task.isCancelled, activeSubmissionID == submissionID else { return }
                submitted = true
                Haptics.success()
            } catch {
                guard !Task.isCancelled, activeSubmissionID == submissionID else { return }
                // Keep only the exact ciphertext so Retry is the same
                // idempotent operation. The cleartext field is already gone.
                submissionError = error.localizedDescription
                Haptics.notification(.error)
            }

            guard activeSubmissionID == submissionID else { return }
            activeSubmissionID = nil
            submissionTask = nil
            submitting = false
        }
    }

    private func clearPlaintext() {
        value.removeAll(keepingCapacity: false)
        // Replacing the SecureField also clears UIKit's backing control,
        // including text inserted by Password AutoFill.
        fieldID = UUID()
    }

    private func suspendSensitiveEntry() {
        clearPlaintext()
        activeSubmissionID = nil
        submissionTask?.cancel()
        submissionTask = nil
        submitting = false
        submissionError = nil
        // Keep an already-encrypted envelope. If the request reached the
        // computer before iOS suspended it, foreground Retry must send the
        // exact same operation instead of generating fresh HPKE randomness.
    }

    private func resetSensitiveState(clearPrepared: Bool) {
        suspendSensitiveEntry()
        if clearPrepared, let preparedSubmission {
            actions.discardPreparedCredential(preparedSubmission)
            self.preparedSubmission = nil
        }
    }

    private func discardPreparedSubmission() {
        resetSensitiveState(clearPrepared: true)
        submitted = false
    }

}

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let message: Message
    let context: TranscriptRowContext
    let actions: TranscriptActions
    @State private var answering = false
    /// The full request behind a short card. Collapsed until asked for, and
    /// again whenever the card is drawn afresh.
    @State private var showingDetails = false

    /// The option this card offers that means "go ahead".
    ///
    /// Deliberately not the literal string "Allow". `options` is whatever the
    /// harness sent, and it only falls back to ["Allow", "Deny"] when the
    /// provider event named no choices of its own (`server/index.ts`) — a card
    /// is free to say "Yes", "Approve", "Allow once". Answering with a string
    /// the card never offered writes the grant and then hands the harness a
    /// choice it can reject, so the bot stays stopped with nothing on screen
    /// to explain it. The conventional label wins when it is present, which
    /// keeps the ordinary permission card behaving exactly as before.
    private var allowChoice: String? {
        guard let options = message.card?.options else { return nil }
        return options.first { $0.caseInsensitiveCompare("Allow") == .orderedSame }
            ?? options.first { !Self.isRefusal($0) }
    }

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    private var tint: Color { MausPalette.color(context.color) }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 10) {
                if card.isPending {
                    Label("\(context.name) is waiting on you", systemImage: "hand.raised.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                }
                headline(card)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if card.presentation == .standard {
                    // Proposals are reviewed in full before anyone confirms them.
                    if !card.subtitle.isEmpty {
                        Text(card.subtitle)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    // An approval leads with one line; the request itself,
                    // raw arguments and all, waits under Details.
                    if !card.summaryLine.isEmpty {
                        Text(card.summaryLine)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("approval-summary")
                    }
                    if card.hasDetails {
                        details(card.subtitle)
                    }
                }

                if let skill = card.skillRequest {
                    if let preview = skill.preview, let sha256 = skill.reviewedSha256 {
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Text("Review the complete SKILL.md")
                                    .font(.system(size: 12, weight: .semibold))
                                Spacer()
                                Text("sha256 \(String(sha256.prefix(8)))")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(Color.secondary)
                            }
                            Text(skill.source.map { LocalizedStringKey("Source: \($0)") } ?? "Source: unknown")
                                .font(.system(size: 11))
                                .foregroundStyle(Color.secondary)
                                .textSelection(.enabled)
                            ScrollView(.vertical) {
                                Text(preview)
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(Color.primary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 220)
                            .padding(10)
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                        }
                    } else {
                        Label(
                            "This proposal was created by an older build and cannot be safely applied. Deny it and ask the bot to create it again.",
                            systemImage: "exclamationmark.shield"
                        )
                        .font(.system(size: 12))
                        .foregroundStyle(.orange)
                    }
                }

                if card.showsHeldNote, let held = card.held {
                    Label(held, systemImage: "exclamationmark.shield")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                }

                if card.isPending {
                    HStack(spacing: 8) {
                        ForEach(card.options, id: \.self) { option in
                            Button {
                                Haptics.selection()
                                answering = true
                                Task {
                                    await actions.answer(card, choice: option)
                                    answering = false
                                }
                            } label: {
                                Text(option)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Self.isRefusal(option) ? Color.primary : .white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 40)
                                    .background(
                                        Capsule().fill(Self.isRefusal(option) ? Color.secondary.opacity(0.18) : tint)
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(
                                answering ||
                                    (card.skillRequest != nil && !Self.isRefusal(option) &&
                                        card.skillRequest?.reviewedSha256 == nil)
                            )
                        }
                    }
                    .padding(.top, 2)

                    // The grant key comes from the card. The phone never
                    // derives its own, so it cannot permit something subtly
                    // wider than the computer would have. The same goes for
                    // the answer: it is one of the options the card offered,
                    // never a string invented here.
                    if card.allowKey != nil, let allow = allowChoice, context.isBot {
                        Button("Always allow this tool") {
                            Haptics.selection()
                            answering = true
                            Task {
                                await actions.alwaysAllow(card)
                                await actions.answer(card, choice: allow, rememberingPermission: false)
                                answering = false
                            }
                        }
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity)
                        .disabled(answering)
                    }
                } else if let outcome = card.outcome {
                    Label {
                        outcomeText(outcome)
                    } icon: {
                        Image(systemName: Self.outcomeSymbol(outcome))
                    }
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("approval-outcome")
                } else if card.expired == true {
                    Label("Expired — ask for a fresh proposal", systemImage: "clock.badge.xmark")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(card.isPending ? tint.opacity(0.12) : Color.secondary.opacity(0.13))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(card.isPending ? tint : .clear, lineWidth: 1.5)
            }
        }
    }

    /// "Send to Linear?" for a held send to one app, the generic question
    /// for several, and the computer's own title for every other card.
    private func headline(_ card: OptionCard) -> Text {
        guard card.presentation == .outbound else { return Text(verbatim: card.title) }
        if let app = card.outboundApp { return Text("Send to \(app)?") }
        return Text("Send on your behalf?")
    }

    /// Long requests scroll inside a capped box; short ones just show.
    private static let detailsScrollThreshold = 480

    private func details(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showingDetails.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text("Details")
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .rotationEffect(.degrees(showingDetails ? 90 : 0))
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("approval-details-toggle")
            .accessibilityAddTraits(showingDetails ? .isSelected : [])

            if showingDetails {
                let request = Text(verbatim: text)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Color.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if text.count > Self.detailsScrollThreshold {
                        ScrollView(.vertical) { request }
                            .frame(height: 220)
                    } else {
                        request.fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(10)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("approval-details")
            }
        }
    }

    private func outcomeText(_ outcome: OptionCard.Outcome) -> Text {
        switch outcome {
        case .allowed: return Text("Allowed")
        case .denied: return Text("Denied")
        case .unavailable: return Text("No longer available")
        case .remembered: return Text("Remembered")
        case .skipped: return Text("Skipped")
        case let .answered(text): return text.isEmpty ? Text("Answered") : Text(verbatim: text)
        case let .chose(option, _): return Text(verbatim: option)
        case let .other(value): return Text(verbatim: value)
        }
    }

    private static func outcomeSymbol(_ outcome: OptionCard.Outcome) -> String {
        outcome.isPositive ? "checkmark.circle" : "xmark.circle"
    }
}

/// A frame of the bot's computer. In the paged shape the pixels are not in
/// the transcript — they are fetched here, once, when the row appears.
///
/// Decoded off the main actor at the width it is drawn (`ScreenShotImages`),
/// not in full on the main actor: a desktop frame is about 16 MB as a full
/// bitmap, and an open chat used to keep every one it had shown.
struct ScreenShot: View {
    let message: Message
    let actions: TranscriptActions
    @Environment(\.displayScale) private var displayScale
    /// The width the frame is drawn at, once laid out.
    @State private var width: CGFloat = 0
    @State private var image: UIImage?
    /// The pixel width `image` was decoded for.
    @State private var decodedWidth = 0

    private var pixelWidth: Int { Int((width * displayScale).rounded(.up)) }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        // Size only, so this fires on a rotation and not on every scroll.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .task(id: "\(message.id)|\(pixelWidth)") { await load(pixelWidth: pixelWidth) }
    }

    private func load(pixelWidth: Int) async {
        guard pixelWidth > 0, pixelWidth != decodedWidth else { return }
        if let cached = ScreenShotImages.cached(messageId: message.id, pixelWidth: pixelWidth) {
            image = cached
            decodedWidth = pixelWidth
            return
        }
        var data: Data?
        if let inline = message.png {
            data = await ScreenShotImages.data(fromBase64: inline)
        }
        if data == nil, message.hasImage == true {
            data = await actions.screenshot(messageId: message.id)
        }
        guard let data, !Task.isCancelled else { return }
        let decoded = await ScreenShotImages.decode(data, messageId: message.id, pixelWidth: pixelWidth)
        guard let decoded, !Task.isCancelled else { return }
        image = decoded
        decodedWidth = pixelWidth
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding or corner radius reads as the message jumping on arrival.
///
/// A caret rather than a spinner: a spinner says "something is happening
/// somewhere", which the reader already knows. A caret at the end of real
/// text says how far along it is.
///
/// The caret does not blink, deliberately. The obvious way to blink it —
/// `withAnimation(.repeatForever) { flag.toggle() }` in `onAppear` — animates
/// the change once and then sits still, and a caret that blinks twice and
/// stops looks more broken than one that never blinks. A correct version
/// animates opacity on a separate view, which needs a device to get right;
/// static is honest until then.
struct StreamingBubble: View {
    let text: String?
    let reasoning: String?
    var color: String = "blue"

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                if let reasoning, !reasoning.isEmpty, text?.isEmpty != false {
                    AgentThoughtChamberView(
                        reasoning: reasoning,
                        botName: "Bot",
                        mascotColor: MausPalette.color(color),
                        isStreaming: true
                    )
                    .equatable()
                }
                if let text, !text.isEmpty {
                    // Same renderer as the settled bubble, for the same
                    // reason as the padding: a live reply showing `**bold**`
                    // that snaps to bold on arrival is the message jumping,
                    // just in a different dimension. The parser tolerates the
                    // half-finished markdown this is always holding — an
                    // unclosed fence renders as code, an unclosed link as the
                    // characters typed so far.
                    MarkdownText(source: text, caret: true)
                        .foregroundStyle(Color.primary)
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .background(SpeechBubble(tail: .leading).fill(BubbleColor.theirs))
            .padding(.bottom, SpeechBubble.tailDrop())
            Spacer(minLength: 44)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}

/// What a working bot is saying, at Hidden: one grey line above the composer,
/// replaced by each new message, instead of a bubble per message.
private struct LiveStatusLine: View {
    let text: String
    /// The in-between message the line is showing. The line animates when
    /// a new one lands, not on every batch of a streaming reply (20 a
    /// second, each starting an animation over the last).
    let step: String?

    var body: some View {
        // No spinner of its own: the typing bubble in the transcript says
        // the bot is working, and this line says what at.
        HStack(spacing: 8) {
            Text(verbatim: text.replacingOccurrences(of: "\n", with: " "))
                .font(.system(size: 13))
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .animation(.easeOut(duration: 0.15), value: step)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("live-status-line")
    }
}

/// The held sends for one thread, as the desktop's composer shows them: one
/// line each, editable and deletable, with a note when the harness held them
/// for thread capacity rather than because a turn is running.
private struct QueuedSendList: View {
    let sends: [QueuedSend]
    let steer: (() -> Void)?
    let steering: Bool
    let edit: (QueuedSend) -> Void
    let cancel: (QueuedSend) -> Void

    private var showsCapacityNote: Bool {
        sends.contains { $0.reason == "capacity" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsCapacityNote {
                Text("Queued — starts when this bot has a free thread slot.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }
            ForEach(Array(sends.enumerated()), id: \.element.queueId) { index, send in
                HStack(spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.secondary)
                    Text(send.text)
                        .font(.system(size: 14))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if index == 0, let steer {
                        Button(steering ? "Steering…" : sends.count > 1 ? "Steer all" : "Steer", action: steer)
                            .font(.system(size: 14, weight: .medium))
                            .buttonStyle(.bordered)
                            .disabled(steering)
                            .accessibilityHint("Stops the current turn so the queued messages run now")
                    }
                    Button {
                        edit(send)
                    } label: {
                        Image(systemName: "pencil")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit queued message \(index + 1) of \(sends.count)")
                    Button {
                        cancel(send)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Delete queued message \(index + 1) of \(sends.count)")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(sends.count == 1 ? "1 queued message" : "\(sends.count) queued messages")
    }
}

/// The names an @ can tag, above the composer while one is being typed.
/// Tapping writes the exact name, so the harness's routing always matches
/// and autocorrect never touches it.
private struct MentionPicker: View {
    let choices: [MentionChoice]
    let bots: [Bot]
    let pick: (MentionChoice) -> Void

    private static let rowHeight: CGFloat = 44

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(choices) { choice in
                    Button { pick(choice) } label: {
                        HStack(spacing: 10) {
                            if let bot = bots.first(where: { $0.id == choice.id }) {
                                BotAvatarView(bot: bot, size: 26)
                            } else {
                                Image(systemName: "person.3.fill")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Color.secondary)
                                    .frame(width: 26, height: 26)
                                    .background(Circle().fill(Color.secondary.opacity(0.15)))
                            }
                            Text(verbatim: "@" + choice.name)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                            if choice.isEveryone {
                                Text("Everyone in this room")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Color.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: Self.rowHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("mention-\(choice.id)")
                }
            }
        }
        // Four rows, then it scrolls: a big room stays reachable without
        // the list climbing over the conversation.
        .frame(height: Self.rowHeight * CGFloat(min(choices.count, 4)))
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mention someone")
    }
}
