package com.astra.companion.lifecycle

import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.util.concurrent.atomic.AtomicReference

/**
 * The anchor for one linger window: an ordinary started service that exists
 * only so the process is a *service* process rather than a `cached` one while
 * the window is open.
 *
 * It hosts nothing. No second [com.astra.companion.core.Session], no
 * socket, no thread, no I/O, no binder, no notification of its own. The stream
 * it protects is the one already running in this process.
 *
 * Deliberately **not** a foreground service: no `startForeground`, no
 * `foregroundServiceType`, no FGS permission. Since API 26 an app that has just
 * left the foreground keeps a grace window of several minutes in which a plain
 * background service may run, and twenty-five seconds is far inside that
 * intent. On API 34 the point is narrower still: work in a cached process is
 * blocked shortly after the transition, and a `Service` component is one of the
 * things that keeps the process out of that class.
 *
 * [START_NOT_STICKY] is load-bearing. If the process dies mid-window the socket
 * and the in-memory cursor die with it; recreating a process to finish an old
 * timer would restore neither, so there is nothing worth restarting for.
 */
class SessionLingerService : Service() {
    private var token = NO_TOKEN

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val supplied = intent?.getLongExtra(EXTRA_TOKEN, NO_TOKEN) ?: NO_TOKEN
        if (supplied != NO_TOKEN) token = supplied
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        val destroyed = token
        token = NO_TOKEN
        super.onDestroy()
        if (destroyed != NO_TOKEN) watcher.get()?.onAnchorDestroyed(destroyed)
    }

    /**
     * Told whenever the service goes away, whether the coordinator asked for it
     * or the system reclaimed it. The coordinator tells the two apart by token.
     */
    fun interface Watcher {
        fun onAnchorDestroyed(token: Long)
    }

    companion object {
        const val EXTRA_TOKEN = "com.astra.companion.linger.TOKEN"
        const val NO_TOKEN = 0L

        // Android constructs Services itself, so the hand-off has to be
        // process-static. It holds one application-scoped coordinator, which
        // outlives every window anyway.
        private val watcher = AtomicReference<Watcher?>(null)

        fun watch(watcher: Watcher?) {
            this.watcher.set(watcher)
        }
    }
}
