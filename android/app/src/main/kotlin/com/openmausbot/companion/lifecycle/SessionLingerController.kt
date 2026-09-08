package com.openmausbot.companion.lifecycle

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Holds the SSE stream open for a grace period after the process leaves the
 * screen, so a turn that finishes just after Home still reaches the
 * notification sink.
 *
 * This is the Android counterpart of `Session.linger()` in
 * `ios/App/Session.swift:344-361`, called from `scenePhase == .background` in
 * `ios/App/CompanionApp.swift:26`. iOS buys the time with
 * `beginBackgroundTask`; Android has no equivalent, so the window is anchored
 * by an ordinary started [ProcessAnchor] (see `SessionLingerService`) and timed
 * by a cancellable coroutine on the app scope.
 *
 * Neither platform *guarantees* the window. iOS may have the assertion expired
 * early; Android may have the anchoring service destroyed under memory
 * pressure, or the process killed outright. In both cases the window ends and
 * recovery falls back to the normal foreground reconnect.
 *
 * The delay lives here, in `:app`, rather than in [Session]: it is a policy
 * about this platform's process lifecycle. `Session.disconnect()` stays exactly
 * what it was — an immediate cancel of `streamJob` — and this coordinator is
 * its only caller in production. Sign-out, refresh and the screen watcher never
 * went through it: they cancel and restart the stream themselves
 * (`Session.kt:253`, `:357`, `:417`), and none of them may acquire this delay.
 *
 * **Main-thread confined.** Lifecycle callbacks, [onAnchorLost] (delivered from
 * `Service.onDestroy`) and the timer coroutine all run on the same
 * `Dispatchers.Main.immediate` scope, so the generation bookkeeping below needs
 * no locking.
 */
class SessionLingerController(
    private val session: Session,
    private val scope: CoroutineScope,
    private val anchor: ProcessAnchor,
    /**
     * True while [AlwaysOnConnectionService] is holding the process open on its
     * own. Defaults to "never" so every existing caller/test is unaffected;
     * production wires it to [AlwaysOnConnectionState.active].
     */
    private val alwaysOn: () -> Boolean = { false },
) : DefaultLifecycleObserver {

    /**
     * Whatever keeps the process out of the `cached` class for one window.
     *
     * Production is a started [SessionLingerService]; tests substitute this and
     * nothing else, so the real [Session], the real `delay` and the real SSE
     * collection stay under test.
     */
    interface ProcessAnchor {
        /** Where to report an anchor the system took away. Called once, at install. */
        fun attach(controller: SessionLingerController)

        /** @return false when the anchor could not be taken — there is no window. */
        fun start(token: Long): Boolean

        fun stop(token: Long)
    }

    /**
     * Identifies the current trip to the background. A timer, or a late
     * `onDestroy` from a previous trip, may only act on the token it was
     * created with — comparing "is there a job?" is not enough for two quick
     * trips, which is the race the iOS sleeper still has (it keeps no identity
     * of its own, so an old sleeper can close a newer window early).
     */
    private var openToken: Long? = null
    private var nextToken = 1L
    private var timer: Job? = null
    private var foreground = false

    /** The token of the window currently open, or null. Test/diagnostic read. */
    val openWindow: Long? get() = openToken

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
        // Invalidate before stopping the anchor: the resulting onDestroy must
        // not be able to disconnect the stream we are about to keep.
        val closing = openToken
        openToken = null
        timer?.cancel()
        timer = null
        if (closing != null) anchor.stop(closing)
        // connect() finds streamJob != null when the window kept it, and opens
        // nothing; it only opens a stream when the window had already closed.
        session.connect()
    }

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
        // AlwaysOnConnectionService is already holding the process open for as
        // long as the user left it enabled — this window would only ever be
        // redundant (service still running) or premature (service between
        // onDestroy and its own restart), so skip it entirely rather than race it.
        if (alwaysOn()) return
        if (openToken != null) return
        if (!worthHolding()) {
            session.disconnect()
            return
        }
        val token = nextToken++
        openToken = token
        if (!anchor.start(token)) {
            // No anchor, no window: end it the way iOS's expiration handler does.
            openToken = null
            session.disconnect()
            return
        }
        timer = scope.launch {
            delay(WINDOW_MILLIS)
            if (openToken != token || foreground) return@launch
            session.disconnect()
            openToken = null
            timer = null
            anchor.stop(token)
        }
    }

    /**
     * The system destroyed the anchoring service before the deadline. Only the
     * token that is still current may end the window — a destroy that arrives
     * after a return to the foreground, or from an earlier trip, is a no-op.
     */
    fun onAnchorLost(token: Long) {
        if (openToken != token) return
        openToken = null
        timer?.cancel()
        timer = null
        if (foreground) return
        session.disconnect()
    }

    /**
     * [AlwaysOnConnectionService] just took over holding the process open.
     * `alwaysOn()` only stops a *new* trip from opening its own window
     * ([onStop]); it does not reach one already in flight when the service
     * races it — the toggle can be flipped on and the app backgrounded before
     * `onStartCommand` runs, opening a window here first. Left alone, that
     * window's own timer would call `session.disconnect()` at its 25s deadline
     * out from under the service that now depends on the same connection. Tear
     * it down without touching the session, which the service owns from here.
     */
    fun onAlwaysOnStarted() {
        val token = openToken ?: return
        openToken = null
        timer?.cancel()
        timer = null
        anchor.stop(token)
    }

    /**
     * Whether this background trip can plausibly still receive frames.
     *
     * Status alone is not enough: right after a successful pairing there is a
     * short window where the client exists but the status is still `Unpaired`,
     * and a restore that is still `Pending` may be about to produce a stream.
     * Only a session that is definitively unbound, or terminally
     * [Session.Status.Unauthorized], is refused — which also keeps the anchor
     * (and with it the process, and `NsdDiscovery`'s multicast lock) off the
     * pairing screen.
     */
    private fun worthHolding(): Boolean {
        val status = session.status.value
        if (status is Session.Status.Unauthorized) return false
        val restore = session.restoreState.value
        if (restore is Session.RestoreState.Pending) return true
        val unbound = restore is Session.RestoreState.Unpaired &&
            session.connection.value == null &&
            status is Session.Status.Unpaired
        return !unbound
    }

    companion object {
        /** Matches `Task.sleep(for: .seconds(25))` in `ios/App/Session.swift:351`. */
        const val WINDOW_MILLIS = 25_000L
    }
}

/**
 * The single production wiring of the linger: build the coordinator, tell the
 * anchor where to report a lost service, and register the coordinator itself as
 * the process-lifecycle observer.
 *
 * `OpenMausApp` calls exactly this, and the wiring test drives exactly this
 * against a `LifecycleRegistry`, so the state machine cannot pass while the
 * Application still cancels the stream in `onStop`.
 */
internal fun installSessionLinger(
    lifecycle: Lifecycle,
    session: Session,
    scope: CoroutineScope,
    anchor: SessionLingerController.ProcessAnchor,
    alwaysOn: () -> Boolean = { false },
): SessionLingerController {
    val controller = SessionLingerController(session, scope, anchor, alwaysOn)
    anchor.attach(controller)
    lifecycle.addObserver(controller)
    return controller
}
