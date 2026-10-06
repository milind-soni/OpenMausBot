package com.openmausbot.companion.core

/**
 * When the open chat ends with the typing bubble ("Pepper is typing").
 *
 * The desktop's rule (`src/lib/turn-tail.ts`, `showWorkingDots`) with the gates its
 * call sites add (ChatView.tsx, GroupView.tsx), and the same rule as iOS's
 * `TurnTail.swift`. Pure, over state the store already holds, so the order of the
 * gates is pinned by tests rather than by screenshots.
 */
object TurnTail {
    /**
     * Whether the transcript should end with the typing bubble.
     *
     * A turn ends across several server frames: the settled reply, its final-answer
     * mark, the turn's digest, then the frame that flips `busy` off. Deriving the dots
     * from `busy` alone re-shows them under the reply for a beat at the end of every
     * turn. A settled reply at the tail means there is nothing left to wait for, so the
     * dots stay hidden until something new starts: a tool step, the person's next
     * message, a stream opening, or (in rooms) a different member taking the floor.
     *
     * @param busy the open thread is in a turn. Bots: this thread's `busy`. Rooms: a
     *   member has the floor (`busyBotId`).
     * @param activity the thread's activity word. `waiting-on-you` is the bot stopped
     *   on the person, which the card on screen already says.
     * @param speakerBotId rooms only, the member with the floor. A settled reply from a
     *   previous speaker does not cover this one.
     * @param messages the thread's visible transcript, oldest first.
     * @param hiddenIds rows the transcript leaves out (Hidden's live narration, which
     *   the status line shows instead).
     * @param streaming reply or reasoning text is arriving for this thread.
     */
    fun showsTyping(
        busy: Boolean,
        activity: String? = null,
        speakerBotId: String? = null,
        messages: List<Message>,
        hiddenIds: Set<String> = emptySet(),
        streaming: Boolean = false,
    ): Boolean {
        if (!busy || activity == "waiting-on-you") return false
        // A card waiting on the person is the thing on screen; dots under it would
        // say the bot is busy with something else.
        if (awaitsAnswer(messages)) return false
        // Text arriving is a new step, whatever the tail says: the store clears the
        // stream on the same frame that lands the settled reply.
        if (streaming) return true
        val shown = if (hiddenIds.isEmpty()) messages else messages.filterNot { it.id in hiddenIds }
        val tail = shown.lastOrNull() ?: return true
        if (!finishesTurn(tail, shown)) return true
        if (speakerBotId == null) return false
        return tail.from?.botId != speakerBotId
    }

    /**
     * An approval or question card still open anywhere in the thread. They settle on
     * the computer (answered, dismissed, expired), so any pending one is live.
     *
     * iOS also counts a credential request in the current turn. This client has no
     * model for those cards (they decode as [Message.Kind.UNKNOWN]), so it cannot.
     */
    internal fun awaitsAnswer(messages: List<Message>): Boolean =
        messages.any { it.card?.isPending == true }

    /**
     * The tail is the end of a turn rather than a step inside one: a bot's settled
     * text (the desktop's rule), a turn's digest, or anything else that belongs to a
     * turn whose final answer is already marked.
     */
    internal fun finishesTurn(tail: Message, messages: List<Message>): Boolean {
        if (tail.role != Message.Role.BOT) return false
        if (tail.kind == Message.Kind.TEXT || tail.kind == Message.Kind.DIGEST) return true
        val turn = tail.turnId?.takeIf { it.isNotEmpty() } ?: return false
        return messages.any {
            it.turnId == turn && it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT &&
                it.turnTerminal == true
        }
    }
}

/** [TurnTail.showsTyping] for this chat: a bot's projected thread, or a room with whichever member has the floor. */
fun Chat.showsTyping(
    messages: List<Message>,
    hiddenIds: Set<String> = emptySet(),
    streaming: Boolean = false,
): Boolean = when (this) {
    is Chat.BotChat -> TurnTail.showsTyping(
        busy = busy, activity = bot.activity,
        messages = messages, hiddenIds = hiddenIds, streaming = streaming,
    )
    is Chat.RoomChat -> TurnTail.showsTyping(
        busy = busy, speakerBotId = room.busyBotId,
        messages = messages, hiddenIds = hiddenIds, streaming = streaming,
    )
}
