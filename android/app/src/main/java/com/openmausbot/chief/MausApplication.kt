package com.openmausbot.chief

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.openmausbot.chief.data.NotificationDeduper
import com.openmausbot.chief.data.NotificationPayload
import com.openmausbot.chief.data.NotificationMirrorWorker
import com.openmausbot.chief.data.SharedPreferencesNotificationDedupeStore
import com.openmausbot.chief.data.CrashDiagnostics

class MausApplication : Application() {
    val notificationDeduper by lazy { NotificationDeduper(store = SharedPreferencesNotificationDedupeStore(this)) }
    val crashDiagnostics by lazy { CrashDiagnostics(this) }

    override fun onCreate() {
        super.onCreate()
        installCrashDiagnostics()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                ALERT_CHANNEL,
                "Agent alerts",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Approvals, questions, completed work, and failed routines" },
        )
        NotificationMirrorWorker.schedule(this)
        NotificationMirrorWorker.scheduleHeartbeat(this)
    }

    private fun installCrashDiagnostics() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            crashDiagnostics.record(throwable)
            previous?.uncaughtException(thread, throwable)
        }
    }

    /** Render one validated notification from either SSE or FCM. */
    fun showNotification(payload: NotificationPayload) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val openThread = PendingIntent.getActivity(
            this,
            payload.threadId.hashCode(),
            Intent(this, MainActivity::class.java)
                .putExtra("threadId", payload.threadId)
                .putExtra("botId", payload.botId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, ALERT_CHANNEL)
            .setSmallIcon(com.openmausbot.chief.R.drawable.ic_notification_centipede)
            .setContentTitle(payload.title.ifBlank { payload.botName })
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setContentIntent(openThread)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        getSystemService(NotificationManager::class.java).notify(payload.threadId.hashCode(), notification)
    }

    /** Shared replay protection for the live stream and FCM delivery paths. */
    fun showNotificationOnce(payload: NotificationPayload): Boolean {
        val key = payload.id?.takeIf { it.isNotBlank() }
            ?: listOf(payload.kind, payload.botId, payload.threadId, payload.title, payload.body).joinToString("\u001f")
        if (!notificationDeduper.accept(key)) return false
        showNotification(payload)
        return true
    }

    companion object { const val ALERT_CHANNEL = "chief-alerts" }
}
