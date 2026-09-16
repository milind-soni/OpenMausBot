package com.astra.companion.ui

import com.astra.companion.core.Bot

/**
 * A bot's computer, watch-only — the rules behind `ios/App/ComputerView.swift`.
 *
 * The harness screenshots a working bot every few seconds and pushes the frame to
 * any client that asked for it. This is that and nothing more: no clicking, no
 * typing, no control. Watching is the useful half on a phone — you want to know
 * what it is doing, not to do it yourself on a screen the size of a playing card.
 */
object ComputerPolicy {
    const val IDLE_EXPLANATION = "This bot's computer is only captured while it is working."
    const val CONFIRM_TITLE = "Open live cloud desktop?"
    const val CONFIRM_MESSAGE =
        "This gives this phone full control of the cloud computer, including anything " +
            "signed in inside it."
    const val VNC_NOTE =
        "Interactive VNC session. Access must be enabled for this phone in the computer's " +
            "Phone settings."
    const val OPEN_DESKTOP = "Open live cloud desktop"

    /**
     * A VPS-backed bot is `"cloud"` too, but the server refuses to mint an
     * interactive desktop for it — no button beats a dead one. An older harness
     * never sends `cloudBackend`, so null keeps the button.
     *
     * Local VM and "this Mac" show the preview and no join button at all (§10).
     */
    fun showsCloudDesktop(bot: Bot): Boolean =
        bot.computer == "cloud" && bot.cloudBackend != "vps"

    /**
     * Busy is the difference between "the picture is a moment old" and "the
     * picture is however it was left" — worth saying, because a still frame looks
     * identical either way.
     */
    fun statusLabel(bot: Bot): String = if (bot.busy == true) "Preview" else "Idle"

    fun waitingHeadline(bot: Bot): String =
        if (bot.busy == true) "Waiting for a frame…" else "Nothing to show yet"

    /** An idle bot is not being screenshotted at all, so say so. */
    fun explainsIdle(bot: Bot): Boolean = bot.busy != true
}

/**
 * One screen watcher, acquired and released exactly once.
 *
 * Frames are hundreds of kilobytes of base64 each, so `Session` only asks for
 * them while something is watching, and it counts watchers to decide. A count
 * that drifts is the failure mode: one leaked increment leaves the stream pulling
 * screenshots forever, and one extra decrement turns them off under a screen that
 * is still open. Backgrounding does not touch the count — `Session.disconnect`
 * stops the stream and the reconnect resumes with screens still on, which is what
 * iOS does too, since `onDisappear` does not fire on a phone going to sleep.
 */
internal class ScreenWatch(
    private val start: (String) -> Unit,
    private val stop: (String) -> Unit,
) {
    private var watching: String? = null

    /** Watch [botId], releasing any bot already being watched. */
    fun watch(botId: String) {
        if (watching == botId) return
        release()
        watching = botId
        start(botId)
    }

    /** Idempotent: a second call releases nothing a second time. */
    fun release() {
        val current = watching ?: return
        watching = null
        stop(current)
    }
}
