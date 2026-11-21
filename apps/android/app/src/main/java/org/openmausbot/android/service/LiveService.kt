package org.openmausbot.android.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.openmausbot.android.data.Repo
import org.openmausbot.android.notify.Notifier

/** Keeps the process (and the SSE link) alive while the person is elsewhere.
 *  The harness stays authoritative; this only holds the socket open long
 *  enough to raise a notification. */
class LiveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val name = Repo.computer?.serverName ?: Repo.connection.serverName.ifBlank { "你的电脑" }
        val notification = Notifier.live(this, name)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.LIVE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(Notifier.LIVE_ID, notification)
        }
        return START_STICKY
    }

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, LiveService::class.java)
            runCatching {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, LiveService::class.java)) }
        }
    }
}
