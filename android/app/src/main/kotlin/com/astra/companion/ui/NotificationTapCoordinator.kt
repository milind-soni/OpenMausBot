package com.astra.companion.ui

import com.astra.companion.core.Chat
import com.astra.companion.core.NotificationTarget
import com.astra.companion.core.Session
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Sequences a notification tap through resolve → navigate → consume.
 *
 * The raw [PendingThreadNavigation] target and the resolved [Chat] are two
 * layers of the same destination. Consuming the raw target before the
 * navigator records the chat leaves a window where a recreation saves
 * "consumed", loses the transient chat, and restores the roster — the tap
 * disappears. Holding the chat across a bond change leaves a window where
 * Unpaired / Unauthorized drops [PairedScreen] but the parent still opens
 * that chat against the next pairing.
 *
 * This coordinator **owns** every consume:
 * - [commit] is the only way from a resolved chat to both record the
 *   persistable stack and consume the raw target (navigate then consume).
 * - [onPending] itself performs the identified consume for the definitive
 *   no-chat case (unpaired / unauthorized / failure). Callers never choose
 *   which overload of consume to fire.
 *
 * Each resolution carries a generation so a stale callback from tap A cannot
 * consume tap B after `onNewIntent` replaced the pending target.
 *
 * RootScreen drives it; tests exercise [onPending]/[commit] directly. The
 * module has neither Robolectric nor compose-ui-test — mounting
 * [CompanionRoot] would need both plus a full [CompanionEnvironment]. Because
 * the coordinator performs the order itself, JVM tests observe
 * `navigate(A) → consume(A)` without a composition harness.
 */
class NotificationTapCoordinator {
    /**
     * A resolved tap, identified so [commit] can reject a callback that
     * belongs to another generation / target.
     */
    data class Resolution(
        val generation: Long,
        val chat: Chat,
        val target: NotificationTarget,
    )

    private var nextGeneration = 0L
    private val _resolution = MutableStateFlow<Resolution?>(null)
    val resolution: StateFlow<Resolution?> = _resolution.asStateFlow()

    /**
     * Resolve [target] through [NotificationOpen].
     *
     * When the outcome is definitive and there is no chat (unpaired /
     * unauthorized / failure), this method itself calls [consume] with the
     * identified target — RootScreen cannot omit or reorder that step. A
     * non-null resolution waits for [commit]. Deferred restores leave the
     * pending entry untouched.
     *
     * @return true when this call consumed the pending entry (definitive
     *   no-chat). False when a resolution is held for [commit], or when the
     *   open was deferred.
     */
    suspend fun onPending(
        session: Session,
        target: NotificationTarget,
        consume: (NotificationTarget) -> Unit,
    ): Boolean {
        val result = NotificationOpen.open(session, target)
        // Always advance the generation so an in-flight commit for a previous
        // tap cannot succeed after this pending entry replaced it.
        nextGeneration += 1
        _resolution.value = result.chat?.let { chat ->
            Resolution(generation = nextGeneration, chat = chat, target = target)
        }
        val consumeNow = result.consumed && result.chat == null
        if (consumeNow) consume(target)
        return consumeNow
    }

    /** Bond left: drop any resolved destination so it cannot ride into the next pairing. */
    fun discardResolved() {
        nextGeneration += 1
        _resolution.value = null
    }

    /**
     * Single commit: [CompanionNavigator.openFromNotification] then identified
     * consume. Returns false when [expected] is stale (another tap or bond
     * leave replaced it) — in that case neither step runs.
     *
     * The navigator is received here so the order cannot be inverted from
     * RootScreen: there is no separate "consume after resolve" API on the
     * happy path.
     */
    fun commit(
        expected: Resolution,
        navigator: CompanionNavigator,
        consume: (NotificationTarget) -> Unit,
    ): Boolean {
        val current = _resolution.value
        if (current == null || current.generation != expected.generation) return false
        navigator.openFromNotification(current.chat)
        val target = current.target
        _resolution.value = null
        consume(target)
        return true
    }

    companion object {
        /** Statuses where [PairedScreen] is not composed — the bond is gone. */
        fun leavesBond(status: Session.Status): Boolean =
            status is Session.Status.Unpaired || status is Session.Status.Unauthorized
    }
}
