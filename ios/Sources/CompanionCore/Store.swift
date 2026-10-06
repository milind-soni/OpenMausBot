// The client's state, and the fold that maintains it.
//
// This mirrors the reducer in `src/state/store.tsx`, and is deliberately a
// plain struct with a pure `apply(_:)` rather than anything observable: the
// fold is the part worth testing, and it should be testable without a
// server, a socket, or a UI.
//
// The harness has already turned provider events into settled messages, so
// the work here is small — append, patch, replace. That is the whole reason
// a phone client is a weekend of work rather than a rewrite.
import Foundation

public struct SidebarSection: Identifiable, Hashable, Sendable {
    public var name: String
    public var chiefs: [Bot]
    public var bots: [Bot]
    public var channels: [Room]

    public var id: String { name }
}

/// An edit the person just submitted, shown in place of the message it
/// replaces until the computer answers. It is presentation, never folded
/// into `messages`: the computer's fork is the only real version.
public struct PendingEdit: Equatable, Sendable {
    public let requestId = UUID().uuidString
    public var baseLeafId: String?
    public var sourceId: String
    public var text: String
    public var at: Double

    public init(sourceId: String, text: String, at: Double = Date().timeIntervalSince1970 * 1000, baseLeafId: String? = nil) {
        self.baseLeafId = baseLeafId
        self.sourceId = sourceId
        self.text = text
        self.at = at
    }

    /// The id the stand-in row renders under while the edit is in flight.
    public var placeholderId: String { "pending-edit-\(sourceId)" }
}

public struct CompanionState: Sendable {
    public var bots: [Bot] = []
    public var rooms: [Room] = []
    /// Transcripts by thread, which is the key both bots and rooms share.
    ///
    /// The fold never writes through this: it changes `transcripts` in
    /// place and keeps the indexes below in step one message at a time. A
    /// write from outside (tests, the DEBUG previews) replaces the whole
    /// dictionary, so the indexes are rebuilt for every thread — correct,
    /// and fine at that rate.
    public var messages: [String: [Message]] {
        get { transcripts }
        set {
            transcripts = newValue
            reindexAllThreads()
        }
    }
    /// The storage behind `messages`. Changed in place
    /// (`transcripts[id, default: []].append`, `transcripts[id]![i] = …`) so
    /// that a frame touches one element rather than copying its thread.
    private var transcripts: [String: [Message]] = [:]
    /// Threads holding at least one unanswered card, kept by the fold. What
    /// `pendingApprovals` visits instead of every message of every thread;
    /// it must always equal the threads a full scan would find.
    public private(set) var pendingCardThreads: Set<String> = []
    /// Threads held as one unforked chain: every message the child of the
    /// one before it and no id twice. Their active branch is the transcript
    /// itself up to the leaf, with no lookup table to build. Only ever a
    /// subset of the truth — a thread missing from it takes the full walk,
    /// which is always right.
    private var linearThreads: Set<String> = []
    /// How many messages a thread held right after a fetch the reader made
    /// (Load earlier, a search landing). Live growth does not trim those
    /// until `heldMessages` newer ones have arrived after them.
    private var readerExtents: [String: Int] = [:]
    /// The newest `at` trimmed from each thread: a patch for a message we do
    /// not hold from at or before it is a change to history, not a new line.
    private(set) var trimmedThrough: [String: Double] = [:]
    /// Whether there is more transcript above a fetched page, per thread.
    /// An absent entry means no page has loaded; SSE tails do not set this.
    /// A trimmed thread sets it, because the computer still has what was
    /// trimmed and Load earlier fetches it back.
    public var hasMore: [String: Bool] = [:]
    /// Branch heads belong to threads, not the bot's globally selected tab.
    public var activeLeafIds: [String: String] = [:]
    /// The last frame we folded — what a reconnect resumes from.
    public var cursor: String?
    /// Notifications that arrived while connected, newest last. Kept as a
    /// small recent window until the app has a real notification surface.
    public var notifications: [NotificationFrame] = []
    /// The reply being typed, per thread — cleared when it settles into a
    /// `Message`. Not persisted and not hydrated: it is what is happening
    /// right now, and a reconnect that missed it gets the settled message
    /// instead, which is strictly better.
    public var streaming: [String: String] = [:]
    /// The bot's reasoning, per thread, when the provider emits it. Kept
    /// apart from `streaming` because it is not the answer — running them
    /// together reads as the bot contradicting itself mid-sentence.
    public var reasoning: [String: String] = [:]
    /// The latest frame of each bot's computer, base64, while something is
    /// watching. Only ever populated when the stream was opened with
    /// `screens=on`, and only the newest frame is kept — these are hundreds
    /// of kilobytes each and a history of them is worth nothing.
    public var screens: [String: ScreenFrame] = [:]
    /// Edits in flight, per thread. Not hydrated and not cleared by a
    /// hydrate: they belong to the request that is still running.
    public var pendingEdits: [String: PendingEdit] = [:]
    /// Mid-turn sends the harness is holding until the running turn settles,
    /// by thread. They are deliberately NOT in messages: appending one now
    /// would make it the active leaf, and the rest of the running turn would
    /// hang off a line the model never saw. Identified by the harness's
    /// queueId, never by text.
    public var pendingQueued: [String: [QueuedSend]] = [:]
    /// queueIds whose drain frame beat the POST's own continuation. A short,
    /// bounded tombstone list, so a slow response cannot re-add a row for a
    /// message that is already in the transcript.
    public var drainedQueueIds: [String] = []
    /// The Live call the paired computer is running, or nil. The harness owns
    /// it; the phone never writes a guess from its own actions — a
    /// `live.call` frame, `GET /api/live/call` (Session) or the harness's
    /// answer to a hang-up (`applyLiveCallEnd`) is the only source. Kept as
    /// `ended` until the harness clears it, so the bar can say why.
    public var liveCall: LiveCallState? {
        didSet { liveCallRevision &+= 1 }
    }
    /// Counts writes to `liveCall`, whoever made them: what a lookup that
    /// was out meanwhile checks before it puts its older answer on the line.
    public private(set) var liveCallRevision = 0

    public init() {}

    /// The newest messages a thread keeps in memory however long the app
    /// stays connected. Ten pages of the 50 a chat opens on: far more than
    /// a screen, and the most a live chat drags along — every frame a
    /// thread receives costs at least one copy of it per publish (Session
    /// folds into a copy of the published state), and every derived read
    /// walks it. Older messages stay on the computer; Load earlier fetches
    /// them back, a page at a time, the way it always has.
    static let heldMessages = 500
    /// How far a thread may grow past `heldMessages` before one trim takes
    /// it back, so the shift is paid once per hundred messages, not per one.
    static let trimSlack = 100
    /// The window this state keeps: the two above everywhere but in tests,
    /// which shrink it to reach a trim within a few dozen frames.
    var window = (held: CompanionState.heldMessages, slack: CompanionState.trimSlack)

    // MARK: - Reading

    /// Named `transcript`, not `messages`: sharing a base name with the
    /// stored property compiles but reads as if one shadows the other.
    public func transcript(forThread threadId: String) -> [Message] {
        transcripts[threadId] ?? []
    }

    /// Threads holding at least one queued send. The row label, the Updates
    /// pill and the closed-thread fold all read this, never task activity.
    public var queuedThreadIds: Set<String> {
        Set(pendingQueued.keys)
    }

    /// Live events may create a partial transcript before a conversation is
    /// opened. Only a fetched page establishes its scrollback boundary.
    public func hasLoadedPage(forThread threadId: String) -> Bool {
        hasMore[threadId] != nil
    }

    /// The active branch of a bot conversation. Rooms and legacy linear
    /// threads return their full transcript. An edit in flight shows in place
    /// of the message it replaces, and hides everything that followed it,
    /// so the old question and its old answer leave the screen immediately.
    public func visibleTranscript(forThread threadId: String) -> [Message] {
        let branch = activeBranch(forThread: threadId)
        guard let pending = pendingEdits[threadId],
              let index = branch.firstIndex(where: { $0.id == pending.sourceId }) else {
            // No edit, or the computer's fork is already the visible branch.
            return branch
        }
        let source = branch[index]
        var standIn = Message(id: pending.placeholderId, role: .user, kind: .text, at: pending.at)
        standIn.text = pending.text
        standIn.parentId = source.parentId
        return Array(branch[..<index]) + [standIn]
    }

    /// The last line of `visibleTranscript(forThread:)` without building
    /// the branch, which ends at the leaf. A list row's face needs only
    /// this, and the roster asks for it for every bot on every render.
    public func lastVisibleMessage(forThread threadId: String) -> Message? {
        guard pendingEdits[threadId] == nil else { return visibleTranscript(forThread: threadId).last }
        let all = transcript(forThread: threadId)
        guard let leafId = activeLeafIds[threadId] ?? bot(forThread: threadId)?.activeLeafId else { return all.last }
        // The newest of a duplicated id, as in `activeBranch`.
        return all.last { $0.id == leafId } ?? all.last
    }

    private func activeBranch(forThread threadId: String) -> [Message] {
        let all = transcript(forThread: threadId)
        guard let leafId = activeLeafIds[threadId] ?? bot(forThread: threadId)?.activeLeafId else { return all }
        // An unforked chain — what a thread nobody has edited is — needs no
        // walk: the branch is the transcript, up to the leaf. This is the
        // common case, asked for by every surface on every publish, and the
        // walk below hashes every id in the thread to answer it.
        if linearThreads.contains(threadId) {
            if all.last?.id == leafId { return all }
            guard let leaf = all.lastIndex(where: { $0.id == leafId }) else { return all }
            return Array(all[...leaf])
        }
        // Walk positions, not copies: every render of a busy roster asks for
        // most threads' branches, and copying each message into a lookup
        // table cost more than the walk. The newest of a duplicated id wins.
        var positions: [String: Int] = [:]
        positions.reserveCapacity(all.count)
        for position in all.indices { positions[all[position].id] = position }
        guard var current = positions[leafId] else { return all }
        var path: [Int] = []
        var visited = Set<Int>()
        while visited.insert(current).inserted {
            path.append(current)
            guard let parentId = all[current].parentId, let parent = positions[parentId] else { break }
            current = parent
        }
        // An unforked thread is stored in branch order: the branch is the
        // transcript itself, with nothing to copy.
        if path.count == all.count, path.enumerated().allSatisfy({ $0.element == all.count - 1 - $0.offset }) {
            return all
        }
        return path.reversed().map { all[$0] }
    }

    public func bot(_ id: String) -> Bot? {
        bots.first { $0.id == id }
    }

    public func bot(forThread threadId: String) -> Bot? {
        guard let owner = bots.first(where: { $0.threadId == threadId || $0.tasks?.contains(where: { $0.threadId == threadId }) == true }),
              var view = owner.projected(forThread: threadId) else { return nil }
        view.activeLeafId = activeLeafIds[threadId] ?? view.activeLeafId
        return view
    }

    public func room(forThread threadId: String) -> Room? {
        rooms.first { $0.threadId == threadId }
    }

    /// User-named sidebar sections in the same natural order as the desktop:
    /// first appearance among bots, then channels. Section ordering is not a
    /// server record yet, so neither client can synchronize its local manual
    /// reordering with the other one.
    public var sidebarSections: [SidebarSection] {
        let visibleBots = bots.filter { $0.hidden != true }
        let visibleChannels = rooms.filter { $0.dm != true }
        let sectionChiefs = visibleBots.filter {
            $0.chiefOfStaff == true && Self.sectionName($0.section) != nil
        }
        let sectionBots = visibleBots.filter {
            $0.chiefOfStaff != true && !Self.isSidebarPinned($0) && Self.sectionName($0.section) != nil
        }
        var names: [String] = []
        // Match the desktop's natural order: ordinary bots, Chiefs, then
        // channels. Manual desktop-only ordering remains local by design.
        for raw in sectionBots.map(\.section) + sectionChiefs.map(\.section) + visibleChannels.map(\.section) {
            guard let name = Self.sectionName(raw), !names.contains(name) else { continue }
            names.append(name)
        }
        return names.map { name in
            SidebarSection(
                name: name,
                chiefs: sectionChiefs.filter { Self.sectionName($0.section) == name },
                bots: sectionBots.filter { Self.sectionName($0.section) == name },
                channels: visibleChannels.filter { Self.sectionName($0.section) == name }
            )
        }
    }

    public var unsectionedChief: Bot? {
        bots.first {
            $0.hidden != true
                && $0.chiefOfStaff == true
                && Self.sectionName($0.section) == nil
        }
    }

    public var unsectionedBots: [Bot] {
        bots.filter {
            $0.hidden != true
                && $0.chiefOfStaff != true
                && !Self.isSidebarPinned($0)
                && Self.sectionName($0.section) == nil
        }
    }

    /// Pinned is a virtual desktop/mobile bucket. A bot keeps its saved
    /// section underneath so unpinning returns it to the same context.
    public var pinnedBots: [Bot] {
        bots.filter { $0.hidden != true && Self.isSidebarPinned($0) }
    }

    public var unsectionedChannels: [Room] {
        rooms.filter { $0.dm != true && Self.sectionName($0.section) == nil }
    }

    public var botChats: [Room] {
        rooms.filter { $0.dm == true }
    }

    private static func sectionName(_ raw: String?) -> String? {
        guard let name = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return nil
        }
        return name
    }

    private static func isSidebarPinned(_ bot: Bot) -> Bool {
        bot.pinned == true && bot.chiefOfStaff != true
    }

    /// Every unanswered approval or question, newest first. This is the
    /// screen the whole companion exists for.
    public var pendingApprovals: [(threadId: String, message: Message)] {
        // Most threads hold no open card at all, and the fold already knows
        // which do: only those pay for working out which of their cards are
        // on the visible branch. Home, Live Activities and the widgets each
        // ask on every publish, so this must not walk every message.
        guard !pendingCardThreads.isEmpty else { return [] }
        var out: [(threadId: String, message: Message)] = []
        // Sorted for a stable order between equal times; the set's own
        // order changes from launch to launch.
        for threadId in pendingCardThreads.sorted() where isActiveThread(threadId) {
            for message in visibleTranscript(forThread: threadId) where message.card?.isPending == true {
                out.append((threadId: threadId, message: message))
            }
        }
        return out.sorted { $0.message.at > $1.message.at }
    }

    /// A thread some bot, bot task or room still owns. A card left in a
    /// thread nobody owns any more is not something anyone can answer.
    private func isActiveThread(_ threadId: String) -> Bool {
        bots.contains { $0.threadId == threadId || $0.tasks?.contains(where: { $0.threadId == threadId }) == true }
            || rooms.contains { $0.threadId == threadId }
    }

    /// Visible conversations worth a badge. The bot-level flag is an
    /// aggregate, so it must not add another count beside its unread tasks.
    public var unreadCount: Int {
        let botCount = bots.filter { $0.hidden != true }.reduce(0) { count, bot in
            if bot.tasks?.contains(where: { $0.unread != nil }) == true {
                return count + bot.visibleTasks.filter { $0.unread == true }.count
            }
            // Legacy computers omit task unread flags entirely. Do not
            // invent individual unread threads from their aggregate flag.
            let hasConversation = bot.tasks == nil || !bot.visibleTasks.isEmpty
            return count + (hasConversation && bot.unread ? 1 : 0)
        }
        return botCount + rooms.filter(\.unread).count
    }

    // MARK: - Hydrating

    /// An HTTP snapshot may arrive after the live stream has already folded
    /// newer messages. Reject it atomically rather than erase those events
    /// while keeping a cursor that says they were applied.
    public mutating func hydrate(
        _ fleet: Fleet,
        waitingThreads: [String: ThreadPage] = [:],
        ifCursorMatches expectedCursor: String?
    ) -> Bool {
        guard cursor == expectedCursor else { return false }
        hydrate(fleet, waitingThreads: waitingThreads)
        return true
    }

    /// Replace everything from a `GET /api/bots` response.
    public mutating func hydrate(_ fleet: Fleet, waitingThreads: [String: ThreadPage] = [:]) {
        bots = fleet.bots
        rooms = fleet.groups
        transcripts.removeAll()
        hasMore.removeAll()
        activeLeafIds.removeAll()
        pendingCardThreads.removeAll()
        linearThreads.removeAll()
        readerExtents.removeAll()
        trimmedThrough.removeAll()
        // The transcript lives in `messages` alone. A copy left on the bot
        // or room would share the buffer until the first frame, then hold
        // the hydrate-time transcript for the rest of the session — memory
        // nothing reads, and an O(n) `==` for every comparison of the bot.
        for index in bots.indices {
            let bot = bots[index]
            transcripts[bot.threadId] = bot.messages ?? []
            if bot.messages != nil { hasMore[bot.threadId] = bot.hasMore ?? false }
            activeLeafIds[bot.threadId] = bot.activeLeafId
            bots[index].messages = nil
            reindex(bot.threadId)
        }
        for index in rooms.indices {
            let room = rooms[index]
            transcripts[room.threadId] = room.messages ?? []
            if room.messages != nil { hasMore[room.threadId] = room.hasMore ?? false }
            rooms[index].messages = nil
            reindex(room.threadId)
        }
        for (threadId, page) in waitingThreads where bot(forThread: threadId) != nil {
            merge(page, intoThread: threadId)
        }
        // The fleet route returns the whole queue snapshot beside the bots,
        // so every refresh re-seeds it; landed lines then retire their rows.
        if let queues = fleet.botQueuedMessages {
            replaceBotQueues(queues)
        }
        reconcileAllQueued()
    }

    /// Prepend an older page fetched for scrollback.
    public mutating func prepend(_ page: ThreadPage, toThread threadId: String) {
        let existing = transcripts[threadId] ?? []
        let known = Set(existing.map(\.id))
        transcripts[threadId] = page.messages.filter { !known.contains($0.id) } + existing
        hasMore[threadId] = page.hasMore ?? false
        noteReaderFetch(threadId)
        reconcileQueued(threadId: threadId)
    }

    /// Merge a search landing window into the pages already held.
    ///
    /// The held pages can repeat an id — they came from the computer as
    /// they were, and hydrate merges waiting threads on every cold start —
    /// so the last copy wins instead of trapping the launch.
    public mutating func merge(_ page: ThreadPage, intoThread threadId: String) {
        var byId = Dictionary(
            (transcripts[threadId] ?? []).map { ($0.id, $0) },
            uniquingKeysWith: { _, newest in newest }
        )
        for message in page.messages { byId[message.id] = message }
        transcripts[threadId] = byId.values.sorted {
            $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at
        }
        // Legacy full pages omit hasMore. They still satisfy initial load,
        // while a sparse landing window preserves an existing boundary.
        hasMore[threadId] = page.hasMore ?? hasMore[threadId] ?? false
        if let leaf = page.activeLeafId { activeLeafIds[threadId] = leaf }
        noteReaderFetch(threadId)
        reconcileQueued(threadId: threadId)
    }

    /// Fold the fork an edit request returned. The stream normally delivers
    /// the same fork and its leaf move first; when the response wins that
    /// race the fork still becomes visible now. A leaf that already sits on
    /// or below the fork stays put, so a reply that arrived is never hidden.
    public mutating func adoptEdit(_ message: Message, inThread threadId: String, expectedPending: PendingEdit? = nil) {
        let currentLeaf = activeLeafIds[threadId] ?? bot(forThread: threadId)?.activeLeafId
        place(message, in: threadId)
        if let pending = expectedPending {
            guard pendingEdits[threadId] == pending, currentLeaf == pending.baseLeafId else { return }
        }
        guard !activeBranch(forThread: threadId).contains(where: { $0.id == message.id }) else { return }
        activeLeafIds[threadId] = message.id
        if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
            bots[index].activeLeafId = message.id
        }
    }

    /// User-message alternatives created by edit-and-retry, oldest first.
    public func versions(of message: Message, inThread threadId: String) -> [Message] {
        guard message.role == .user, message.kind == .text else { return [] }
        return userMessageVersions(inThread: threadId)[message.parentId] ?? []
    }

    /// Group once for a transcript render, not once for every user bubble.
    public func userMessageVersions(inThread threadId: String) -> [String?: [Message]] {
        Dictionary(grouping: transcript(forThread: threadId)
            .filter { $0.role == .user && $0.kind == .text }
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }, by: \.parentId)
    }

    // MARK: - Folding

    public mutating func apply(_ streamFrame: StreamFrame) {
        apply(streamFrame.frame)
    }

    /// Fold a UI delivery atomically, including the cursor. Publishing a
    /// local copy once avoids invalidating every view twice for every token.
    public mutating func applyBatch(_ frames: [StreamFrame]) {
        for frame in frames {
            apply(frame)
        }
        // Once per delivery, to the last frame that carried a seq — where
        // advancing frame by frame would have left it. Nothing in the fold
        // reads the cursor, so the positions in between were never seen;
        // building them cost two strings a frame.
        advance(to: frames.last(where: { $0.seq != nil })?.seq)
    }

    public mutating func apply(_ frame: Frame) {
        switch frame {
        case .hello:
            // A hello describes the server's latest position, not one this
            // client has folded. Session commits it only after a cold
            // hydration succeeds; resumed streams advance frame by frame.
            break

        case let .message(threadId, message):
            place(message, in: threadId)
            noteThreadActivity(threadId: threadId, at: message.at)
            // The line a held send finally became. Landing in the transcript
            // retires the row and leaves a tombstone, so the POST response
            // that is still in flight cannot re-add it.
            if message.role == .user, let queueId = message.queueId {
                consumeQueued(queueId: queueId, threadId: threadId)
            }
            if let bot = bot(forThread: threadId), message.parentId == bot.activeLeafId {
                activeLeafIds[threadId] = message.id
                if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                    bots[index].activeLeafId = message.id
                }
            }
            // A settled reply supersedes whatever was streaming into it.
            // Without this the live bubble survives alongside the real one:
            // the tail renders below any card or chip that settled next, and
            // the next block's deltas append onto the duplicated tail
            // instead of starting fresh. The desktop client learned this the
            // hard way; no reason to learn it twice.
            if message.role == .bot, message.kind == .text {
                clearStream(threadId)
            }

        case let .messagePatch(threadId, message):
            // A patch for something we never saw is appended — more useful
            // than dropping it, and dedupes on id anyway. One for something
            // we held is a change, not activity; nor is one for something we
            // trimmed, which stays history.
            if place(message, in: threadId, patch: true) == .appended {
                noteThreadActivity(threadId: threadId, at: message.at)
            }

        case let .thread(threadId, activeLeafId):
            activeLeafIds[threadId] = activeLeafId
            if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                bots[index].activeLeafId = activeLeafId
            }
            // A branch switch changes which in-flight tail is meaningful.
            // Keeping the old branch's partial answer below the new leaf is
            // indistinguishable from the bot replying on the wrong branch.
            clearStream(threadId)

        case let .bot(bot):
            if let leaf = bot.activeLeafId { activeLeafIds[bot.threadId] = leaf }
            // Ordinary frames omit messages and must preserve the transcript.
            // Task switches deliberately include the new task's transcript;
            // that is authoritative and must replace the previous context.
            if let index = bots.firstIndex(where: { $0.id == bot.id }) {
                var merged = bot
                merged.tasks = mergingStamps(merged.tasks, previous: bots[index].tasks)
                // The transcript lives in `messages` alone (see hydrate).
                merged.messages = nil
                if let replacement = bot.messages {
                    replaceTranscript(bot.threadId, with: replacement)
                    hasMore[bot.threadId] = bot.hasMore ?? false
                    if bot.currentTaskBusy != true { clearStream(bot.threadId) }
                    reconcileQueued(threadId: bot.threadId)
                } else {
                    merged.activeLeafId = activeLeafIds[bot.threadId]
                }
                bots[index] = merged
                if merged.currentTaskBusy == false { clearStream(bot.threadId) }
            } else {
                var added = bot
                added.messages = nil
                bots.append(added)
                if let page = bot.messages {
                    merge(ThreadPage(messages: page, hasMore: bot.hasMore ?? false), intoThread: bot.threadId)
                } else if transcripts[bot.threadId] == nil {
                    replaceTranscript(bot.threadId, with: [])
                }
            }

        case let .botDeleted(botId):
            if let index = bots.firstIndex(where: { $0.id == botId }) {
                let threadIds = Set([bots[index].threadId] + (bots[index].tasks ?? []).map(\.threadId))
                for threadId in threadIds {
                    forgetTranscript(threadId)
                    hasMore.removeValue(forKey: threadId)
                    activeLeafIds.removeValue(forKey: threadId)
                    pendingQueued.removeValue(forKey: threadId)
                    clearStream(threadId)
                }
                // Everything else keyed by this bot goes too. A deleted bot
                // whose live text survives is a thread that keeps "typing"
                // with nothing to type into, and a retained screen frame is
                // hundreds of kilobytes of a desktop nobody can look at any
                // more — held for as long as the app runs, because deletion
                // was the last event that could ever mention this id.
                clearScreen(botId)
                bots.remove(at: index)
            }

        case let .room(room):
            if let index = rooms.firstIndex(where: { $0.id == room.id }) {
                var merged = room
                let previous = rooms[index]
                // Ordinary room frames are metadata-only and preserve the
                // active transcript. A task switch includes messages and is
                // authoritative, just like a bot task switch.
                // The transcript lives in `messages` alone (see hydrate).
                merged.messages = nil
                if let replacement = room.messages {
                    replaceTranscript(room.threadId, with: replacement)
                    hasMore[room.threadId] = room.hasMore ?? false
                    reconcileQueued(threadId: room.threadId)
                    clearStream(previous.threadId)
                    if previous.threadId != room.threadId { clearStream(room.threadId) }
                }
                merged.tasks = mergingStamps(merged.tasks, previous: previous.tasks)
                rooms[index] = merged
            } else {
                var added = room
                added.messages = nil
                rooms.append(added)
                if let page = room.messages {
                    merge(ThreadPage(messages: page, hasMore: room.hasMore ?? false), intoThread: room.threadId)
                } else if transcripts[room.threadId] == nil {
                    replaceTranscript(room.threadId, with: [])
                }
            }

        case let .roomDeleted(groupId):
            if let index = rooms.firstIndex(where: { $0.id == groupId }) {
                let threadId = rooms[index].threadId
                forgetTranscript(threadId)
                hasMore.removeValue(forKey: threadId)
                pendingQueued.removeValue(forKey: threadId)
                // Same reasoning as a deleted bot: the thread is gone, so the
                // half-written reply streaming into it has nowhere to land.
                clearStream(threadId)
                rooms.remove(at: index)
            }

        case let .notify(notification):
            notifications.append(notification)
            if notifications.count > 100 {
                notifications.removeFirst(notifications.count - 100)
            }

        case let .runtime(event):
            apply(runtime: event)

        case let .screen(botId, png, mime):
            screens[botId] = ScreenFrame(png: png, mime: mime)

        case let .botQueued(queues):
            replaceBotQueues(queues)

        case let .liveCall(_, _, call):
            liveCall = call

        // Nothing to fold: config and provisioning state are not part of
        // this client's job yet.
        case .computer, .config, .unknown:
            break
        }
    }

    /// Live text, before the server has settled it into a `Message`.
    ///
    /// The harness folds provider events into settled messages and also
    /// relays the raw deltas, so a client can have the reply as it is typed
    /// and the authoritative record when the turn ends. Rendering only the
    /// settled message — which is what this did until now — means a long
    /// answer looks like nothing is happening for thirty seconds.
    private mutating func noteThreadActivity(threadId: String, at: Double) {
        guard at.isFinite else { return }
        for index in bots.indices {
            guard var tasks = bots[index].tasks, tasks.contains(where: { $0.threadId == threadId }) else { continue }
            for taskIndex in tasks.indices where tasks[taskIndex].threadId == threadId {
                tasks[taskIndex].updatedAt = max(tasks[taskIndex].updatedAt ?? 0, at)
            }
            bots[index].tasks = tasks
        }
        for index in rooms.indices {
            guard var tasks = rooms[index].tasks, tasks.contains(where: { $0.threadId == threadId }) else { continue }
            for taskIndex in tasks.indices where tasks[taskIndex].threadId == threadId {
                tasks[taskIndex].updatedAt = max(tasks[taskIndex].updatedAt ?? 0, at)
            }
            rooms[index].tasks = tasks
        }
    }

    private func mergingStamps(_ incoming: [BotTask]?, previous: [BotTask]?) -> [BotTask]? {
        guard let incoming else { return previous }
        return incoming.map { task in
            let local = previous?.first { $0.threadId == task.threadId }?.updatedAt
            let next: Double?
            switch (local, task.updatedAt) {
            case let (local?, remote?): next = max(local, remote)
            case let (local?, nil): next = local
            case let (nil, remote?): next = remote
            case (nil, nil): next = nil
            }
            guard next != task.updatedAt else { return task }
            var copy = task
            copy.updatedAt = next
            return copy
        }
    }

    private mutating func apply(runtime event: RuntimeEvent) {
        switch event.type {
        case "content.delta":
            guard let delta = event.delta, !delta.isEmpty else { return }
            switch event.streamKind {
            case "assistant_text":
                streaming[event.threadId, default: ""] += delta
            case "reasoning_text":
                reasoning[event.threadId, default: ""] += delta
            default:
                // an unknown stream kind is not ours to guess at; dropping it
                // is better than showing thinking as if it were the answer
                break
            }
        case "turn.completed", "turn.failed", "turn.aborted":
            clearStream(event.threadId)
        default:
            break
        }
    }

    /// The harness's answer to `POST /api/live/call/end` for `callId`, from
    /// the remote bar's hang-up: the bar goes on the answer rather than on
    /// the frame that follows it. Applied only while that call still reads
    /// as running here — a frame that already said `ended`, cleared the line
    /// or brought a newer call is later news than this answer.
    ///
    /// `answer` is nil when the harness no longer runs that call (404).
    /// Returns true when the call still reads as running all the same: a
    /// frame was missed, and the caller should ask for the line again rather
    /// than guess at it.
    public mutating func applyLiveCallEnd(callId: String, answer: LiveCallState?) -> Bool {
        guard let shown = liveCall, shown.callId == callId, shown.isRunning else { return false }
        guard let answer else { return true }
        if answer.callId == callId { liveCall = answer }
        return false
    }

    /// The harness's answer to `GET /api/live/call`, applied only if nothing
    /// newer reached the line while the request was out: no `live.call`
    /// frame, hang-up answer or other lookup wrote it since `revision` was
    /// read from `liveCallRevision`. A lookup that straddles a start could
    /// otherwise put back a `null` from before the 201 and end the call that
    /// just began. Frames about anything else leave the line alone, so they
    /// do not void the answer: the stream keeps folding while it is out.
    ///
    /// Returns false when the answer was stale and dropped; the stream
    /// already carried something newer.
    @discardableResult
    public mutating func applyLiveCallLookup(_ call: LiveCallState?, ifRevisionIs revision: Int) -> Bool {
        guard liveCallRevision == revision else { return false }
        liveCall = call
        return true
    }

    /// Forget a bot's screen. Called when the panel closes, so the next one
    /// opens on a live frame rather than on however the desktop looked when
    /// it was last watched.
    public mutating func clearScreen(_ botId: String) {
        screens.removeValue(forKey: botId)
    }

    /// Drop a thread's live text. The settled message that triggers this
    /// already contains every token it held.
    public mutating func clearStream(_ threadId: String) {
        streaming.removeValue(forKey: threadId)
        reasoning.removeValue(forKey: threadId)
    }

    // MARK: - Held mid-turn sends

    /// Remember a message the harness said it is holding.
    ///
    /// The drain frame can arrive before the POST that created the entry has
    /// even returned — the harness settles a turn on its own clock. When it
    /// already has, the words are in the transcript and adding a row for them
    /// would show the message twice, so the tombstone wins and is spent.
    public mutating func rememberQueued(_ send: QueuedSend, threadId: String) {
        if drainedQueueIds.contains(send.queueId) {
            drainedQueueIds.removeAll { $0 == send.queueId }
            return
        }
        guard !(pendingQueued[threadId] ?? []).contains(where: { $0.queueId == send.queueId }) else { return }
        pendingQueued[threadId, default: []].append(send)
    }

    /// A held line landed, or was cancelled on the server: drop its row and
    /// leave a tombstone behind. The tombstone is written even when there is
    /// no row — a drain that beats its own POST is exactly the race the
    /// tombstone exists for.
    public mutating func consumeQueued(queueId: String, threadId: String) {
        removeQueuedRow(queueId, threadId: threadId)
        markDrained(queueId)
    }

    /// The person took a held message back. Same retirement as a drain: the
    /// server dropped it, and a late POST continuation must not resurrect it.
    public mutating func cancelQueued(queueId: String, threadId: String) {
        consumeQueued(queueId: queueId, threadId: threadId)
    }

    /// Direct-bot queues are server-owned: a bot.queued frame or the fleet
    /// snapshot replaces them wholesale. Room queues are a separate queue the
    /// frame says nothing about, so their rows survive. Entries that vanish
    /// from the snapshot are tombstoned, so a slow POST response cannot
    /// resurrect a message another window already cancelled or drained.
    public mutating func replaceBotQueues(_ queues: [String: [QueuedSend]]) {
        let roomThreads = Set(rooms.flatMap { room in
            [room.threadId] + (room.tasks ?? []).map(\.threadId)
        })
        let liveIds = Set(queues.values.flatMap { list in list.map(\.queueId) })
        var next = queues.filter { !$0.value.isEmpty }
        for (threadId, entries) in pendingQueued where roomThreads.contains(threadId) {
            next[threadId] = entries
        }
        for (threadId, entries) in pendingQueued where !roomThreads.contains(threadId) {
            for entry in entries where !liveIds.contains(entry.queueId) {
                markDrained(entry.queueId)
            }
        }
        pendingQueued = next
    }

    /// Reconcile rows against a transcript that arrived whole — a hydrate, a
    /// page fetch, or a bot frame carrying its own messages. A window that
    /// was backgrounded through the drain never saw the message frame, and
    /// its rows have to go.
    public mutating func reconcileQueued(threadId: String) {
        guard pendingQueued[threadId] != nil else { return }
        let landed = Set(transcript(forThread: threadId).compactMap(\.queueId))
        guard !landed.isEmpty else { return }
        for queueId in landed {
            consumeQueued(queueId: queueId, threadId: threadId)
        }
    }

    public mutating func reconcileAllQueued() {
        for threadId in Array(pendingQueued.keys) {
            reconcileQueued(threadId: threadId)
        }
    }

    private mutating func removeQueuedRow(_ queueId: String, threadId: String) {
        guard var waiting = pendingQueued[threadId] else { return }
        waiting.removeAll { $0.queueId == queueId }
        if waiting.isEmpty {
            pendingQueued.removeValue(forKey: threadId)
        } else {
            pendingQueued[threadId] = waiting
        }
    }

    private mutating func markDrained(_ queueId: String) {
        drainedQueueIds.removeAll { $0 == queueId }
        drainedQueueIds.append(queueId)
        if drainedQueueIds.count > Self.maxDrainedQueueIds {
            drainedQueueIds.removeFirst(drainedQueueIds.count - Self.maxDrainedQueueIds)
        }
    }

    /// The tombstone window matches the desktop's: long enough to cover a
    /// slow POST, short enough that other clients cannot grow it forever.
    private static let maxDrainedQueueIds = 64

    // MARK: - Transcript storage

    private enum Placement: Equatable {
        /// New to this thread: it is the newest message now.
        case appended
        /// Already held: replaced where it stands.
        case replaced
        /// A change to the history trimmed from this thread: left on the
        /// computer, where Load earlier finds it with the change applied.
        case history
    }

    /// Append, unless we already hold it. Replaying a resumed stream can
    /// legitimately deliver a message twice — the cursor is the last frame
    /// *received*, and a frame in flight when the socket dropped arrives
    /// again on reconnect.
    ///
    /// Both writes go through the dictionary in place. Reading the thread
    /// into a local first, as this used to, holds a second reference to its
    /// buffer, so every frame copied the whole thread to add one message.
    @discardableResult
    private mutating func place(_ message: Message, in threadId: String, patch: Bool = false) -> Placement {
        if let index = transcripts[threadId]?.firstIndex(where: { $0.id == message.id }) {
            replace(at: index, with: message, in: threadId)
            return .replaced
        }
        // The harness sends every change to an existing message as a patch
        // (a message frame is always a new line, stamped now). A patch for
        // one we do not hold, from no later than what this thread trimmed —
        // an old screenshot losing its pixels, a routine card moving on — is
        // a change to the history above. Appended, it would read as the
        // newest line.
        if patch, let through = trimmedThrough[threadId], message.at <= through { return .history }
        let previous = transcripts[threadId]?.last
        transcripts[threadId, default: []].append(message)
        if message.card?.isPending == true { pendingCardThreads.insert(threadId) }
        // The id is new to the thread (looked for above), so the thread
        // stays a chain exactly when this hangs off the message before it.
        if let previous {
            if message.parentId != previous.id { linearThreads.remove(threadId) }
        } else {
            linearThreads.insert(threadId)
        }
        trimIfNeeded(threadId)
        return .appended
    }

    private mutating func replace(at index: Int, with message: Message, in threadId: String) {
        let old = transcripts[threadId]![index]
        transcripts[threadId]![index] = message
        if message.card?.isPending == true {
            pendingCardThreads.insert(threadId)
        } else if old.card?.isPending == true {
            // The card this patch answered may not have been the thread's
            // only open one; look before saying the thread has none.
            refreshPendingCards(threadId)
        }
        // A re-parented message (the harness inserting a late artifact
        // above it) can break the chain; it never mends one.
        if message.parentId != old.parentId { linearThreads.remove(threadId) }
    }

    /// Install a transcript that arrived whole, replacing the held one.
    private mutating func replaceTranscript(_ threadId: String, with replacement: [Message]) {
        transcripts[threadId] = replacement
        readerExtents.removeValue(forKey: threadId)
        trimmedThrough.removeValue(forKey: threadId)
        reindex(threadId)
    }

    private mutating func forgetTranscript(_ threadId: String) {
        transcripts.removeValue(forKey: threadId)
        readerExtents.removeValue(forKey: threadId)
        trimmedThrough.removeValue(forKey: threadId)
        pendingCardThreads.remove(threadId)
        linearThreads.remove(threadId)
    }

    /// The reader fetched part of this thread themselves: it stays held
    /// until `heldMessages` newer messages have arrived after it.
    private mutating func noteReaderFetch(_ threadId: String) {
        readerExtents[threadId] = transcripts[threadId]?.count
        reindex(threadId)
    }

    /// Keep a thread to its newest `heldMessages` once live growth takes it
    /// `trimSlack` past that (or past what the reader fetched). What goes is
    /// the oldest of it, which the computer still has: `hasMore` says so and
    /// Load earlier pages it back in from the first message held.
    ///
    /// Two things never go, so nothing on screen changes meaning: an open
    /// card (Updates, the Island and the widgets read only what is held) and
    /// the branch head (a head that is not held reads as no head at all).
    private mutating func trimIfNeeded(_ threadId: String) {
        guard let count = transcripts[threadId]?.count else { return }
        let limit = max(window.held + window.slack, (readerExtents[threadId] ?? 0) + window.held)
        guard count > limit else { return }
        var cut = count - window.held
        if pendingCardThreads.contains(threadId),
           let card = transcripts[threadId]?.firstIndex(where: { $0.card?.isPending == true }) {
            cut = min(cut, card)
        }
        if let leafId = activeLeafIds[threadId] ?? bot(forThread: threadId)?.activeLeafId,
           let leaf = transcripts[threadId]?.lastIndex(where: { $0.id == leafId }) {
            cut = min(cut, leaf)
        }
        guard cut > 0 else { return }
        let newestDropped = transcripts[threadId]![..<cut].reduce(-Double.infinity) { max($0, $1.at) }
        transcripts[threadId]!.removeFirst(cut)
        trimmedThrough[threadId] = max(trimmedThrough[threadId] ?? -.infinity, newestDropped)
        hasMore[threadId] = true
        readerExtents.removeValue(forKey: threadId)
        // A fork that has scrolled out of the held window leaves a chain.
        if !linearThreads.contains(threadId), Self.isLinear(transcripts[threadId]!) {
            linearThreads.insert(threadId)
        }
    }

    /// Re-derive one thread's indexes from what it holds.
    private mutating func reindex(_ threadId: String) {
        refreshPendingCards(threadId)
        if let thread = transcripts[threadId], Self.isLinear(thread) {
            linearThreads.insert(threadId)
        } else {
            linearThreads.remove(threadId)
        }
    }

    private mutating func refreshPendingCards(_ threadId: String) {
        if transcripts[threadId]?.contains(where: { $0.card?.isPending == true }) == true {
            pendingCardThreads.insert(threadId)
        } else {
            pendingCardThreads.remove(threadId)
        }
    }

    /// After an outside write to `messages`: every thread, from scratch.
    private mutating func reindexAllThreads() {
        pendingCardThreads.removeAll()
        linearThreads.removeAll()
        for threadId in transcripts.keys { reindex(threadId) }
        readerExtents = readerExtents.filter { transcripts[$0.key] != nil }
        trimmedThrough = trimmedThrough.filter { transcripts[$0.key] != nil }
    }

    /// Each message the child of the one before it, and no id twice — the
    /// shape whose branch to any leaf is the transcript up to that leaf.
    /// The chain is checked first because it fails fast on a forked thread
    /// and costs no hashing.
    private static func isLinear(_ thread: [Message]) -> Bool {
        for index in thread.indices.dropFirst() where thread[index].parentId != thread[index - 1].id {
            return false
        }
        var seen = Set<String>(minimumCapacity: thread.count)
        return thread.allSatisfy { seen.insert($0.id).inserted }
    }
}

extension CompanionState {
    /// Commit an authoritative cursor after a cold hydration succeeds.
    public mutating func resetCursor(_ cursor: String) {
        self.cursor = cursor
    }

    /// Advance the cursor to a frame's sequence, keeping the stream id.
    ///
    /// The cursor is `<streamId>:<seq>` and opaque to us except for this:
    /// the id half must be carried forward, because it is what stops the
    /// server replaying a previous run's frames into our state.
    public mutating func advance(to seq: Int?) {
        guard let seq, let cursor, let streamId = cursor.split(separator: ":").first else { return }
        self.cursor = "\(streamId):\(seq)"
    }
}
