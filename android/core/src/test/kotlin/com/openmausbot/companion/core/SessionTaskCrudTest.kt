package com.openmausbot.companion.core

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * The task-CRUD surface is one policy: offline yields the operation's offline
 * value, cancellation propagates (it is not an error), and failures land in
 * actionError. Every Bot and Room overload rides the same path, so these tests
 * drive all of them: a reintroduced per-side copy fails here first.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionTaskCrudTest {
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
    fun cancellationPropagatesThroughEveryTaskOperationWithoutReportingAnError() = runTest {
        val session = session()
        val task = BotTask("task-2", "Task 2", 2.0)
        val host = bot("b1", "task-1", "task-1", "task-2")
        val room = room("r1", "task-1", "task-1", "task-2")
        val cancelled = CoroutineScope(coroutineContext + Job().apply { cancel() })

        val operations: List<suspend () -> Unit> = listOf(
            { session.createTask(host, null) },
            { session.switchTask(task, host) },
            { session.renameTask(task, host, "New name") },
            { session.archiveTask(task, host, 1.0) },
            { session.deleteTask(task, host) },
            { session.createTask(room, null) },
            { session.switchTask(task, room) },
            { session.renameTask(task, room, "New name") },
            { session.deleteTask(task, room) },
        )

        operations.forEachIndexed { index, operation ->
            // Undispatched so the body runs into the first suspension — the
            // HTTP call inside the shared executor — and surfaces the already-
            // cancelled job's CancellationException through its catch.
            val deferred = cancelled.async(start = CoroutineStart.UNDISPATCHED) { operation() }
            assertFailsWith<CancellationException>("operation $index") { deferred.await() }
        }

        assertNull(session.actionError)
    }

    @Test
    fun aRepresentativeOperationSucceedsAndFailsThroughOnePath() = runTest {
        val initialRoom = room("r1", "task-1", "task-1", "task-2")
        val switchedRoom = initialRoom.copy(threadId = "task-2")
        val session = session { Fleet(emptyList(), listOf(initialRoom)) }

        // Success: the room switch commits Frame.Room through the shared path.
        server.enqueue(json("""{"group":${CompanionJson.encodeToString(switchedRoom)}}"""))
        assertEquals("task-2", session.switchTask(BotTask("task-2", "Task 2", 2.0), initialRoom)?.threadId)
        assertEquals("task-2", session.state.value.rooms.single().threadId)
        assertEquals("POST /api/groups/r1/tasks/task-2", server.takeRequest().let { "${it.method} ${it.path}" })
        assertNull(session.actionError)

        // Failure: a create reports the server's error and leaves the fleet alone.
        server.enqueue(json("""{"error":"Create failed"}""", code = 500))
        assertNull(session.createTask(bot("b1", "task-1", "task-1"), null))
        assertEquals("Create failed", session.actionError)
        assertEquals("task-2", session.state.value.rooms.single().threadId)
    }

    @Test
    fun cancellationAfterTheErrorWriteStillThrowsRatherThanYieldingTheFallback() = runTest {
        val session = session()
        val caller = Job()
        val callerScope = CoroutineScope(coroutineContext + caller)

        // The failure is real and reported, but the caller's job is cancelled
        // mid-mutation with no suspension between the two — exactly the
        // window mutateTask must close. The await alone cannot tell the two
        // apart (a cancelled async discards a normal result), so the test
        // also proves the policy itself threw instead of returning offline.
        // Null until mutateTask returns: the policy must throw, so this must
        // still be null after the cancellation surfaces.
        var offlineValueObserved: Boolean? = null
        val deferred = callerScope.async(start = CoroutineStart.UNDISPATCHED) {
            offlineValueObserved = session.mutateTask(offline = false) {
                    caller.cancel()
                    throw IllegalStateException("late failure")
            }
        }

        assertFailsWith<CancellationException> { deferred.await() }
        assertNull(offlineValueObserved)
        assertEquals("late failure", session.actionError)
    }

    private suspend fun TestScope.session(): Session = session { Fleet(emptyList(), emptyList()) }

    private suspend fun TestScope.session(
        hydrate: suspend () -> Fleet,
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
                override suspend fun loadRegistry() = ConnectionRegistryRestore(
                    ConnectionRegistry(listOf(connection), connection.id),
                    migratedLegacyConnection = false,
                )
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
            hydrateFn = { _, _ -> hydrate() },
        ).also { it.awaitRestored() }
    }

    private fun bot(id: String, active: String, vararg tasks: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
        tasks = tasks.mapIndexed { index, threadId ->
            BotTask(threadId, "Task ${index + 1}", index.toDouble())
        },
    )

    private fun room(id: String, threadId: String, vararg tasks: String): Room = Room(
        id = id,
        threadId = threadId,
        name = id,
        memberIds = emptyList(),
        defaultResponder = GroupResponder("mentions"),
        bulletin = "",
        unread = false,
        createdAt = 1.0,
        tasks = tasks.mapIndexed { index, task -> BotTask(task, "Task ${index + 1}", index.toDouble()) }
            .takeIf { it.isNotEmpty() },
    )

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
