package com.openmausbot.companion.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.openmausbot.companion.R
import com.openmausbot.companion.core.NotificationFrame
import com.openmausbot.companion.core.NotificationSink

/**
 * Local-only notifications from live/replayed notify frames. No FCM.
 * PendingIntent carries both `botId` and `threadId` — the same pair iOS puts
 * in `userInfo` — so a tap opens the exact task (the one allowed quality
 * delta vs iOS, which only presents the banner).
 */
class LocalNotificationPoster(
    context: Context,
) : NotificationSink {
    private val appContext = context.applicationContext
    private val manager = NotificationManagerCompat.from(appContext)

    init {
        ensureChannels()
    }

    override fun deliver(notification: NotificationFrame, sequence: Int?) {
        if (!canPost()) return
        val channelId = NotificationMapping.channelId(notification)
        // Identity lives in Intent data (botId + threadId), not a hashed
        // requestCode — extras alone cannot distinguish PendingIntents.
        val intent = NotificationIntents.contentIntent(appContext, notification)
        val pending = PendingIntent.getActivity(
            appContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // The shade is SystemUI's window, so the app's reading-direction policy
        // has to travel inside the string. See NotificationText.
        val title = NotificationText.anchored(notification.title)
        val body = NotificationText.anchored(notification.body)
        val builder = NotificationCompat.Builder(appContext, channelId)
            // The app's own mark, monochrome as the status bar requires.
            .setSmallIcon(R.drawable.ic_maus_mark)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setNumber(lastBadge)
            .setPriority(
                if (NotificationMapping.isHighImportance(notification)) {
                    NotificationCompat.PRIORITY_HIGH
                } else {
                    NotificationCompat.PRIORITY_DEFAULT
                },
            )
            .setCategory(
                if (notification.isBlocking) NotificationCompat.CATEGORY_ALARM
                else NotificationCompat.CATEGORY_STATUS,
            )
        try {
            manager.notify(NotificationMapping.dedupeId(notification, sequence), 0, builder.build())
        } catch (_: SecurityException) {
            // Permission can be revoked between canPost() and notify(). A missed
            // local banner is safer than crashing the live companion session.
        }
    }

    override fun setBadge(count: Int) {
        // No universal launcher-badge API without a posted notification. Unread
        // count is attached via setNumber on real notify posts; badge-only updates
        // are a no-op so we never leave a phantom notification in the shade.
        lastBadge = maxOf(0, count)
    }

    @Volatile
    var lastBadge: Int = 0
        private set

    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val system = appContext.getSystemService(NotificationManager::class.java) ?: return
        val blocking = NotificationChannel(
            NotificationMapping.CHANNEL_BLOCKING,
            appContext.getString(R.string.notification_channel_blocking),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = appContext.getString(R.string.notification_channel_blocking_desc)
        }
        val done = NotificationChannel(
            NotificationMapping.CHANNEL_DONE,
            appContext.getString(R.string.notification_channel_done),
            // HIGH so this pops up (heads-up banner + lock screen) with sound,
            // the way a normal messaging app does — DEFAULT only shows quietly
            // in the shade. Kate's ask (2026-09-08): every bot message, not just
            // approvals, should read as "interesting app noise" rather than sit
            // unnoticed until she happens to pull the shade down.
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = appContext.getString(R.string.notification_channel_done_desc)
        }
        // The old channel this replaced. Deleting it (rather than leaving it
        // orphaned) keeps Settings -> App notifications from showing a dead
        // "Finished work" entry alongside the new one; harmless no-op if it was
        // never created on this install.
        system.deleteNotificationChannel(LEGACY_CHANNEL_DONE)
        val routine = NotificationChannel(
            NotificationMapping.CHANNEL_ROUTINE_FAILED,
            appContext.getString(R.string.notification_channel_routine),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = appContext.getString(R.string.notification_channel_routine_desc)
        }
        system.createNotificationChannels(listOf(blocking, done, routine))
    }

    /** True when the platform will accept a notification post right now. */
    fun canPost(): Boolean {
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(
            appContext,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /** True when a runtime POST_NOTIFICATIONS request is still required. */
    fun needsNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT >= 33 && !canPost()

    companion object {
        const val EXTRA_THREAD_ID = "openmaus.threadId"
        const val EXTRA_BOT_ID = "openmaus.botId"
        const val EXTRA_KIND = "openmaus.kind"

        /** Permission string for the UI pass's launcher contract. */
        const val POST_NOTIFICATIONS_PERMISSION = Manifest.permission.POST_NOTIFICATIONS

        /** The channel id [NotificationMapping.CHANNEL_DONE] replaced. See its kdoc. */
        private const val LEGACY_CHANNEL_DONE = "done"
    }
}
