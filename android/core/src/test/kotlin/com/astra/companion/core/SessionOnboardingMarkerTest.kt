package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.yield
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * The first-pair education marker, as a real [Session] writes it.
 *
 * [OnboardingTest] pins the ordering rule on [PairingCommitSequence] in
 * isolation, which proves the sequence and nothing about who calls it. These
 * drive an actual pairing and an actual unpair through `Session` and read back
 * the order the stores were touched in, so a `pair` that stopped calling the
 * sequence — or called it around the wrong writes — fails here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionOnboardingMarkerTest {

    /** Every durable write, in the order it happened, across all three stores. */
    private class WriteLog {
        val entries = mutableListOf<String>()
        fun record(entry: String) {
            entries += entry
        }
    }

    private class LoggingConnectionStore(
        private val log: WriteLog,
        var saved: Connection? = null,
    ) : ConnectionStore {
        override suspend fun load(): Connection? = saved
        override suspend fun save(connection: Connection) {
            log.record("connection:save")
            saved = connection
        }
        override suspend fun clear() {
            log.record("connection:clear")
            saved = null
        }
    }

    private class LoggingTokenStore(private val log: WriteLog) : TokenStore {
        val tokens = linkedMapOf<String, String>()
        override suspend fun save(connectionId: String, token: String) {
            log.record("token:save")
            tokens[connectionId] = token
        }
        override suspend fun read(connectionId: String): TokenStore.ReadResult =
            tokens[connectionId]?.let(TokenStore.ReadResult::Found)
                ?: TokenStore.ReadResult.Missing
        override suspend fun remove(connectionId: String) {
            log.record("token:remove")
            tokens.remove(connectionId)
        }
    }

    private class LoggingOnboardingStore(
        private val log: WriteLog,
        private var pending: Boolean = false,
    ) : OnboardingStore {
        override suspend fun notificationOnboardingPending(): Boolean = pending
        override suspend fun setNotificationOnboardingPending(pending: Boolean) {
            log.record("onboarding:$pending")
            this.pending = pending
        }
    }

    private val connection = Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810)

    private fun paired(connection: Connection) = PairingOutcome(
        PairResponse(
            token = "device-token",
            device = PairedDevice("d1", "Pixel", 1.0, 1.0),
            serverName = "Mac",
        ),
        connection,
    )

    private fun TestScope.session(
        log: WriteLog,
        connectionStore: ConnectionStore,
        tokenStore: TokenStore,
        onboardingStore: OnboardingStore,
    ): Session = Session(
        scope = backgroundScope,
        connectionStore = connectionStore,
        tokenStore = tokenStore,
        onboardingStore = onboardingStore,
        deviceNameProvider = { "Pixel" },
        clientFactory = { c, token -> CompanionClient(c, token) },
        pairFn = { c, _, _, _ -> paired(c) },
        eventsFn = { _, _, _ -> emptyFlow() },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        metadataFn = { throw APIError.Status(404) },
    )

    @Test
    fun aNewPairingWritesTheMarkerBeforeTheConnectionIsRestorable() = runTest {
        val log = WriteLog()
        val connections = LoggingConnectionStore(log)
        val onboarding = LoggingOnboardingStore(log)
        val session = session(log, connections, LoggingTokenStore(log), onboarding)
        session.awaitRestored()

        session.pair(connection, "123456", "pair-request-1")
        advanceUntilIdle()

        assertEquals(
            listOf("token:save", "onboarding:true", "connection:save"),
            log.entries,
            "the marker must land before the connection can be restored without it",
        )
        assertTrue(onboarding.notificationOnboardingPending())
    }

    @Test
    fun anExistingPairingIsNeverGivenRetroactiveEducation() = runTest {
        val log = WriteLog()
        val tokens = LoggingTokenStore(log).apply { tokens["c1"] = "device-token" }
        val onboarding = LoggingOnboardingStore(log)
        val session = session(
            log,
            LoggingConnectionStore(log, saved = connection),
            tokens,
            onboarding,
        )
        session.awaitRestored()
        advanceUntilIdle()

        assertEquals(Session.RestoreState.Ready, session.restoreState.value)
        assertFalse(
            onboarding.notificationOnboardingPending(),
            "restoring a pairing that already existed is not a first pairing",
        )
        assertFalse(
            log.entries.any { it.startsWith("onboarding:") },
            "restore wrote the marker: ${log.entries}",
        )
    }

    @Test
    fun unpairingClearsTheMarker() = runTest {
        val log = WriteLog()
        val onboarding = LoggingOnboardingStore(log)
        val session = session(log, LoggingConnectionStore(log), LoggingTokenStore(log), onboarding)
        session.awaitRestored()
        session.pair(connection, "123456", "pair-request-1")
        advanceUntilIdle()
        assertTrue(onboarding.notificationOnboardingPending())

        session.signOutAndAwait()
        advanceUntilIdle()

        assertFalse(
            onboarding.notificationOnboardingPending(),
            "an unpair that leaves the marker hands the next pairing a step it did not earn",
        )
    }

    @Test
    fun theFireAndForgetUnpairClearsTheMarkerToo() = runTest {
        val log = WriteLog()
        val onboarding = LoggingOnboardingStore(log)
        val session = session(log, LoggingConnectionStore(log), LoggingTokenStore(log), onboarding)
        session.awaitRestored()
        session.pair(connection, "123456", "pair-request-1")
        advanceUntilIdle()

        // `signOut` unpairs from a launched coroutine, and `backgroundScope`
        // work only runs while the test body is suspended.
        session.signOut()
        yield()
        advanceUntilIdle()

        assertFalse(
            onboarding.notificationOnboardingPending(),
            "writes seen: ${'$'}{log.entries}",
        )
    }
}
