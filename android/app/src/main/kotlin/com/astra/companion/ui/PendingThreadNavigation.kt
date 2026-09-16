package com.astra.companion.ui

import com.astra.companion.core.NotificationTarget
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A notification tap, delivered to the UI exactly once.
 *
 * Two failure modes to avoid at the same time, which is why this is not simply
 * "clear the extras":
 *
 * - The Intent that launched the Activity is handed back on every recreation, so
 *   stripping nothing would re-navigate on every rotation, dragging the reader
 *   back into a task they had already left.
 * - Stripping the extras as soon as they are read loses them if the process is
 *   recreated *before* the composition consumed them — a rotation during the
 *   cold-start restore, which is exactly when a notification tap is slowest.
 *
 * So the extras stay on the Intent and what is remembered is which
 * `(botId, threadId)` pair has already been opened. That composite token rides
 * in the Activity's saved instance state (memory, not disk): it survives a
 * configuration change and is gone on a genuinely fresh launch. It holds only
 * the two opaque ids from the notification payload — never a credential or
 * device token.
 */
class PendingThreadNavigation(consumedToken: String? = null) {
    private val _pending = MutableStateFlow<NotificationTarget?>(null)
    val pending: StateFlow<NotificationTarget?> = _pending.asStateFlow()

    private var consumed: String? = consumedToken

    /**
     * @param fresh true for a tap delivered while the Activity was already alive
     *   (`onNewIntent`), which is always a new request even for the same target.
     */
    fun offer(target: NotificationTarget?, fresh: Boolean = false) {
        val next = target ?: return
        val token = tokenOf(next)
        if (fresh) {
            consumed = null
        } else if (token == consumed) {
            return
        }
        _pending.value = next
    }

    fun offer(botId: String?, threadId: String?, fresh: Boolean = false) {
        offer(NotificationTarget.from(botId, threadId), fresh)
    }

    /** The UI opened (or definitively failed) this target: do not offer it again after a recreation. */
    fun consume() {
        consumed = _pending.value?.let(::tokenOf) ?: consumed
        _pending.value = null
    }

    /**
     * Consume only when the current pending entry is [target].
     *
     * A stale callback from tap A must not mark B consumed after `onNewIntent`
     * replaced the pending entry — that would suppress B on recreation without
     * ever navigating to it.
     */
    fun consume(target: NotificationTarget) {
        val token = tokenOf(target)
        val current = _pending.value ?: return
        if (tokenOf(current) != token) return
        consumed = token
        _pending.value = null
    }

    /** The composite token to write into saved instance state. */
    fun consumedToken(): String? = consumed

    companion object {
        /**
         * Length-prefixed, same shape as [CompanionNavigator]'s chat tokens: the
         * harness's ids are opaque, so a chosen separator would be a guess about
         * what they cannot contain.
         */
        fun tokenOf(target: NotificationTarget): String =
            "${target.botId.length}:${target.botId}${target.threadId}"

        fun parseToken(raw: String?): NotificationTarget? {
            if (raw.isNullOrEmpty()) return null
            val mark = raw.indexOf(':')
            if (mark <= 0) return null
            val length = raw.substring(0, mark).toIntOrNull() ?: return null
            val start = mark + 1
            if (length < 0 || start + length > raw.length) return null
            return NotificationTarget.from(
                raw.substring(start, start + length),
                raw.substring(start + length),
            )
        }
    }
}
