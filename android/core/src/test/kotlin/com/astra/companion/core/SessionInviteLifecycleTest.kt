package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield

/**
 * The lifecycle of a one-time pairing invite while an attempt is in flight —
 * the port of `OnboardingTests.swift:164-237`, played through the real
 * [Session] so a deep link arriving mid-redemption is an actual concurrent
 * call rather than a policy table.
 *
 * §6 is what makes this a correctness question and not a nicety. A pairing
 * credential is redeemable once. If a link that arrives during a commit takes
 * the credential slot, the attempt that finishes erases a QR that was never
 * used, and the user has to walk back to the computer for a third one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionInviteLifecycleTest {
    private val first = "omb_pair_" + "1".repeat(43)
    private val second = "omb_pair_" + "2".repeat(43)

    private fun link(credential: String, host: String) =
        "astra://pair?address=$host:8810&token=$credential"

    /** A six-digit invite: retryable, and never burned by a redemption. */
    private fun codeLink(code: String, host: String) =
        "astra://pair?address=$host:8810&code=$code"

    private fun paired(connection: Connection) = PairingOutcome(
        PairResponse(
            token = "device-token",
            device = PairedDevice("d1", "Pixel", 1.0, 1.0),
            serverName = "Mac",
        ),
        connection,
    )

    @Test
    fun aLinkArrivingDuringAnAttemptWaitsInsteadOfTakingTheCredentialSlot() = runTest {
        val redeeming = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val session = session(
            pairOutcomeFn = { _, _, _, _ ->
                redeeming.complete(Unit)
                release.await()
                throw APIError.Transport("the network went away")
            },
        )
        session.awaitRestored()

        session.receivePairingURL(link(first, "192.168.1.2"))
        val invite = assertNotNull(session.pairingInvite.value)
        assertEquals(first, invite.credential)
        // What the pairing screen does with a published invite: it takes it and
        // opens a credential slot for it.
        session.consumePairingInvite()

        val attempt = backgroundScope.async { runCatching { session.pair(invite, "request-1") } }
        redeeming.await()

        session.receivePairingURL(link(second, "192.168.1.9"))
        assertNull(
            session.pairingInvite.value,
            "the second link was published onto the screen while the first credential " +
                "was still being redeemed",
        )

        release.complete(Unit)
        attempt.await()

        // The first attempt is over and this phone is still unconnected, so the
        // link that waited is presented now — with its own computer, not the one
        // that just failed.
        val released = assertNotNull(session.pairingInvite.value)
        assertEquals(second, released.credential)
        assertEquals("192.168.1.9", released.connection.host)
    }

    @Test
    fun aWaitingLinkIsConsumedByASuccessfulPairingAndNeverReturnsAfterUnpair() = runTest {
        val redeeming = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val session = session(
            connectionStore = RecordingConnectionStore(),
            tokenStore = RecordingTokenStore(),
            pairOutcomeFn = { connection, _, _, _ ->
                redeeming.complete(Unit)
                release.await()
                paired(connection)
            },
        )
        session.awaitRestored()

        session.receivePairingURL(link(first, "192.168.1.2"))
        val invite = assertNotNull(session.pairingInvite.value)
        session.consumePairingInvite()

        val attempt = backgroundScope.async { session.pair(invite, "request-1") }
        redeeming.await()
        session.receivePairingURL(link(second, "192.168.1.9"))
        release.complete(Unit)
        attempt.await()

        assertNotNull(session.connection.value)
        assertNull(
            session.pairingInvite.value,
            "a successful pairing left the waiting one-time invite on the screen",
        )

        session.signOutAndAwait()
        assertNull(
            session.pairingInvite.value,
            "the invite that waited during the commit reopened pairing after unpairing",
        )
        advanceUntilIdle()
        assertNull(session.pairingInvite.value)
    }

    @Test
    fun aSuccessfulPairingEmptiesTheQueueBeforeStatusEverCatchesUp() = runTest {
        val session = session(pairOutcomeFn = { connection, _, _, _ -> paired(connection) })
        session.awaitRestored()
        // A six-digit invite: nothing burns it, so only the end of the attempt
        // can take it out of the queue.
        session.receivePairingURL(codeLink("123456", "192.168.1.2"))
        val invite = assertNotNull(session.pairingInvite.value)

        session.pair(invite, "request-1")

        assertNull(
            session.pairingInvite.value,
            "a successful pairing left its one-time invite in the queue",
        )
        // The stream has not started yet, so `status` still says unpaired. The
        // binding is already published, and that alone has to close the race.
        assertIs<Session.Status.Unpaired>(session.status.value)
        assertNotNull(session.connection.value)

        session.receivePairingURL(link(second, "192.168.1.9"))

        assertNotNull(
            session.pairingInvite.value,
            "a paired phone may add another computer without replacing the live one yet",
        )
    }

    @Test
    fun aWaitingLinkWhoseCredentialWasBurnedIsNotPresentedWhenTheAttemptEnds() = runTest {
        val redeeming = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val session = session(
            pairOutcomeFn = { _, _, _, _ ->
                redeeming.complete(Unit)
                release.await()
                throw APIError.Status(401, "pairing expired")
            },
        )
        session.awaitRestored()

        session.receivePairingURL(link(first, "192.168.1.2"))
        val invite = assertNotNull(session.pairingInvite.value)
        session.consumePairingInvite()

        val attempt = backgroundScope.async { runCatching { session.pair(invite, "request-1") } }
        redeeming.await()
        // The same QR scanned twice: the copy that waits is the credential the
        // attempt is about to have refused and burned.
        session.receivePairingURL(link(first, "10.0.0.5"))
        release.complete(Unit)
        attempt.await()

        assertNull(
            session.pairingInvite.value,
            "a credential the computer had already refused came back as a fresh invite",
        )
    }

    @Test
    fun unpairingEmptiesTheInviteQueue() = runTest {
        val session = session()
        session.awaitRestored()
        session.receivePairingURL(link(first, "192.168.1.2"))
        assertNotNull(session.pairingInvite.value)

        session.signOutAndAwait()

        assertNull(session.pairingInvite.value, "unpairing left a one-time invite in the queue")
    }

    @Test
    fun theFireAndForgetUnpairEmptiesTheInviteQueueToo() = runTest {
        val session = session()
        session.awaitRestored()
        session.receivePairingURL(link(first, "192.168.1.2"))
        assertNotNull(session.pairingInvite.value)

        session.signOut()
        // `signOut` unpairs from a launched coroutine, and `backgroundScope` work
        // only runs while the test body is suspended.
        yield()
        advanceUntilIdle()

        assertNull(session.pairingInvite.value, "unpairing left a one-time invite in the queue")
    }

    /**
     * The sequence that makes the *ordering* of sign-out load-bearing.
     *
     * A link arrives while an attempt is redeeming, so it waits in memory. The
     * unpair is started while that attempt still holds `gate`, so its critical
     * section queues behind it. The attempt then fails — the one moment a
     * waiting invite is published — and only after that does the unpair get the
     * lock. Emptying the queue anywhere earlier than inside that lock would
     * leave the released invite on a phone with no pairing at all: the user
     * would be shown a one-time QR belonging to the binding they just gave up,
     * and be sent back to the computer when it fails.
     */
    private suspend fun TestScope.aDeferredInviteBehindAFailingAttempt(): DeferredInviteScene {
        val redeeming = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val session = session(
            pairOutcomeFn = { _, _, _, _ ->
                redeeming.complete(Unit)
                release.await()
                throw APIError.Transport("the network went away")
            },
        )
        session.awaitRestored()
        session.receivePairingURL(link(first, "192.168.1.2"))
        val invite = assertNotNull(session.pairingInvite.value)
        session.consumePairingInvite()

        val attempt = backgroundScope.async { runCatching { session.pair(invite, "request-1") } }
        redeeming.await()
        // Waits in memory; `aLinkArrivingDuringAnAttemptWaits…` is what proves
        // this one really is released when the attempt ends.
        session.receivePairingURL(link(second, "192.168.1.9"))
        return DeferredInviteScene(session, attempt, release)
    }

    @Test
    fun anUnpairWaitingOnTheGateTakesTheInviteThatAttemptReleases() = runTest {
        val scene = aDeferredInviteBehindAFailingAttempt()

        val unpaired = backgroundScope.async { scene.session.signOutAndAwait() }
        // Let the unpair reach `gate` and queue behind the attempt.
        yield()
        assertFalse(unpaired.isCompleted, "the unpair did not queue behind the running attempt")

        scene.release.complete(Unit)
        scene.attempt.await()
        unpaired.await()

        assertNull(
            scene.session.pairingInvite.value,
            "the invite released by the failing attempt outlived the unpair queued behind it",
        )
    }

    @Test
    fun theFireAndForgetUnpairAlsoTakesTheInviteReleasedBehindIt() = runTest {
        val scene = aDeferredInviteBehindAFailingAttempt()

        scene.session.signOut()
        // `signOut` unpairs from a launched coroutine, and `backgroundScope` work
        // only runs while the test body is suspended.
        yield()

        scene.release.complete(Unit)
        scene.attempt.await()
        yield()
        advanceUntilIdle()

        assertNull(
            scene.session.pairingInvite.value,
            "the invite released by the failing attempt outlived the unpair queued behind it",
        )
    }

    private fun TestScope.session(
        connectionStore: ConnectionStore = RecordingConnectionStore(),
        tokenStore: TokenStore = RecordingTokenStore(),
        pairOutcomeFn: suspend (Connection, String, String, String) -> PairingOutcome =
            { _, _, _, _ -> error("pair not expected") },
    ): Session = Session(
        scope = backgroundScope,
        connectionStore = connectionStore,
        tokenStore = tokenStore,
        onboardingStore = InMemoryOnboardingStore(),
        deviceNameProvider = { "Pixel" },
        clientFactory = { connection, token -> CompanionClient(connection, token) },
        pairFn = pairOutcomeFn,
        eventsFn = { _, _, _ -> emptyFlow() },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        metadataFn = { throw APIError.Status(404) },
    )
}

/** An attempt still redeeming, with a link already waiting behind it. */
private class DeferredInviteScene(
    val session: Session,
    val attempt: Deferred<Result<Unit>>,
    val release: CompletableDeferred<Unit>,
)

private class RecordingConnectionStore : ConnectionStore {
    var saved: Connection? = null
    override suspend fun load(): Connection? = saved
    override suspend fun save(connection: Connection) {
        saved = connection
    }
    override suspend fun clear() {
        saved = null
    }
}

private class RecordingTokenStore : TokenStore {
    private val saved = linkedMapOf<String, String>()
    override suspend fun save(connectionId: String, token: String) {
        saved[connectionId] = token
    }
    override suspend fun read(connectionId: String): TokenStore.ReadResult =
        saved[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing
    override suspend fun remove(connectionId: String) {
        saved.remove(connectionId)
    }
}
