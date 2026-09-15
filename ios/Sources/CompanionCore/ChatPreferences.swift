// The parts of the chat's preferences that are logic rather than screen:
// how much of a bot's working-out the transcript shows, and what sits on
// the composer's chip row.
//
// These live in the core, away from SwiftUI, because they are the pieces
// worth testing — the views that read them are wiring.
import Foundation

/// How much of a bot's activity the transcript shows.
public enum ActivityDetail: String, CaseIterable, Codable, Sendable {
    /// Every chip, as the harness sent them.
    case full
    /// Consecutive chips fold into one summary; failures never fold.
    case reduced
    /// No activity chips at all.
    case hidden

    public var label: String {
        switch self {
        case .full: "Full"
        case .reduced: "Reduced"
        case .hidden: "Hidden"
        }
    }

    public var caption: String {
        switch self {
        case .full: "Every step a bot takes."
        case .reduced: "Steps fold into one line. Failures always show."
        case .hidden: "No activity, only messages."
        }
    }
}

/// When the island plays a bot's face on opening a chat.
public enum IslandIntro: String, CaseIterable, Codable, Sendable {
    case always
    /// The first time each bot is opened, then never again for that bot.
    case oncePerBot
    case never

    public var label: String {
        switch self {
        case .always: "Always"
        case .oncePerBot: "First time per bot"
        case .never: "Never"
        }
    }
}

/// One chip on the composer's quick-reply row.
public struct QuickReply: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var prompt: String
    public var icon: String

    public init(id: String = UUID().uuidString, title: String, prompt: String, icon: String) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.icon = icon
    }

    /// The four the composer shipped with, kept as the reset target.
    public static let defaults: [QuickReply] = [
        QuickReply(id: "default.diff", title: "Show diff", prompt: "Show latest git diff", icon: "arrow.triangle.pull"),
        QuickReply(id: "default.tests", title: "Run tests", prompt: "Run all automated tests", icon: "checkmark.seal"),
        QuickReply(id: "default.explain", title: "Explain steps", prompt: "Explain the changes in detail", icon: "text.bubble"),
        QuickReply(id: "default.next", title: "What's next?", prompt: "What should we do next?", icon: "sparkles"),
    ]

    /// Icons offered by the editor. Small on purpose: a full symbol browser
    /// is a different feature, and twelve covers what a chip is ever for.
    public static let iconChoices = [
        "sparkles", "arrow.triangle.pull", "checkmark.seal", "text.bubble",
        "hammer", "ladybug", "doc.text", "terminal",
        "paperplane", "magnifyingglass", "clock.arrow.circlepath", "list.bullet",
    ]

    public static func encode(_ replies: [QuickReply]) -> String {
        guard let data = try? JSONEncoder().encode(replies) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Anything unreadable becomes the defaults. An empty *string* is a
    /// store that has never been written; an empty *list* is a row the user
    /// deliberately cleared, and those must not mean the same thing.
    public static func decode(_ json: String) -> [QuickReply] {
        guard !json.isEmpty, let data = json.data(using: .utf8) else { return defaults }
        guard let decoded = try? JSONDecoder().decode([QuickReply].self, from: data) else { return defaults }
        let ids = decoded.map { $0.id.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard ids.allSatisfy({ !$0.isEmpty }), Set(ids).count == ids.count else { return defaults }
        return decoded
    }
}

/// A transcript entry: either a message, or a folded run of activity.
public enum TranscriptRow: Identifiable, Hashable, Sendable {
    case message(Message)
    case activityRun([Message])

    /// The message a row answers for — its first, which is the one whose
    /// time and sender the transcript reads.
    public var head: Message {
        switch self {
        case let .message(message): message
        case let .activityRun(items): items[0]
        }
    }

    public var id: String {
        switch self {
        case let .message(message): message.id
        case let .activityRun(items): "run.\(items[0].id)"
        }
    }

    public var at: Double { head.at }
    /// The last timestamp covered by this row. Date separators compare the
    /// next row with this value so a folded run cannot manufacture a gap.
    public var endAt: Double {
        switch self {
        case let .message(message): message.at
        case let .activityRun(items): items.last?.at ?? head.at
        }
    }
    public var role: Message.Role { head.role }
    public var kind: Message.Kind { head.kind }
    public var senderName: String? { head.from?.name }
}

/// The one line a roster row shows under a chat's name.
///
/// Folded by the same rule as the transcript, and for the same reason: a
/// reader who has turned activity off has said they do not want to see tool
/// calls, and the roster is where they see the most of them — one per chat,
/// on the screen they spend the most time on. Reading the preview off the
/// raw last message made "Hidden" mean "hidden in one place".
public func rosterPreview(_ messages: [Message], detail: ActivityDetail) -> String {
    guard let last = transcriptRows(messages, detail: detail).last else { return "" }
    switch last {
    case let .message(message):
        return previewText(of: message)
    case let .activityRun(items):
        let running = items.contains { $0.tool?.ok == nil }
        return "\(running ? "Running" : "Ran") \(items.count) steps"
    }
}

/// What a single message reads as in a roster row.
func previewText(of message: Message) -> String {
    switch message.kind {
    case .text: return message.text ?? ""
    // a pending card's question is the preview; the roster row already
    // says "waiting on you" beside it
    case .options:
        guard let card = message.card else { return "" }
        return card.isPending && !card.subtitle.isEmpty ? card.subtitle : card.title
    case .secret:
        return message.secret?.label ?? message.text ?? "Credential required"
    case .activity: return message.tool?.name ?? ""
    case .screen: return "Screenshot"
    case .digest: return message.digest?.summary ?? message.text ?? ""
    case .compaction: return message.compaction?.chipText ?? message.text ?? ""
    case .unknown: return message.text ?? ""
    }
}

/// Rows the harness writes about a turn rather than in it: tool chips and,
/// since Phase 0, the digest and compaction receipts. Hidden together,
/// because a reader who turned activity off does not want the summary of
/// exactly those calls either.
public func isActivityReceipt(_ message: Message) -> Bool {
    switch message.kind {
    case .activity, .digest, .compaction: return true
    default: return false
    }
}

/// Folds a transcript to the requested level of detail.
///
/// A failed step is never folded away: the reason to turn activity down is
/// the successful noise, and losing the one chip that says something went
/// wrong would make `reduced` a worse default than `full`.
public func transcriptRows(_ messages: [Message], detail: ActivityDetail) -> [TranscriptRow] {
    switch detail {
    case .full:
        return messages.map(TranscriptRow.message)
    case .hidden:
        return messages.filter { !isActivityReceipt($0) }.map(TranscriptRow.message)
    case .reduced:
        var rows: [TranscriptRow] = []
        var run: [Message] = []

        // A run of one is not worth a summary — emit the chip itself.
        func flush() {
            if run.count > 1 {
                rows.append(.activityRun(run))
            } else {
                rows.append(contentsOf: run.map(TranscriptRow.message))
            }
            run.removeAll()
        }

        for message in messages {
            guard message.kind == .activity else {
                flush()
                rows.append(.message(message))
                continue
            }
            if message.tool?.ok == false {
                flush()
                rows.append(.message(message))
                continue
            }
            run.append(message)
        }
        flush()
        return rows
    }
}
