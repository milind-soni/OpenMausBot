package com.openmausbot.companion.lifecycle

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.openmausbot.companion.OpenMausApp
import com.openmausbot.companion.R

/**
 * The opt-in counterpart to [SessionLingerService]: instead of a short window
 * after the app leaves the screen, this holds the process out of the `cached`
 * class indefinitely, so a notify frame that arrives with the app fully closed
 * still reaches [com.openmausbot.companion.notifications.LocalNotificationPoster].
 *
 * Deliberately a real foreground service — `startForeground` with a visible,
 * silent, ongoing notification — because that is the one supported way to ask
 * Android for a background process that outlives [SessionLingerController]'s
 * 25-second grace window. The persistent notification is the cost of that; it
 * is not a bug to hide.
 *
 * `stopWithTask="false"` in the manifest is load-bearing: the whole point is
 * surviving the user swiping the app away, which is the opposite of
 * [SessionLingerService]'s `stopWithTask="true"`.
 *
 * `START_STICKY`: if the OS still kills this under memory pressure despite the
 * foreground grant, it restarts with a null Intent and `onStartCommand` runs
 * the same setup again — connect() is idempotent (`Session.kt` only opens a
 * stream when `client == null || streamJob == null`), so a restart is a no-op
 * beyond re-asserting the flag and the notification.
 */
class AlwaysOnConnectionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        AlwaysOnConnectionState.active = true
        val app = application as OpenMausApp
        // Closes the race where the toggle turns this on and the app
        // backgrounds before this callback runs: SessionLingerController may
        // already have opened its own 25s window, whose timer would otherwise
        // disconnect the session this service now depends on staying open.
        app.linger.onAlwaysOnStarted()
        app.session.connect()
        return START_STICKY
    }

    override fun onDestroy() {
        AlwaysOnConnectionState.active = false
        super.onDestroy()
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_maus_mark)
            .setContentTitle(getString(R.string.always_on_notification_title))
            .setContentText(getString(R.string.always_on_notification_text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val system = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_always_on),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_always_on_desc)
            setShowBadge(false)
        }
        system.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "always_on_status"
        const val NOTIFICATION_ID = 1

        /** Idempotent: `ContextCompat.startForegroundService` is safe to call while already running. */
        fun start(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(
                context,
                Intent(context, AlwaysOnConnectionService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AlwaysOnConnectionService::class.java))
        }
    }
}
