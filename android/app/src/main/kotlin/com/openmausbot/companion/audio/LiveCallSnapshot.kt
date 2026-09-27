package com.openmausbot.companion.audio

/**
 * Where this phone's Live call is. IDLE has no bar. STARTING says
 * "Connecting…" until the computer reports the call attached and the data
 * channel is open; then LIVE. ENDING says "Hanging up…" until the computer
 * confirms a hang-up. ENDED keeps the bar up with a notice.
 */
enum class LiveCallPhase { IDLE, STARTING, LIVE, ENDING, ENDED }

/**
 * This phone's side of a Live call — media, captions, mute — as the bar and
 * the banner read it. The computer's side (`CompanionState.liveCall`) is a
 * separate truth: a call started from another device shows up there, never here.
 */
data class LiveCallSnapshot(
    val phase: LiveCallPhase = LiveCallPhase.IDLE,
    val botId: String? = null,
    val threadId: String? = null,
    val botName: String = "",
    /**
     * The computer's id for this phone's latest call, from the 201. It stays
     * after the call is over (ENDED, and the IDLE a hang-up or a dismiss
     * leaves) because the computer goes on reporting the call while it winds
     * down; the bar needs the id to know that call is this phone's, not
     * another device's. The next start, or a switch to another computer,
     * clears it.
     */
    val callId: String? = null,
    /**
     * When the call went live, in epoch ms on this phone's clock: the moment
     * the computer had reported it attached and the data channel was open.
     * The bar's clock counts from it, never from the computer's `startedAt`.
     */
    val liveSince: Long? = null,
    /** The voice's words, last [CAPTION_CHARS] characters. */
    val caption: String = "",
    /** The person's own words while they speak, last [HEARD_CHARS] characters; cleared when the voice answers. */
    val heard: String = "",
    val muted: Boolean = false,
    val speaker: Boolean = true,
    /** Why the call ended, or what went wrong; shown in the bar. */
    val notice: String? = null,
    /**
     * Whether the ended bar offers Try again: only after a dropped call or a
     * failed start, as on the desktop and the iPhone. False after every end
     * that is not a drop (the phone button starts the next call), and where
     * trying again cannot help until something else changes: no OpenAI key,
     * a line busy with another device's call, a denied microphone, a lost
     * pairing.
     */
    val canRetry: Boolean = true,
) {
    /** On a call or getting off one: the bar shows, the banner shows elsewhere, no new call starts. */
    val active: Boolean
        get() = phase == LiveCallPhase.STARTING || phase == LiveCallPhase.LIVE || phase == LiveCallPhase.ENDING

    /**
     * The microphone, the audio focus and the route are held. Anything that
     * would take the audio (dictation, a voice note, a voice preview) stays
     * off while this is true: losing the focus ends the call.
     */
    val holdsMedia: Boolean
        get() = phase == LiveCallPhase.STARTING || phase == LiveCallPhase.LIVE

    /** This chat owns the bar: a running call, or the notice of one that just ended. */
    fun concerns(threadId: String): Boolean = phase != LiveCallPhase.IDLE && this.threadId == threadId

    companion object {
        const val CAPTION_CHARS = 240
        const val HEARD_CHARS = 160
    }
}
