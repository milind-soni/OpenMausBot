import Foundation

/// One thread that needs the person, from any bot. Built from the same
/// attention rule and ordering as the thread tree, so the roster's Needs
/// attention section can never disagree with what the tree resurfaces.
public struct AttentionThread: Identifiable, Hashable, Sendable {
    public let botId: String
    public let botName: String
    public let task: BotTask

    public var id: String { "\(botId):\(task.threadId)" }
}

extension AttentionThread {
    /// The bot a tapped row opens, projected onto the thread the entry
    /// points at, or nil when that thread no longer resolves to a bot —
    /// a missing destination must leave the navigation path untouched
    /// instead of appending a value no destination matches.
    public func destinationBot(in state: CompanionState) -> Bot? {
        state.bot(forThread: task.threadId)
    }
}

extension BotTask {
    /// Whether a thread belongs in an attention list at all: it is working,
    /// needs the person, or has something they have not read. Attention is
    /// not history browsing — idle conversations never enter. The queued
    /// activity is parsed defensively: the wire's activity enum never
    /// carries it, but a companion build that derives it client-side can
    /// hand it to this same rule.
    public var needsAttention: Bool {
        activity == "waiting-on-you" || activity == "working" || activity == "queued"
            || busy == true || unread == true
    }

    /// Attention outranks recency: waiting-on-you needs the person most,
    /// then working or busy, then queued, then unread.
    public var attentionRank: Int {
        if activity == "waiting-on-you" { return 0 }
        if activity == "working" || busy == true { return 1 }
        if activity == "queued" { return 2 }
        if unread == true { return 3 }
        return 4
    }
}

extension Bot {
    /// This bot's threads that need the person, read from each thread's own
    /// status rather than the bot's aggregate flags. Routine runs are
    /// reachable through their run receipt, never an attention list. An
    /// older computer without a task list falls back to the bot's own
    /// conversation and its bot-level busy and unread flags.
    public func attentionTasks() -> [BotTask] {
        let candidates: [BotTask]
        if let tasks {
            candidates = tasks.filter { $0.routineRunId == nil }
        } else {
            candidates = [BotTask(
                threadId: threadId, title: "", createdAt: 0,
                modelSelection: modelSelection, busy: busy, unread: unread
            )]
        }
        return candidates.filter(\.needsAttention)
    }
}

/// Every thread that needs the person right now, across every visible bot.
/// Flatten first, then order once: sorting each bot on its own would let
/// the unread reply of an earlier bot outrank the waiting approval of a
/// later bot, which the thread tree never does. Hidden bots stay out
/// entirely; their threads resurface where the person hid them.
public func crossBotAttentionThreads(_ bots: [Bot], exceptBotId: String? = nil) -> [AttentionThread] {
    bots
        .filter { $0.id != exceptBotId && $0.hidden != true }
        .flatMap { bot in
            bot.attentionTasks().map { AttentionThread(botId: bot.id, botName: bot.name, task: $0) }
        }
        .enumerated()
        .sorted { lhs, rhs in
            let left = lhs.element.task.attentionRank
            let right = rhs.element.task.attentionRank
            return left == right ? lhs.offset < rhs.offset : left < right
        }
        .map(\.element)
}
