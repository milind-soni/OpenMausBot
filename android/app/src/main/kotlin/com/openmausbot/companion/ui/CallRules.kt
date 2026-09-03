package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Message

/** Where a call is — `CallView.Phase` on iOS. */
enum class CallPhase { LISTENING, SENDING, WORKING, SPEAKING }

/** What the call does next, decided from what just changed. */
sealed class CallAction {
    /** A pending approval or question: announce it, then listen. */
    data class Announce(val text: String) : CallAction()

    /** A reply landed: read it, then listen. */
    data class SayReply(val text: String) : CallAction()

    /** An activity chip the harness phrased for a voice: read it, then keep working. */
    data class SayChip(val text: String) : CallAction()

    /** The bot went busy while the mic was open: close it and wait. */
    data object StopListeningAndWork : CallAction()

    /** The bot went idle with nothing to say: open the mic. */
    data object Listen : CallAction()

    data object None : CallAction()
}

/**
 * The call loop's decisions, with no audio in them — the rules half of
 * `ios/App/CallView.swift`.
 *
 * Half-duplex on purpose: the microphone is live only while the bot is not
 * speaking. A recognizer that hears even a little of the bot's own voice
 * sends it back as a message, and the two of them talk forever.
 */
object CallRules {
    /** The turn ends this long after the transcript last changed — the desktop's endpointer. */
    const val ENDPOINT_GAP_MILLIS: Long = 850L

    fun phaseText(phase: CallPhase, name: String): String = when (phase) {
        CallPhase.LISTENING -> "Listening…"
        CallPhase.SENDING -> "Sending…"
        CallPhase.WORKING -> "$name is working…"
        CallPhase.SPEAKING -> "Speaking"
    }

    fun noVoiceNote(name: String): String = "Set up a voice in Settings → Voice to hear $name."

    /**
     * Approvals and questions are announced, not answered by voice: saying
     * "yes" to a permission is not the kind of thing to infer from a sentence
     * that happened to contain the word.
     */
    fun announcement(name: String, isPermission: Boolean): String =
        "$name ${if (isPermission) "is asking for permission" else "has a question"}. Open the chat to answer it."

    /**
     * `react()` in the Swift. [fresh] are the messages that arrived since the
     * last look; [pendingCard] the newest unanswered card; [announced] the
     * request ids already spoken.
     */
    fun react(
        name: String,
        fresh: List<Message>,
        pendingCard: Message?,
        announced: Set<String>,
        phase: CallPhase,
        busy: Boolean,
        speakerSpeaking: Boolean,
    ): CallAction {
        val request = pendingCard?.card?.requestId
        if (pendingCard != null && request != null && request !in announced && phase != CallPhase.SPEAKING) {
            return CallAction.Announce(announcement(name, pendingCard.card?.tool != null))
        }
        val reply = fresh.lastOrNull {
            it.role == Message.Role.BOT && it.kind == Message.Kind.TEXT && !it.text.isNullOrBlank()
        }
        if (reply != null) return CallAction.SayReply(reply.text.orEmpty())
        val chip = fresh.lastOrNull { it.kind == Message.Kind.ACTIVITY && it.tool?.spoken != null }
        if (chip != null && phase == CallPhase.WORKING) return CallAction.SayChip(chip.tool?.spoken.orEmpty())
        if (busy) {
            return if (phase == CallPhase.LISTENING || phase == CallPhase.SENDING) {
                CallAction.StopListeningAndWork
            } else {
                CallAction.None
            }
        }
        if ((phase == CallPhase.WORKING || phase == CallPhase.SENDING) && !speakerSpeaking) return CallAction.Listen
        return CallAction.None
    }
}
