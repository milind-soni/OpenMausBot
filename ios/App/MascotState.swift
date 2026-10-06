// Which face a bot wears — the desktop's `stateForBot`, ported.
//
// A pinned expression wins; then what the bot is doing right now; then a
// guess from its role. Same rules, same order, so a bot looks the same on
// the phone as on the laptop.
import Foundation
import CompanionCore

extension MausState {
    /// The desktop's legacy names, kept so an older bot record still resolves.
    private static let legacy: [String: MausState] = [
        "deadpan": .idle, "friendly": .happy, "focused": .working, "thinking": .thinking,
        "excited": .excited, "sleepy": .drowsy, "surprised": .surprised, "skeptical": .suspicious,
        "worried": .scared, "mischievous": .playful,
    ]

    /// Resolves any stored value — current, legacy or junk — to a real state.
    static func normalize(_ value: String?) -> MausState? {
        guard let value, !value.isEmpty else { return nil }
        return MausState(rawValue: value) ?? legacy[value]
    }

    static func forBot(_ bot: Bot, last: Message?) -> MausState {
        if let pinned = normalize(bot.mascotExpression) { return pinned }

        if last?.kind == .activity, last?.tool?.ok == false { return .alerting }
        if bot.busy == true { return .working }
        if bot.unread { return .notifying }
        if last?.kind == .options { return .curious }

        let profile = "\(bot.name) \(bot.title) \(bot.description)".lowercased()
        let range = NSRange(profile.startIndex..., in: profile)
        for (pattern, state) in roleGuesses where pattern.firstMatch(in: profile, range: range) != nil {
            return state
        }
        return .idle
    }

    /// A guess from the bot's role, first match wins. Each list is one
    /// pattern, `\b(?:code|coding|…)\b`, compiled once: it matches exactly
    /// where one of its words would on its own, and compiling a pattern per
    /// word for every row of every render was the roster's hottest line
    /// while a fleet was busy.
    private static let roleGuesses: [(NSRegularExpression, MausState)] = {
        let lists: [([String], MausState)] = [
            (["code", "coding", "developer", "development", "engineer", "engineering", "build", "debug", "program", "software"], .working),
            (["research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"], .searching),
            (["marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"], .excited),
            (["overnight", "night", "background", "async", "queue", "batch", "long-running"], .drowsy),
            (["monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"], .radar),
            (["review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal"], .suspicious),
            (["security", "secure", "compliance", "risk", "privacy", "finance", "financial"], .scared),
            (["design", "designer", "creative", "brainstorm", "art", "illustration", "music", "story"], .playful),
            (["support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"], .happy),
        ]
        return lists.map { words, state in
            let alternatives = words.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
            // fixed, escaped words: this pattern always compiles
            return (try! NSRegularExpression(pattern: "\\b(?:\(alternatives))\\b"), state)
        }
    }()

    /// The face for a chat as a whole: a bot's own, a room's is "happy" —
    /// which is what the desktop draws for room avatars.
    static func forChat(_ chat: Chat, in state: CompanionState) -> MausState {
        switch chat {
        case let .bot(bot): return forBot(bot, last: state.lastVisibleMessage(forThread: bot.threadId))
        case .room: return .happy
        }
    }
}
