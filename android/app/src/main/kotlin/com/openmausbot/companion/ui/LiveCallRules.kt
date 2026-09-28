package com.openmausbot.companion.ui

import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.LiveCallSnapshot
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import java.util.Locale

/** What the call bar shows for a chat: nothing, this phone's call, or a call another device holds. */
sealed interface LiveCallBarModel {
    data object Hidden : LiveCallBarModel

    data class Local(
        /** "Live with Ada" while live, before the [clock]; otherwise what is happening, or why the call ended. */
        val title: String,
        val caption: String,
        val heard: String,
        val muted: Boolean,
        val speaker: Boolean,
        val phase: LiveCallPhase,
        /** An ended call offers Try again ([LiveCallSnapshot.canRetry]). */
        val canRetry: Boolean = true,
        /** While live: the clock after [title]. A name too long for the line gives way; the clock never does. */
        val clock: String? = null,
    ) : LiveCallBarModel

    /**
     * A call on this chat that another device holds the microphone for. Only Hang up applies.
     * [title] and [clock] make the first line, as on this phone's own call; [device], where the
     * call is, has a line of its own under it.
     */
    data class Remote(val title: String, val clock: String, val device: String, val callId: String) : LiveCallBarModel
}

data class LiveVoiceOption(val id: String, val label: String)

/**
 * Wording and arithmetic for the Live call bar, banner and settings sheet.
 * Pure, so the JVM suite pins it. The words for how a call ended are the
 * desktop's (`call.live.*` in `src/locales/en.json`), so the three clients
 * say the same thing for the same reason; the rest is the spec's and the
 * iPhone's copy. The text says "computer", never "Mac": the harness runs on
 * other systems too.
 */
object LiveCallRules {
    const val NEEDS_KEY_MESSAGE = "Set up Live calls on your computer first."
    const val MIC_DENIED_MESSAGE = "Live calls need Microphone access. Enable it in Settings → MausBot."
    const val AUDIO_FAILED_MESSAGE = "Could not connect the call audio."
    /** The answer went in, but the audio never connected in `LiveCallManager.MEDIA_CONNECT_TIMEOUT_MS` (the desktop's `call.live.droppedNoAudio`). */
    const val AUDIO_TIMEOUT_MESSAGE = "Call dropped: the audio could not connect."
    const val START_FAILED_MESSAGE = "Could not start the call."
    /** The 409 names this phone's own previous call: the computer is still winding it down (up to 5 s). */
    const val LAST_CALL_ENDING = "Your last call is still ending on your computer. Try again in a moment."
    const val FOCUS_LOST_MESSAGE = "Call ended: another app took the audio."
    /**
     * The pairing went (unpaired, signed out, the token refused) and the call
     * was hung up at once: the desktop's words for the `signed-out` end reason.
     */
    const val SIGNED_OUT_MESSAGE = "Call ended: you were signed out."
    const val CONNECTING = "Connecting…"
    /** After Hang up, until the computer confirms the end. */
    const val HANGING_UP = "Hanging up…"
    /** The desktop's `call.live.ended`: an end with no more particular reason. */
    const val CALL_ENDED = "Call ended."
    /** The desktop's `call.live.dropped`. */
    const val CALL_DROPPED = "Call dropped."
    const val VOICE_APPLIES_NEXT_CALL = "Takes effect on the next call."
    /** Under the profile sheet's disabled "Preview voice": a preview would take the call's audio. */
    const val PREVIEW_DURING_CALL = "Voice preview is off during a Live call."
    /** Under a voice note's disabled play button: the note would take the call's audio, which ends the call. */
    const val VOICE_NOTE_DURING_CALL = "Voice notes can't play during a Live call."

    /** Where Live is set up on a phone (its settings sheet): what a call sends to OpenAI, and where the key stays. */
    const val DISCLOSURE =
        "A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers " +
            "and the details of any approval it asks for. The OpenAI key stays on your computer."

    /** The first-call disclosure's button that starts the call (with Cancel beside it). */
    const val START_CALL = "Start call"

    /** Under "Read replies to typed messages": what turning it off keeps from OpenAI. */
    const val TYPED_REPLIES_FOOTER = "When this is off, messages you type during a call and the bot's answers to them are not sent to OpenAI."

    /**
     * The desktop's `LIVE_VOICE_OPTIONS` (`src/lib/live-call.ts`), copied: the
     * harness sends no list, and the two apps must offer the same voices.
     */
    val VOICE_OPTIONS: List<LiveVoiceOption> = listOf(
        LiveVoiceOption("marin", "Marin (default)"),
        LiveVoiceOption("cedar", "Cedar"),
        LiveVoiceOption("alloy", "Alloy"),
        LiveVoiceOption("ash", "Ash"),
        LiveVoiceOption("ballad", "Ballad"),
        LiveVoiceOption("coral", "Coral"),
        LiveVoiceOption("echo", "Echo"),
        LiveVoiceOption("sage", "Sage"),
        LiveVoiceOption("shimmer", "Shimmer"),
        LiveVoiceOption("verse", "Verse"),
        LiveVoiceOption("gleam", "Gleam — North American, feminine"),
        LiveVoiceOption("meridian", "Meridian — North American, masculine"),
        LiveVoiceOption("quartz", "Quartz — Australian, feminine"),
        LiveVoiceOption("ripple", "Ripple — Australian, masculine"),
        LiveVoiceOption("vesper", "Vesper — British, masculine"),
        LiveVoiceOption("willow", "Willow — Irish, feminine"),
        LiveVoiceOption("stone", "Stone — Irish, masculine"),
        LiveVoiceOption("delta", "Delta — Southern U.S., feminine"),
        LiveVoiceOption("cinder", "Cinder — Southern U.S., masculine"),
        LiveVoiceOption("beacon", "Beacon — Filipino, masculine"),
        LiveVoiceOption("bossa", "Bossa — Brazilian Portuguese, feminine"),
        LiveVoiceOption("tempo", "Tempo — Brazilian Portuguese, masculine"),
    )

    /** Idle hang-up choices, in minutes: the same list on every client. The harness allows 1–60 and defaults to 5. */
    val IDLE_PRESETS: List<Int> = listOf(1, 2, 3, 5, 10, 15, 30, 60)

    fun voiceLabel(id: String): String =
        VOICE_OPTIONS.firstOrNull { it.id == id }?.label ?: id.ifBlank { VOICE_OPTIONS.first().label }

    /** The presets plus whatever another client set, so a value like 7 is shown and stays selected (as on the desktop). */
    fun idleChoices(current: Int): List<Int> = (IDLE_PRESETS + current).filter { it in 1..60 }.distinct().sorted()

    /** "m:ss", or "h:mm:ss" past an hour. A start ahead of the phone's clock shows 0:00, never a minus. */
    fun elapsed(startedAtMs: Long, nowMs: Long): String {
        val total = ((nowMs - startedAtMs) / 1000).coerceAtLeast(0)
        val hours = total / 3600
        val minutes = (total % 3600) / 60
        val seconds = total % 60
        // Locale.ROOT: the clock keeps Western digits on every device, as RoutineRules does.
        return if (hours > 0) {
            String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format(Locale.ROOT, "%d:%02d", minutes, seconds)
        }
    }

    /** "Live with Ada · 1:05", the banner's line. The bars draw it in its two parts, [liveWith] and [clockSuffix]. */
    fun title(botName: String, elapsed: String): String = liveWith(botName) + clockSuffix(elapsed)

    /** "Live with Ada": the part of a bar's line that gives way when the bot's name is too long for it. */
    fun liveWith(botName: String): String = "Live with $botName"

    /** " · 1:05": the part of a bar's line after [liveWith] that always shows. */
    fun clockSuffix(elapsed: String): String = " · $elapsed"

    fun clientLabel(client: String): String = when (client) {
        "desktop" -> "your computer"
        "ios" -> "an iPhone"
        "android" -> "another phone"
        else -> "another device"
    }

    /**
     * The remote bar's second line: where the call is. The desktop's remote
     * bar says it the same way ("Pepper is on a Live call from an iPhone"),
     * and so does the iPhone's.
     */
    fun fromDevice(client: String): String = "From ${clientLabel(client)}"

    /** The 409 `activeCall` wording: who is on the line. */
    fun busyMessage(active: LiveCallState): String =
        "A Live call is already running from ${clientLabel(active.client)}. Hang up there first."

    /** [dropped]: a connection lost on the way, not an end someone chose (the desktop's and the iPhone's classification). */
    data class EndNotice(val text: String, val dropped: Boolean)

    /**
     * The desktop's `endNotice` (`src/lib/live-call-media.ts`) for every
     * harness `LiveEndReason`, and OpenAI's own `session.closed` reasons on
     * this phone's data channel mapped the way the harness maps them
     * (`CLOSE_REASONS` in `server/live-call-controller.ts`).
     */
    fun endNotice(reason: String?): EndNotice = when (reason) {
        "idle" -> EndNotice("Call ended after a long silence.", dropped = false)
        "expired" -> EndNotice("Call ended: it reached OpenAI's time limit.", dropped = false)
        "content" -> EndNotice("OpenAI ended the call under its content rules.", dropped = false)
        "deleted" -> EndNotice("Call ended: the chat was deleted.", dropped = false)
        "shutdown" -> EndNotice("Call ended: OpenMausBot restarted.", dropped = false)
        "signed-out" -> EndNotice(SIGNED_OUT_MESSAGE, dropped = false)
        "remote-hangup", "remote_hangup", "connection-lost", "connection_lost", "sideband-lost", "error" ->
            EndNotice(CALL_DROPPED, dropped = true)
        // hung-up, close_requested, null, and whatever the harness adds next
        else -> EndNotice(CALL_ENDED, dropped = false)
    }

    /**
     * Whether a chat offers the phone button. Not while this phone is on a
     * call, or hanging one up (the bar has the controls), and not while the
     * computer reports a call running from any device: a start would only be
     * refused as busy, and that device has to hang up first.
     */
    fun offersCall(local: LiveCallSnapshot, server: LiveCallState?): Boolean =
        !local.active && server?.isRunning != true

    /**
     * Which bar a chat shows. This phone's call wins; otherwise a running call
     * the computer reports on this chat is shown as remote, with Hang up only.
     *
     * A call with this phone's own [LiveCallSnapshot.callId] is never remote,
     * and neither is a call that is `ending`: a hang-up is briefly still
     * ending on the computer after its own bar has gone (the desktop's and
     * the iPhone's rule), and without these checks that echo would come back
     * as a call "on another phone".
     */
    fun barModel(local: LiveCallSnapshot, server: LiveCallState?, threadId: String, botName: String, nowMs: Long): LiveCallBarModel {
        if (local.concerns(threadId)) {
            val name = local.botName.ifBlank { botName }
            val title = when (local.phase) {
                LiveCallPhase.STARTING -> CONNECTING
                LiveCallPhase.LIVE -> liveWith(name)
                LiveCallPhase.ENDING -> HANGING_UP
                LiveCallPhase.ENDED -> local.notice ?: CALL_ENDED
                LiveCallPhase.IDLE -> ""
            }
            val clock = if (local.phase == LiveCallPhase.LIVE) elapsed(local.liveSince ?: nowMs, nowMs) else null
            return LiveCallBarModel.Local(title, local.caption, local.heard, local.muted, local.speaker, local.phase, local.canRetry, clock)
        }
        val remote = server
            ?.takeIf {
                it.isRunning && it.status != LiveCallStatus.ENDING && it.threadId == threadId && it.callId != local.callId
            }
            ?: return LiveCallBarModel.Hidden
        return LiveCallBarModel.Remote(
            title = liveWith(botName),
            clock = elapsed(remote.startedAt.toLong(), nowMs),
            device = fromDevice(remote.client),
            callId = remote.callId,
        )
    }
}
