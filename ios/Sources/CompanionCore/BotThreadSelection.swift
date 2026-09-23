import Foundation

/// Last opened bot thread on this phone, scoped to the paired computer.
/// Only generic roster taps restore it; explicit thread links keep their target.
public struct BotThreadSelection {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func restoringThread(_ chat: Chat, connectionID: String?) -> Chat {
        guard case let .bot(bot) = chat, let connectionID,
              let threadID = defaults.string(forKey: key(connectionID, bot.id)),
              let selected = bot.projected(forThread: threadID) else { return chat }
        return .bot(selected)
    }

    public func rememberThread(_ chat: Chat, connectionID: String?) {
        guard case let .bot(bot) = chat, let connectionID else { return }
        let key = key(connectionID, bot.id)
        if defaults.string(forKey: key) != bot.threadId {
            defaults.set(bot.threadId, forKey: key)
        }
    }

    private func key(_ connectionID: String, _ botID: String) -> String {
        "companion.thread.lastOpened.\(connectionID.utf8.count):\(connectionID)\(botID)"
    }
}
