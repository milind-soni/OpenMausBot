// The SSE frames the harness broadcasts, as one enum.
//
// Every frame is `{ "kind": …, "seq": n, … }` with a payload keyed by kind
// (see `broadcast` in server/index.ts). Decoding switches on `kind`, and —
// this is the important part — an unrecognised kind decodes to `.unknown`
// rather than throwing. The harness gains frame kinds over time, and a
// phone from last month must keep folding the ones it does understand
// instead of tearing down its stream over one it does not.
import Foundation

public struct NotificationFrame: Codable, Hashable, Sendable {
    /// approval · question · done · routine-failed
    public var kind: String
    public var botId: String
    public var botName: String
    public var threadId: String
    public var title: String
    public var body: String

    /// A bot blocked on you, as opposed to one reporting in.
    public var isBlocking: Bool { kind == "approval" || kind == "question" }
}

/// A canonical runtime event. The server has already folded these into
/// messages, so a client only needs them for token-by-token streaming.
public struct RuntimeEvent: Codable, Hashable, Sendable {
    public var type: String
    public var threadId: String
    /// content.delta only
    public var delta: String?
    public var streamKind: String?
}

public enum Frame: Sendable {
    /// First frame on every connection. `resumed` is the server saying
    /// whether it could replay the gap; false means hydrate.
    case hello(cursor: String, resumed: Bool)
    case message(threadId: String, message: Message)
    case messagePatch(threadId: String, message: Message)
    /// A branch switch: which leaf of the conversation is now visible.
    case thread(threadId: String, activeLeafId: String?)
    case bot(Bot)
    case botDeleted(botId: String)
    case room(Room)
    case roomDeleted(groupId: String)
    /// Something worth interrupting for.
    case notify(NotificationFrame)
    /// A live frame of a bot's computer (base64). Only sent to clients that
    /// did not pass `screens=off`.
    case screen(botId: String, png: String, mime: String)
    /// The bot's cloud computer is being provisioned.
    case computer(botId: String, state: String)
    case config
    case runtime(RuntimeEvent)
    case unknown(kind: String)
}

extension Frame: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, cursor, resumed, threadId, message, activeLeafId
        case bot, botId, group, groupId, notification, png, mime, state, event
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)

        switch kind {
        case "hello":
            self = .hello(
                cursor: try container.decode(String.self, forKey: .cursor),
                resumed: try container.decodeIfPresent(Bool.self, forKey: .resumed) ?? false
            )
        case "message":
            self = .message(
                threadId: try container.decode(String.self, forKey: .threadId),
                message: try container.decode(Message.self, forKey: .message)
            )
        case "message.patch":
            self = .messagePatch(
                threadId: try container.decode(String.self, forKey: .threadId),
                message: try container.decode(Message.self, forKey: .message)
            )
        case "thread":
            self = .thread(
                threadId: try container.decode(String.self, forKey: .threadId),
                activeLeafId: try container.decodeIfPresent(String.self, forKey: .activeLeafId)
            )
        case "bot":
            self = .bot(try container.decode(Bot.self, forKey: .bot))
        case "bot.deleted":
            self = .botDeleted(botId: try container.decode(String.self, forKey: .botId))
        case "group":
            self = .room(try container.decode(Room.self, forKey: .group))
        case "group.deleted":
            self = .roomDeleted(groupId: try container.decode(String.self, forKey: .groupId))
        case "notify":
            self = .notify(try container.decode(NotificationFrame.self, forKey: .notification))
        case "screen":
            self = .screen(
                botId: try container.decode(String.self, forKey: .botId),
                png: try container.decode(String.self, forKey: .png),
                mime: try container.decodeIfPresent(String.self, forKey: .mime) ?? "image/png"
            )
        case "computer":
            self = .computer(
                botId: try container.decode(String.self, forKey: .botId),
                state: try container.decodeIfPresent(String.self, forKey: .state) ?? ""
            )
        case "config":
            self = .config
        case "runtime":
            self = .runtime(try container.decode(RuntimeEvent.self, forKey: .event))
        default:
            // routines, and whatever the harness adds next
            self = .unknown(kind: kind)
        }
    }
}

extension Frame {
    /// The thread this frame concerns, when it concerns one.
    public var threadId: String? {
        switch self {
        case let .message(threadId, _):
            return threadId
        case let .messagePatch(threadId, _):
            return threadId
        case let .thread(threadId, _):
            return threadId
        case let .notify(notification):
            return notification.threadId
        case let .runtime(event):
            return event.threadId
        default:
            return nil
        }
    }
}

/// A frame plus its position in the stream.
///
/// `seq` lives out here rather than inside the enum because an enum cannot
/// carry a stored property, and because the two answer different questions:
/// the frame says what happened, the sequence says where we are — which is
/// the only thing a reconnect needs.
public struct StreamFrame: Decodable, Sendable {
    public var frame: Frame
    public var seq: Int?

    private enum CodingKeys: String, CodingKey {
        case seq
    }

    public init(from decoder: Decoder) throws {
        self.frame = try Frame(from: decoder)
        self.seq = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(Int.self, forKey: .seq)
    }

    public init(frame: Frame, seq: Int?) {
        self.frame = frame
        self.seq = seq
    }
}
