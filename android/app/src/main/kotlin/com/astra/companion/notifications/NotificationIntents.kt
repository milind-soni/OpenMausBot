package com.astra.companion.notifications

import android.content.Intent
import android.net.Uri
import com.astra.companion.MainActivity
import com.astra.companion.core.NotificationFrame
import com.astra.companion.core.NotificationTarget

/**
 * The two ids a notification tap carries — the same pair iOS reads from
 * `userInfo` in `Notifications.swift:65-69`. Both are required; a partial
 * extra is not a destination.
 */
fun Intent.notificationTarget(): NotificationTarget? =
    NotificationTarget.from(
        getStringExtra(LocalNotificationPoster.EXTRA_BOT_ID),
        getStringExtra(LocalNotificationPoster.EXTRA_THREAD_ID),
    )

/**
 * Filterable identity for notification content Intents.
 *
 * PendingIntent equality uses request code plus Intent.filterEquals fields
 * (action, data, type, package, component, categories) — **extras do not
 * participate**. Putting `botId` and `threadId` only in extras lets two
 * notifications for the same room thread, or two thread ids whose
 * `String.hashCode()` collide, share one PendingIntent and overwrite each
 * other's target under `FLAG_UPDATE_CURRENT`.
 *
 * The data URI below is the unambiguous discriminator; it is never hashed.
 */
object NotificationIntents {
    const val ACTION_OPEN = "com.astra.companion.OPEN_NOTIFICATION"

    /**
     * Stable, unhashed identity string for [android.content.Intent.setData].
     * Distinct for every `(botId, threadId)` pair — including UUID strings
     * that collide under 32-bit [String.hashCode].
     */
    fun contentIdentity(botId: String, threadId: String): String =
        "openmaus://notification/${encode(botId)}/${encode(threadId)}"

    fun contentUri(botId: String, threadId: String): Uri =
        Uri.parse(contentIdentity(botId, threadId))

    fun contentIntent(
        packageContext: android.content.Context,
        notification: NotificationFrame,
    ): Intent = Intent(packageContext, MainActivity::class.java).apply {
        action = ACTION_OPEN
        data = contentUri(notification.botId, notification.threadId)
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        putExtra(LocalNotificationPoster.EXTRA_THREAD_ID, notification.threadId)
        putExtra(LocalNotificationPoster.EXTRA_BOT_ID, notification.botId)
        putExtra(LocalNotificationPoster.EXTRA_KIND, notification.kind)
    }

    /** Android's URI encoder is available throughout this app's API range. */
    private fun encode(value: String): String = Uri.encode(value)
}
