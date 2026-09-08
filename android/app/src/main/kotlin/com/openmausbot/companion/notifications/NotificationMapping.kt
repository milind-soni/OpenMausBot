package com.openmausbot.companion.notifications

import com.openmausbot.companion.core.NotificationFrame

/**
 * Pure mapping from companion notify frames to Android channel + dedupe id.
 * JVM-testable; [LocalNotificationPoster] is the Android glue.
 */
object NotificationMapping {
    const val CHANNEL_BLOCKING = "approval_question"
    /**
     * A new channel id, not "done": Android locks a channel's importance the
     * moment it is first created on a device — an app can never raise it later,
     * only the user can, in system Settings. "done" already exists at DEFAULT
     * importance on every phone with an older build installed, so making bot
     * replies pop up like a normal message (Kate's ask, 2026-09-08) requires a
     * fresh channel id rather than reconfiguring this one.
     */
    const val CHANNEL_DONE = "bot_messages"
    const val CHANNEL_ROUTINE_FAILED = "routine_failed"

    fun channelId(notification: NotificationFrame): String = when (notification.kind) {
        "approval", "question" -> CHANNEL_BLOCKING
        "routine-failed" -> CHANNEL_ROUTINE_FAILED
        else -> CHANNEL_DONE
    }

    /** Matches iOS: `openmaus.{threadId}.{seq}` (title fallback when seq is null). */
    fun dedupeId(notification: NotificationFrame, sequence: Int?): String {
        val suffix = sequence?.toString() ?: notification.title
        return "openmaus.${notification.threadId}.$suffix"
    }

    fun isHighImportance(notification: NotificationFrame): Boolean = notification.isBlocking
}
