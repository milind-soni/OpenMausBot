import Foundation

extension CompanionState {
    /// One activity per bot: the newest pending ask wins over its working threads.
    public func liveActivityUpdates(detail: ActivityDetail) -> [ChatUpdate] {
        var seen = Set<String>()
        return updates(detail: detail).filter { update in
            guard update.kind != .toReview, case let .bot(bot) = update.chat else { return false }
            return seen.insert(bot.id).inserted
        }
    }
}

extension BotActivityContent {
    /// What one bot's activity shows for its update. Built here rather than
    /// in the app so the pacing tests drive exactly what the island sends.
    public init(update: ChatUpdate, face: String, since: Date) {
        let needsYou = update.kind == .needsYou
        self.init(
            face: face,
            kind: needsYou ? "needsYou" : "working",
            headline: needsYou ? "\(update.chat.name) needs you" : "\(update.chat.name) is working",
            line: update.line.isEmpty ? (update.card?.title ?? "") : update.line,
            threadId: update.chat.threadId,
            card: update.card,
            since: since
        )
    }

    /// True when the only change from `previous` is a working bot's line —
    /// the streamed reply's tail, a tool label, a queue note. Everything
    /// else, the line of an ask included, is something a person acts on.
    func isNarration(after previous: BotActivityContent) -> Bool {
        guard kind == "working", previous.kind == "working", line != previous.line else { return false }
        var same = self
        same.line = previous.line
        return same == previous
    }
}

/// Paces Live Activity updates, one bot at a time.
///
/// A working bot's line carries the streaming reply, so it changes on every
/// 400 ms window; sending each one was an `Activity.update` per streaming bot
/// per window (five bots: 12.5 a second), each an XPC to ActivityKit and a
/// redraw of the island and lock-screen views in the widget process. Apple
/// gives no number for in-app updates, only that the system coalesces and
/// throttles an app that updates too often, and that apps needing more must
/// opt in to `NSSupportsLiveActivitiesFrequentUpdates`, which this app does
/// not. So narration is held to one update per `workingLineInterval` per bot
/// — five seconds, long enough to read a 120-character line, one update a
/// second for a five-bot fleet — and everything else goes at once: an ask,
/// a kind change, a face, the thread, a bot appearing or ending.
public struct LiveActivityPacer: Sendable {
    public static let workingLineInterval: TimeInterval = 5

    public enum Decision: Equatable, Sendable {
        /// Send it now.
        case send
        /// The activity already shows exactly this.
        case unchanged
        /// Only the working line moved, too soon after the last update. It
        /// is due at the date; a sync then — or a later window — sends it.
        case held(until: Date)
    }

    private struct Sent: Sendable {
        var content: BotActivityContent
        var at: Date
    }

    public let workingLineInterval: TimeInterval
    private var sent: [String: Sent] = [:]

    public init(workingLineInterval: TimeInterval = LiveActivityPacer.workingLineInterval) {
        self.workingLineInterval = workingLineInterval
    }

    /// What this bot's activity was last sent, if anything.
    public func lastSent(forBot botId: String) -> BotActivityContent? {
        sent[botId]?.content
    }

    public func decision(for content: BotActivityContent, bot botId: String, at now: Date) -> Decision {
        guard let held = sent[botId] else { return .send }
        if held.content == content { return .unchanged }
        // A clock that went backwards cannot be trusted to release a hold.
        guard content.isNarration(after: held.content), now >= held.at else { return .send }
        let due = held.at.addingTimeInterval(workingLineInterval)
        return now >= due ? .send : .held(until: due)
    }

    public mutating func record(_ content: BotActivityContent, bot botId: String, at now: Date) {
        sent[botId] = Sent(content: content, at: now)
    }

    /// The bot's activity ended; its next one starts fresh.
    public mutating func forget(bot botId: String) {
        sent.removeValue(forKey: botId)
    }
}
