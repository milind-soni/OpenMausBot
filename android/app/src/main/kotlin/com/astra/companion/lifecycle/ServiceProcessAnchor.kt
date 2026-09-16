package com.astra.companion.lifecycle

import android.content.Context
import android.content.Intent

/**
 * The production [SessionLingerController.ProcessAnchor]: starts and stops
 * [SessionLingerService].
 *
 * A refused start is a normal outcome, not a crash. From API 26 the system
 * rejects `startService` once the app is past its post-foreground grace window,
 * and the manufacturer may be stricter still; the coordinator treats a refusal
 * exactly like an expired iOS background-task assertion and disconnects at once.
 */
class ServiceProcessAnchor(context: Context) : SessionLingerController.ProcessAnchor {
    private val appContext = context.applicationContext

    override fun attach(controller: SessionLingerController) {
        SessionLingerService.watch { token -> controller.onAnchorLost(token) }
    }

    override fun start(token: Long): Boolean = try {
        val intent = Intent(appContext, SessionLingerService::class.java)
            .putExtra(SessionLingerService.EXTRA_TOKEN, token)
        appContext.startService(intent) != null
    } catch (error: IllegalStateException) {
        // "Not allowed to start service ...: app is in background" (API 26+).
        false
    } catch (error: SecurityException) {
        false
    }

    override fun stop(token: Long) {
        try {
            appContext.stopService(Intent(appContext, SessionLingerService::class.java))
        } catch (error: IllegalStateException) {
            // Already gone; the coordinator's own bookkeeping is the truth.
        } catch (error: SecurityException) {
        }
    }
}
