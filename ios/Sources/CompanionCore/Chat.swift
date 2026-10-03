// A chat is a bot or a room — the one conversation a screen is looking at.
// They share a thread, which is what every message, approval and page is
// keyed by. The enum lives here rather than in the app target so the wire
// projection below is unit-testable with the rest of the contract.
import Foundation

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
public enum Chat: Identifiable, Hashable, Codable, Sendable {
    case bot(Bot)
    case room(Room)

    /// The roster's identity: one row per bot or room.
    public var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    /// Owner identity remains available for bot APIs. Navigation and activity
    /// lists must distinguish two conversations belonging to the same bot.
    public var conversationID: String {
        switch self {
        case let .bot(bot): return "bot:\(bot.id):\(bot.threadId)"
        case let .room(room): return "room:\(room.id):\(room.threadId)"
        }
    }

    /// The wire address of this chat: the owner id plus the exact thread a
    /// destination-based request should land in. A bot freezes its currently
    /// selected task, so an in-flight send cannot drift to a task the desktop
    /// switched to meanwhile; a room always means its one shared thread.
    /// This is the only place that turns a Chat into a MessageDestination —
    /// call sites hand-building the cases drift from each other.
    public var destination: MessageDestination {
        switch self {
        case let .bot(bot): return .bot(id: bot.id, threadId: bot.threadId)
        case let .room(room): return .room(id: room.id, threadId: room.threadId)
        }
    }

    public static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id && a.threadId == b.threadId
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    public func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
            hasher.combine(bot.threadId)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    public var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    public var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    public var threadTitle: String {
        switch self {
        case let .bot(bot): return bot.tasks?.first { $0.threadId == bot.threadId }?.displayTitle ?? "Untitled thread"
        case let .room(room): return room.tasks?.first { $0.threadId == room.threadId }?.displayTitle ?? "Conversation"
        }
    }

    public var isBot: Bool {
        if case .bot = self { return true }
        return false
    }

    public var supportsTasks: Bool {
        switch self {
        case .bot: return true
        // \`tasks == nil\` means an older paired desktop. Hide the affordance
        // instead of sending it a route it does not know yet.
        case let .room(room): return room.dm != true && room.tasks != nil
        }
    }

    public var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    public var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    public var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }

    /// A turn the composer's Stop can end. A room runs before and between
    /// speakers too (routing, a member busy elsewhere), so it also counts
    /// `working`, as the desktop composer does (`group.working || busyBotId`).
    public var canStop: Bool {
        switch self {
        case .bot: return busy
        case let .room(room): return room.busyBotId != nil || room.working == true
        }
    }

    public var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }
}
