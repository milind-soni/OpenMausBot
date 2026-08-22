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

public struct CompanionState: Sendable {
    public var bots: [Bot] = []
    public var rooms: [Room] = []
    /// Transcripts by thread, which is the key both bots and rooms share.
    public var messages: [String: [Message]] = [:]
    /// Whether there is more transcript above what we hold, per thread.
    public var hasMore: [String: Bool] = [:]
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

    public init() {}

    // MARK: - Reading

    /// Named `transcript`, not `messages`: sharing a base name with the
    /// stored property compiles but reads as if one shadows the other.
    public func transcript(forThread threadId: String) -> [Message] {
        messages[threadId] ?? []
    }

    /// The active branch of a bot conversation. Rooms and legacy linear
    /// threads return their full transcript.
    public func visibleTranscript(forThread threadId: String) -> [Message] {
        let all = transcript(forThread: threadId)
        guard let leafId = bot(forThread: threadId)?.activeLeafId else { return all }
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { _, newest in newest })
        guard var current = byId[leafId] else { return all }
        var visible: [Message] = []
        var visited = Set<String>()
        while visited.insert(current.id).inserted {
            visible.append(current)
            guard let parentId = current.parentId, let parent = byId[parentId] else { break }
            current = parent
        }
        return visible.reversed()
    }

    public func bot(_ id: String) -> Bot? {
        bots.first { $0.id == id }
    }

    public func bot(forThread threadId: String) -> Bot? {
        bots.first { $0.threadId == threadId }
    }

    public func room(forThread threadId: String) -> Room? {
        rooms.first { $0.threadId == threadId }
    }

    /// Every unanswered approval or question, newest first. This is the
    /// screen the whole companion exists for.
    public var pendingApprovals: [(threadId: String, message: Message)] {
        var out: [(threadId: String, message: Message)] = []
        let activeThreads = bots.map(\.threadId) + rooms.map(\.threadId)
        for threadId in activeThreads {
            for message in visibleTranscript(forThread: threadId) where message.card?.isPending == true {
                out.append((threadId: threadId, message: message))
            }
        }
        return out.sorted { $0.message.at > $1.message.at }
    }

    /// Chats worth a badge.
    public var unreadCount: Int {
        bots.filter { $0.unread && $0.hidden != true }.count + rooms.filter(\.unread).count
    }

    // MARK: - Hydrating

    /// Replace everything from a `GET /api/bots` response.
    public mutating func hydrate(_ fleet: Fleet) {
        bots = fleet.bots
        rooms = fleet.groups
        messages.removeAll()
        hasMore.removeAll()
        for bot in fleet.bots {
            messages[bot.threadId] = bot.messages ?? []
            hasMore[bot.threadId] = bot.hasMore ?? false
        }
        for room in fleet.groups {
            messages[room.threadId] = room.messages ?? []
            hasMore[room.threadId] = room.hasMore ?? false
        }
    }

    /// Prepend an older page fetched for scrollback.
    public mutating func prepend(_ page: ThreadPage, toThread threadId: String) {
        let existing = messages[threadId] ?? []
        let known = Set(existing.map(\.id))
        messages[threadId] = page.messages.filter { !known.contains($0.id) } + existing
        hasMore[threadId] = page.hasMore ?? false
    }

    /// Merge a search landing window into the pages already held.
    public mutating func merge(_ page: ThreadPage, intoThread threadId: String) {
        var byId = Dictionary(
            uniqueKeysWithValues: (messages[threadId] ?? []).map { ($0.id, $0) }
        )
        for message in page.messages { byId[message.id] = message }
        messages[threadId] = byId.values.sorted {
            $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at
        }
        if let more = page.hasMore { hasMore[threadId] = more }
    }

    /// User-message alternatives created by edit-and-retry, oldest first.
    public func versions(of message: Message, inThread threadId: String) -> [Message] {
        guard message.role == .user, message.kind == .text else { return [] }
        return transcript(forThread: threadId)
            .filter { $0.role == .user && $0.kind == .text && $0.parentId == message.parentId }
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
    }

    // MARK: - Folding

    public mutating func apply(_ streamFrame: StreamFrame) {
        apply(streamFrame.frame)
    }

    public mutating func apply(_ frame: Frame) {
        switch frame {
        case .hello:
            // A hello describes the server's latest position, not one this
            // client has folded. Session commits it only after a cold
            // hydration succeeds; resumed streams advance frame by frame.
            break

        case let .message(threadId, message):
            append(message, to: threadId)
            if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                bots[index].activeLeafId = message.id
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
            var thread = messages[threadId] ?? []
            if let index = thread.firstIndex(where: { $0.id == message.id }) {
                thread[index] = message
                messages[threadId] = thread
            } else {
                // a patch for something we never saw — the append is more
                // useful than dropping it, and dedupes on id anyway
                append(message, to: threadId)
            }

        case let .thread(threadId, activeLeafId):
            if let index = bots.firstIndex(where: { $0.threadId == threadId }) {
                bots[index].activeLeafId = activeLeafId
            }
            // A branch switch changes which in-flight tail is meaningful.
            // Keeping the old branch's partial answer below the new leaf is
            // indistinguishable from the bot replying on the wrong branch.
            clearStream(threadId)

        case let .bot(bot):
            // Ordinary frames omit messages and must preserve the transcript.
            // Task switches deliberately include the new task's transcript;
            // that is authoritative and must replace the previous context.
            if let index = bots.firstIndex(where: { $0.id == bot.id }) {
                var merged = bot
                let previous = bots[index]
                if let replacement = bot.messages {
                    messages[bot.threadId] = replacement
                    hasMore[bot.threadId] = bot.hasMore ?? false
                    merged.messages = replacement
                    clearStream(previous.threadId)
                    if previous.threadId != bot.threadId { clearStream(bot.threadId) }
                } else {
                    merged.messages = previous.messages
                    merged.activeLeafId = bot.activeLeafId ?? previous.activeLeafId
                }
                bots[index] = merged
            } else {
                bots.append(bot)
                if messages[bot.threadId] == nil {
                    messages[bot.threadId] = bot.messages ?? []
                }
            }

        case let .botDeleted(botId):
            if let index = bots.firstIndex(where: { $0.id == botId }) {
                let threadId = bots[index].threadId
                messages.removeValue(forKey: threadId)
                hasMore.removeValue(forKey: threadId)
                // Everything else keyed by this bot goes too. A deleted bot
                // whose live text survives is a thread that keeps "typing"
                // with nothing to type into, and a retained screen frame is
                // hundreds of kilobytes of a desktop nobody can look at any
                // more — held for as long as the app runs, because deletion
                // was the last event that could ever mention this id.
                clearStream(threadId)
                clearScreen(botId)
                bots.remove(at: index)
            }

        case let .room(room):
            if let index = rooms.firstIndex(where: { $0.id == room.id }) {
                var merged = room
                merged.messages = rooms[index].messages
                rooms[index] = merged
            } else {
                rooms.append(room)
                if messages[room.threadId] == nil {
                    messages[room.threadId] = room.messages ?? []
                }
            }

        case let .roomDeleted(groupId):
            if let index = rooms.firstIndex(where: { $0.id == groupId }) {
                let threadId = rooms[index].threadId
                messages.removeValue(forKey: threadId)
                hasMore.removeValue(forKey: threadId)
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

    /// Append, unless we already hold it. Replaying a resumed stream can
    /// legitimately deliver a message twice — the cursor is the last frame
    /// *received*, and a frame in flight when the socket dropped arrives
    /// again on reconnect.
    private mutating func append(_ message: Message, to threadId: String) {
        var thread = messages[threadId] ?? []
        if let index = thread.firstIndex(where: { $0.id == message.id }) {
            thread[index] = message
        } else {
            thread.append(message)
        }
        messages[threadId] = thread
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
