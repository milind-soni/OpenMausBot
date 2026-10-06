// When the open chat ends with the typing bubble ("Pepper is typing").
//
// The desktop's rule (`src/lib/turn-tail.ts`, `showWorkingDots`) ported to
// the phone, with the gates the desktop applies around it at its call sites
// (ChatView.tsx, GroupView.tsx). Pure, over state the store already holds,
// so the order of the gates is pinned by tests rather than by screenshots.
import Foundation

public enum TurnTail {
    /// Whether the transcript should end with the typing bubble.
    ///
    /// A turn ends across several server frames: the settled reply, its
    /// final-answer mark, the turn's digest, then the frame that flips `busy`
    /// off. Deriving the dots from `busy` alone re-shows them under the reply
    /// for a beat at the end of every turn. A settled reply at the tail means
    /// there is nothing left to wait for, so the dots stay hidden until
    /// something new starts: a tool step, the person's next message, a stream
    /// opening, or (in rooms) a different member taking the floor.
    ///
    /// - Parameters:
    ///   - busy: the open thread is in a turn. Bots: this thread's `busy`.
    ///     Rooms: a member has the floor (`busyBotId`).
    ///   - activity: the thread's activity word. `waiting-on-you` is the bot
    ///     stopped on the person, which the card on screen already says.
    ///   - speakerBotId: rooms only, the member with the floor. A settled
    ///     reply from a previous speaker does not cover this one.
    ///   - messages: the thread's visible transcript, oldest first.
    ///   - hiddenIds: rows the transcript leaves out (Hidden's live
    ///     narration, which the status line shows instead).
    ///   - streaming: reply or reasoning text is arriving for this thread.
    public static func showsTyping(
        busy: Bool,
        activity: String? = nil,
        speakerBotId: String? = nil,
        messages: [Message],
        hiddenIds: Set<String> = [],
        streaming: Bool = false
    ) -> Bool {
        guard busy, activity != "waiting-on-you" else { return false }
        // A card waiting on the person is the thing on screen; dots under it
        // would say the bot is busy with something else.
        if awaitsAnswer(messages) { return false }
        // Text arriving is a new step, whatever the tail says: the store
        // clears the stream on the same frame that lands the settled reply.
        if streaming { return true }
        let shown = hiddenIds.isEmpty ? messages : messages.filter { !hiddenIds.contains($0.id) }
        guard let tail = shown.last else { return true }
        guard finishesTurn(tail, in: shown) else { return true }
        guard let speakerBotId else { return false }
        return tail.from?.botId != speakerBotId
    }

    /// An approval or question card still open anywhere in the thread, or a
    /// credential request in the turn since the person's last message.
    ///
    /// Option cards settle on the computer (answered, dismissed, expired),
    /// so any pending one is live. A credential card is only settled when
    /// someone acts on it, so one the person ignored turns ago would
    /// otherwise hold the dots off in this thread for good.
    static func awaitsAnswer(_ messages: [Message]) -> Bool {
        if messages.contains(where: { $0.card?.isPending == true }) { return true }
        let lastUser = messages.lastIndex { $0.role == .user }
        let turn = messages[(lastUser.map { $0 + 1 } ?? 0)...]
        return turn.contains { $0.kind == .secret && $0.secret?.isPending == true }
    }

    /// The tail is the end of a turn rather than a step inside one: a bot's
    /// settled text (the desktop's rule), a turn's digest, or anything else
    /// that belongs to a turn whose final answer is already marked.
    static func finishesTurn(_ tail: Message, in messages: [Message]) -> Bool {
        guard tail.role == .bot else { return false }
        if tail.kind == .text || tail.kind == .digest { return true }
        guard let turn = tail.turnId, !turn.isEmpty else { return false }
        return messages.contains {
            $0.turnId == turn && $0.role == .bot && $0.kind == .text && $0.turnTerminal == true
        }
    }
}

extension Chat {
    /// `TurnTail.showsTyping` for this chat: a bot's projected thread, or a
    /// room with whichever member has the floor.
    public func showsTyping(messages: [Message], hiddenIds: Set<String> = [], streaming: Bool = false) -> Bool {
        switch self {
        case let .bot(bot):
            return TurnTail.showsTyping(
                busy: busy, activity: bot.activity,
                messages: messages, hiddenIds: hiddenIds, streaming: streaming
            )
        case let .room(room):
            return TurnTail.showsTyping(
                busy: busy, speakerBotId: room.busyBotId,
                messages: messages, hiddenIds: hiddenIds, streaming: streaming
            )
        }
    }
}
