// The composer's @mention picker.
//
// The harness routes on the text alone (`mentionedBots` in server/store.ts),
// so a tag typed by hand already works — when it is spelled exactly. The
// picker is what makes that practical on a phone: the names are offered, and
// autocorrect never gets a chance at them. The rules mirror the desktop
// composer (`src/components/Composer.tsx`, `src/lib/mentions.ts`).
//
// The query is measured to the end of the draft rather than to a caret: a
// SwiftUI text field does not expose its selection before iOS 18, and a tag
// is typed where the text is being written.
import Foundation

public struct MentionChoice: Hashable, Identifiable, Sendable {
    public static let everyoneID = "__everyone__"

    public let id: String
    public let name: String
    /// The bot's palette name; nil for @everyone.
    public let color: String?

    public init(id: String, name: String, color: String?) {
        self.id = id
        self.name = name
        self.color = color
    }

    public var isEveryone: Bool { id == Self.everyoneID }
}

public enum ComposerMention {
    /// The text after an `@` that starts a word, up to the end of the draft.
    /// nil while no tag is being typed.
    public static func query(in draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        // user@host, not a tag
        if at > draft.startIndex, !draft[draft.index(before: at)].isWhitespace { return nil }
        let query = draft[draft.index(after: at)...]
        // The desktop's limit, in the same UTF-16 units.
        guard query.utf16.count <= 24, !query.contains(where: \.isNewline) else { return nil }
        return String(query)
    }

    /// The pool, filtered by what has been typed. A completed tag ("@Six ")
    /// is not a new search, so it closes the picker.
    public static func choices(from pool: [MentionChoice], query: String) -> [MentionChoice] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.hasSuffix(" "), pool.contains(where: { $0.name.lowercased() == normalized }) { return [] }
        return pool.filter { normalized.isEmpty || $0.name.lowercased().contains(normalized) }
    }

    public static func choices(for draft: String, pool: [MentionChoice]) -> [MentionChoice] {
        guard let query = query(in: draft) else { return [] }
        return choices(from: pool, query: query)
    }

    /// The draft with the tag being typed replaced by the chosen name and a
    /// space, ready for the message. nil when no tag is being typed.
    public static func complete(_ draft: String, with choice: MentionChoice) -> String? {
        guard query(in: draft) != nil, let at = draft.lastIndex(of: "@") else { return nil }
        return String(draft[..<at]) + "@" + choice.name + " "
    }

    /// Who can be tagged here. A room offers @everyone (not in a DM) and its
    /// members; a bot's chat offers every other bot, which it reaches through
    /// ask_bot. Hidden bots are skipped, as the harness skips them.
    public static func pool(for chat: Chat, bots: [Bot]) -> [MentionChoice] {
        switch chat {
        case let .room(room):
            let everyone = room.dm == true ? [] : [MentionChoice(id: MentionChoice.everyoneID, name: "everyone", color: nil)]
            let members = room.memberIds.compactMap { id in bots.first { $0.id == id && $0.hidden != true } }
            return everyone + members.map(choice)
        case let .bot(current):
            return bots.filter { $0.id != current.id && $0.hidden != true }.map(choice)
        }
    }

    private static func choice(_ bot: Bot) -> MentionChoice {
        MentionChoice(id: bot.id, name: bot.name, color: bot.color)
    }
}
