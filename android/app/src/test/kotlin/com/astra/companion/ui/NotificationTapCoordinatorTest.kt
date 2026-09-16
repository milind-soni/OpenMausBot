package com.astra.companion.ui

import com.astra.companion.core.Bot
import com.astra.companion.core.BotTask
import com.astra.companion.core.Chat
import com.astra.companion.core.ChatTarget
import com.astra.companion.core.Connection
import com.astra.companion.core.ConnectionStore
import com.astra.companion.core.Fleet
import com.astra.companion.core.InMemoryOnboardingStore
import com.astra.companion.core.ModelSelection
import com.astra.companion.core.NotificationTarget
import com.astra.companion.core.Session
import com.astra.companion.core.TokenStore
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockWebServer

/**
 * Integrated coverage of the resolve → navigate → consume order that
 * [CompanionRoot] drives through [NotificationTapCoordinator.commit].
 *
 * Neither Robolectric nor compose-ui-test is on this module (AGP unit tests
 * here are JVM-only). Mounting the real composition would need both, plus a
 * full [CompanionEnvironment]. Because [NotificationTapCoordinator.commit]
 * receives the navigator and performs navigate then consume itself, these
 * tests observe that order without re-staging it by hand — and fail if the
 * coordinator ever splits the two steps back into caller-owned calls.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationTapCoordinatorTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `consumption cannot precede recorded navigation`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("b1", "task-1")
        val navigator = CompanionNavigator()
        val coordinator = NotificationTapCoordinator()
        val session = pairedSession()

        val consumeNow = coordinator.onPending(
            session,
            requireNotNull(navigation.pending.value),
            navigation::consume,
        )
        assertFalse(consumeNow, "a resolved chat must wait for commit")
        val held = requireNotNull(coordinator.resolution.value)
        assertEquals("task-1", assertIs<Chat.BotChat>(held.chat).threadId)
        assertNull(navigation.consumedToken(), "consumed before navigate loses the tap on recreation")

        // Recreation in that window: token still null → Intent extras re-offer.
        val midFlight = PendingThreadNavigation(navigation.consumedToken())
        midFlight.offer("b1", "task-1")
        assertEquals(target("b1", "task-1"), midFlight.pending.value)

        // Drive the real protocol: commit owns navigate → consume. A consume
        // callback that fired first would see an empty stack and fail below.
        val events = mutableListOf<String>()
        assertTrue(
            coordinator.commit(held, navigator) { t ->
                events.add("consume")
                assertEquals(
                    listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("b1", "task-1"))),
                    navigator.stack,
                    "navigate must already have recorded the stack before consume runs",
                )
                navigation.consume(t)
            },
        )
        assertEquals(listOf("consume"), events)
        assertNull(coordinator.resolution.value)
        assertNotNull(navigation.consumedToken())

        // After atomic commit: recreation restores the stack and suppresses the Intent.
        val restoredNav = CompanionNavigator(
            CompanionNavigator.decode(CompanionNavigator.encode(navigator.stack)),
        )
        assertEquals(navigator.stack, restoredNav.stack)
        val after = PendingThreadNavigation(navigation.consumedToken())
        after.offer("b1", "task-1")
        assertNull(after.pending.value, "must not fire the same tap twice")
    }

    @Test
    fun `resolved chat is discarded when the bond is left`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("old-bot", "old-task")
        val coordinator = NotificationTapCoordinator()
        val session = pairedSession(botId = "old-bot", active = "old-task")
        val navigator = CompanionNavigator()

        assertFalse(
            coordinator.onPending(session, requireNotNull(navigation.pending.value), navigation::consume),
        )
        val held = requireNotNull(coordinator.resolution.value)
        assertTrue(coordinator.commit(held, navigator, navigation::consume))
        assertEquals(
            listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("old-bot", "old-task"))),
            navigator.stack,
        )

        // Real saver path: generation is written into the saved value. A Bundle
        // captured under generation 0 while Unauthorized/Unpaired was landing
        // must be rejected when the next bond restores under generation 1 —
        // not a hand-rolled map keyed by construction.
        val bondGeneration = 0
        val saved = CompanionNavigator.encodeWithBond(navigator.stack, bondGeneration)

        assertTrue(NotificationTapCoordinator.leavesBond(Session.Status.Unauthorized))
        assertTrue(NotificationTapCoordinator.leavesBond(Session.Status.Unpaired))
        coordinator.discardResolved()
        val nextBondGeneration = bondGeneration + 1

        assertNull(coordinator.resolution.value)
        assertNull(
            CompanionNavigator.restoreForGeneration(saved, nextBondGeneration),
            "leaving the bond must invalidate the saved stack, not only the in-memory chat",
        )
        // Same generation still restores — proves the rejection is the mismatch.
        val sameGen = requireNotNull(CompanionNavigator.restoreForGeneration(saved, bondGeneration))
        assertEquals(navigator.stack, sameGen.stack)

        // rememberSaveable treats a null restore as "run init" → empty roster.
        val restored = CompanionNavigator.restoreForGeneration(saved, nextBondGeneration)
            ?: CompanionNavigator()
        assertEquals(listOf(Destination.Roster), restored.stack)
        // Stale commit from the previous bond must not reopen the chat.
        assertFalse(coordinator.commit(held, restored, navigation::consume))
        assertEquals(listOf(Destination.Roster), restored.stack)
    }

    @Test
    fun `unauthorized pending is consumed without leaving a resolved chat`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("old-bot", "old-task")
        val coordinator = NotificationTapCoordinator()
        val session = unpairedSession()
        val target = requireNotNull(navigation.pending.value)

        // Real RootScreen path: coordinator owns the identified consume. Omitting
        // a separate RootScreen consume() call must still clear the pending entry.
        assertTrue(coordinator.onPending(session, target, navigation::consume))
        assertNull(coordinator.resolution.value)
        assertNull(navigation.pending.value)
        assertNotNull(navigation.consumedToken())

        val afterPair = PendingThreadNavigation(navigation.consumedToken())
        afterPair.offer("old-bot", "old-task")
        assertNull(afterPair.pending.value)
    }

    @Test
    fun `open then consume is a single commit — no double fire while pending`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("b1", "task-1")
        val navigator = CompanionNavigator()
        val coordinator = NotificationTapCoordinator()
        val session = pairedSession()

        coordinator.onPending(session, requireNotNull(navigation.pending.value), navigation::consume)
        val held = requireNotNull(coordinator.resolution.value)

        val events = mutableListOf<String>()
        assertTrue(
            coordinator.commit(held, navigator) { t ->
                // Order pin: stack must already hold the chat when consume runs.
                assertEquals(
                    listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("b1", "task-1"))),
                    navigator.stack,
                    "navigate must precede consume inside the same commit",
                )
                events.add("consume:${t.botId}")
                navigation.consume(t)
            },
        )
        assertEquals(listOf("consume:b1"), events)
        assertEquals(1, navigator.stack.count { it is Destination.Chat })
        assertNull(navigation.pending.value)

        // Offer B before the stale second callback — that callback must not
        // consume B (generation already cleared; no free consume() on pending).
        navigation.offer("b2", "task-2", fresh = true)
        assertEquals(target("b2", "task-2"), navigation.pending.value)
        assertFalse(
            coordinator.commit(held, navigator) { t ->
                events.add("consume:${t.botId}")
                navigation.consume(t)
            },
        )
        assertEquals(listOf("consume:b1"), events)
        assertEquals(target("b2", "task-2"), navigation.pending.value)
        assertEquals(1, navigator.stack.count { it is Destination.Chat })
    }

    @Test
    fun `stale commit cannot consume a newer onNewIntent target`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("a-bot", "a-task")
        val navigator = CompanionNavigator()
        val coordinator = NotificationTapCoordinator()
        val sessionA = pairedSession(botId = "a-bot", active = "a-task")

        assertFalse(
            coordinator.onPending(sessionA, requireNotNull(navigation.pending.value), navigation::consume),
        )
        val heldA = requireNotNull(coordinator.resolution.value)

        // B arrives before A's commit — replaces pending and, once resolved,
        // the held resolution. A's callback must not consume B.
        navigation.offer("b1", "task-1", fresh = true)
        assertEquals(target("b1", "task-1"), navigation.pending.value)

        val sessionB = pairedSession(botId = "b1", active = "task-1")
        assertFalse(
            coordinator.onPending(sessionB, requireNotNull(navigation.pending.value), navigation::consume),
        )
        val heldB = requireNotNull(coordinator.resolution.value)
        assertTrue(heldB.generation > heldA.generation)

        assertFalse(
            coordinator.commit(heldA, navigator, navigation::consume),
            "stale generation must not navigate or consume",
        )
        assertEquals(listOf(Destination.Roster), navigator.stack)
        assertEquals(target("b1", "task-1"), navigation.pending.value)

        assertTrue(coordinator.commit(heldB, navigator, navigation::consume))
        assertEquals(
            listOf(Destination.Roster, Destination.Chat(ChatTarget.Bot("b1", "task-1"))),
            navigator.stack,
        )
        assertNull(navigation.pending.value)
    }

    @Test
    fun `identified consume leaves a replaced pending target untouched`() = runTest {
        val navigation = PendingThreadNavigation()
        navigation.offer("a-bot", "a-task")
        val a = requireNotNull(navigation.pending.value)
        navigation.offer("b1", "task-1", fresh = true)
        assertEquals(target("b1", "task-1"), navigation.pending.value)

        // Stale consume(A) must not mark B consumed.
        navigation.consume(a)
        assertEquals(target("b1", "task-1"), navigation.pending.value)
        assertNull(navigation.consumedToken())

        val b = requireNotNull(navigation.pending.value)
        navigation.consume(b)
        assertNull(navigation.pending.value)
        assertNotNull(navigation.consumedToken())
    }

    private suspend fun TestScope.pairedSession(
        botId: String = "b1",
        active: String = "task-1",
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
            },
            tokenStore = object : TokenStore {
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun read(connectionId: String): TokenStore.ReadResult =
                    TokenStore.ReadResult.Found("device-token")
                override suspend fun remove(connectionId: String) = Unit
            },
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> Fleet(listOf(bot(botId, active, active)), emptyList()) },
        ).also { it.awaitRestored() }
    }

    private suspend fun TestScope.unpairedSession(): Session = Session(
        scope = backgroundScope,
        connectionStore = object : ConnectionStore {
            override suspend fun load(): Connection? = null
            override suspend fun save(connection: Connection) = Unit
            override suspend fun clear() = Unit
        },
        tokenStore = object : TokenStore {
            override suspend fun save(connectionId: String, token: String) = Unit
            override suspend fun read(connectionId: String): TokenStore.ReadResult =
                TokenStore.ReadResult.Missing
            override suspend fun remove(connectionId: String) = Unit
        },
        onboardingStore = InMemoryOnboardingStore(),
        deviceNameProvider = { "Pixel" },
        eventsFn = { _, _, _ -> emptyFlow() },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
    ).also { it.awaitRestored() }

    private fun bot(id: String, active: String, vararg tasks: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance-1", "model-1"),
        createdAt = 0.0,
        tasks = tasks.mapIndexed { index, threadId ->
            BotTask(threadId, "Task $threadId", index.toDouble())
        },
    )

    private fun target(botId: String, threadId: String): NotificationTarget =
        requireNotNull(NotificationTarget.from(botId, threadId))
}
