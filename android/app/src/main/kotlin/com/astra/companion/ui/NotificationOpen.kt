package com.astra.companion.ui

import com.astra.companion.core.Chat
import com.astra.companion.core.NotificationTarget
import com.astra.companion.core.Session

/**
 * When a notification tap may call [Session.openNotification], and when it must
 * wait — the Activity-side half of `ios/App/Session.swift:797-806`.
 *
 * iOS keeps a `pendingNotification` inside Session while `restorePending` (the
 * keychain still locked after launch restore). Android's Session awaits the
 * first restore attempt, but a locked or unavailable token leaves
 * `client == null` afterward and `openNotification` would show the unpaired
 * error. Holding the target in [PendingThreadNavigation] and deferring here is
 * the queue: nothing is dropped, and nothing races a restore that has not
 * produced a client yet.
 *
 * The defer signal is [Session.restoreState] — never display copy.
 * `RestoreState.Pending` covers every `TokenStore.ReadResult.Unavailable`,
 * locked or not; localising Offline messaging cannot break routing.
 */
object NotificationOpen {

    /**
     * Credential restore still in flight or waiting on secure storage: call
     * [Session.connect] and keep the pending target — do not invoke
     * [Session.openNotification].
     */
    fun shouldDefer(session: Session): Boolean =
        session.restoreState.value is Session.RestoreState.Pending

    /**
     * True when [Session.openNotification] can run without hitting the
     * client-null unpaired branch. Connecting and Live both mean restore
     * already built a client; Offline after a successful restore means the
     * stream dropped but the client remains (iOS still opens in that case).
     */
    fun canOpen(session: Session): Boolean = when (session.status.value) {
        is Session.Status.Connecting,
        is Session.Status.Live,
        -> true
        is Session.Status.Offline ->
            session.connection.value != null && !shouldDefer(session)
        else -> false
    }

    /**
     * @return the chat to navigate to; `null` when the target should stay
     *   pending (restore still locked) or when opening failed for good
     *   (deleted bot, unpaired). [consumed] is true once the pending entry
     *   must not fire again.
     */
    suspend fun open(
        session: Session,
        target: NotificationTarget,
    ): Result {
        if (shouldDefer(session)) {
            session.connect()
            return Result(chat = null, consumed = false)
        }
        if (!canOpen(session)) {
            // Unpaired / unauthorized: do not carry a stale destination into a
            // future pairing — same rule as iOS clearing pending on sign-out.
            return Result(chat = null, consumed = true)
        }
        val chat = session.openNotification(target)
        return Result(chat = chat, consumed = true)
    }

    data class Result(val chat: Chat?, val consumed: Boolean)
}
