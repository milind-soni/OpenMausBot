package org.openmausbot.android.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.openmausbot.android.MainActivity
import org.openmausbot.android.R
import org.openmausbot.android.data.Repo

object Notifier {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_LIVE = "live"
    const val LIVE_ID = 41

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, "Bot 消息", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "来自 Bot 的回复、审批和提问"
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LIVE, "连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "在应用处于后台时保持与电脑的连接"
                setShowBadge(false)
            }
        )
    }

    fun live(context: Context, serverName: String): Notification {
        val open = PendingIntent.getActivity(
            context, 0, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("OpenMausBot")
            .setContentText("已连接 $serverName")
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(open)
            .build()
    }

    fun message(context: Context, payload: Repo.NotificationPayload) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val intent = Intent(context, MainActivity::class.java).apply {
            payload.threadId?.let { putExtra("threadId", it) }
            payload.botId?.let { putExtra("botId", it) }
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            (payload.threadId ?: payload.title).hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        manager.notify((payload.threadId ?: payload.title).hashCode(), notification)
    }
}
