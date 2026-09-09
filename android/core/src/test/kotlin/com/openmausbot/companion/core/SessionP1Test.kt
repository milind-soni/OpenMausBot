package com.openmausbot.companion.core

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

@OptIn(ExperimentalCoroutinesApi::class)
class SessionP1Test {
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
    fun capturedTaskPinsPlainMessagesStopReadGrantsEditsAndQueueCancellation() = runTest {
        val captured = bot("b1", "task-a", "task-a", "task-b")
        val elsewhere = captured.copy(threadId = "task-b")
        val session = session { Fleet(listOf(elsewhere), emptyList()) }
        session.openNotification(target("b1", "task-b"))
        val chat = Chat.BotChat(captured)
        val message = Message("message-a", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "original")
        repeat(6) { server.enqueue(json("{}")) }
        server.enqueue(json("""{"activeLeafId":"message-a"}"""))
        server.enqueue(json("{}"))

        session.send("plain text", chat)
        session.send("/quick command", chat)
        session.interrupt(captured)
        session.markRead(chat)
        session.alwaysAllow(captured, permissionCard(listOf("Always allow"), "Read"))
        session.edit(message, captured, "edited")
        session.switchVersion(message, captured)
        session.cancelQueued(QueuedSend("queue-a", "queued"), chat)

        val requests = List(8) { server.takeRequest() }
        assertEquals(listOf("messages", "messages", "interrupt", "read", "always-allow",
            "messages/message-a/edit", "active-branch", "queue/queue-a"),
            requests.map { it.path!!.removePrefix("/api/bots/b1/") })
        assertEquals(List(8) { "task-a" }, requests.map { body(it)["threadId"] })
        assertEquals("task-b", session.state.value.bot("b1")?.threadId)
        assertNull(session.actionError)
    }

    @Test
    fun changingAModelReturnsTheCapturedTaskModelNotTheSiblingOrProfileDefault() = runTest {
        val chosen = ModelSelection("instance", "new-a")
        val captured = bot("b1", "task-a", "task-a", "task-b")
        val canonical = captured.copy(threadId = "task-b", tasks = listOf(
            BotTask("task-a", "A", 1.0, modelSelection = chosen, busy = false),
            BotTask("task-b", "B", 2.0, modelSelection = ModelSelection("instance", "b"), busy = true),
        ))
        val session = session { Fleet(listOf(canonical), emptyList()) }
        server.enqueue(json("""{"bot":${CompanionJson.encodeToString(canonical)}}"""))

        val updated = session.updateModel(chosen, captured)

        assertEquals("task-a", updated?.threadId)
        assertEquals(chosen, updated?.modelSelection)
        assertEquals("model", session.state.value.bot("b1")?.modelSelection?.model)
        assertEquals("task-b", session.state.value.bot("b1")?.threadId)
        assertEquals("/api/bots/b1/tasks/task-a", server.takeRequest().path)
    }

    @Test
    fun permissionAnswersUseTheSwiftBehaviorForOfferedProviderChoices() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val choices = listOf("Approve", "Yes", "Always allow", "Deny", " \ndeny\t")
        val card = permissionCard(options = choices, allowKey = "Bash:git")
        repeat(choices.size) { server.enqueue(json("{}")) }

        choices.forEach { choice ->
            session.answer(chat, card, choice, rememberingPermission = false)
        }

        val requests = List(5) { server.takeRequest() }
        val bodies = requests.map(::body)
        assertEquals(
            listOf("allow", "allow", "allow", "deny", "deny"),
            bodies.map { it.getValue("behavior") },
        )
        assertEquals(
            List(5) { setOf("requestId", "behavior") },
            bodies.map { it.keys },
        )
        assertEquals(List(5) { "/api/threads/task-1/respond" }, requests.map { it.path })
    }

    @Test
    fun questionAnswersSendOnlyTheLiteralOptionsTheCardOffered() = runTest {
        val session = session()
        val chat = Chat.RoomChat(room("room-1", "room-thread"))
        val offered = listOf("Ship it", "Not yet\n")
        val card = OptionCard(
            title = "Release?",
            subtitle = "Choose",
            options = offered,
            requestId = "question-1",
        )
        repeat(offered.size) { server.enqueue(json("{}")) }

        session.answer(chat, card, "Ship it")
        session.answer(chat, card, "Not yet\n")

        val sent = List(2) { body(server.takeRequest()) }
        assertEquals(listOf("answer", "answer"), sent.map { it.getValue("behavior") })
        assertEquals(listOf("Ship it", "Not yet\n"), sent.map { it.getValue("message") })
        assertTrue(sent.all { it.keys == setOf("requestId", "behavior", "message") })
    }

    @Test
    fun failedStandingGrantUsesTheProviderKeyOnceAndStillAnswersOnce() = runTest {
        val session = session()
        val chat = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val card = permissionCard(
            options = listOf("Always allow", "Deny"),
            allowKey = "Bash:git push",
        )
        server.enqueue(json("""{"error":"Could not save grant."}""", code = 500))
        server.enqueue(json("{}"))

        session.answer(chat, card, "Always allow")

        val grant = server.takeRequest()
        val answer = server.takeRequest()
        assertEquals("/api/bots/b1/always-allow", grant.path)
        assertEquals(mapOf("allowKey" to "Bash:git push", "threadId" to "task-1"), body(grant))
        assertEquals("/api/threads/task-1/respond", answer.path)
        assertEquals(
            mapOf("requestId" to "request-1", "behavior" to "allow"),
            body(answer),
        )
        assertEquals(2, server.requestCount)
        assertEquals("Could not save grant.", session.actionError)
    }

    @Test
    fun missingKeyRoomAndDisabledMemoryNeverInventAStandingGrant() = runTest {
        val session = session()
        val bot = Chat.BotChat(bot("b1", "task-1", "task-1"))
        val room = Chat.RoomChat(room("room-1", "room-thread"))
        repeat(3) { server.enqueue(json("{}")) }

        session.answer(
            bot,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = null),
            "Always allow",
        )
        session.answer(
            bot,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = "Bash:git"),
            "Always allow",
            rememberingPermission = false,
        )
        session.answer(
            room,
            permissionCard(options = listOf("Always allow", "Deny"), allowKey = "Bash:git"),
            "Always allow",
        )

        val requests = List(3) { server.takeRequest() }
        assertEquals(
            listOf(
                "/api/threads/task-1/respond",
                "/api/threads/task-1/respond",
                "/api/threads/room-thread/respond",
            ),
            requests.map { it.path },
        )
        assertTrue(requests.all { body(it)["behavior"] == "allow" })
        assertEquals(3, server.requestCount)
    }

    @Test
    fun taskActionsReturnTheExplicitSelectionWithoutRetargetingAnOpenChat() = runTest {
        val initial = bot("b1", "task-1", "task-1", "old-inactive")
        val created = bot("b1", "task-2", "task-1", "old-inactive", "task-2")
        val switched = bot("b1", "task-1", "task-1", "old-inactive", "task-2")
        val inactiveDeleted = bot("b1", "task-1", "task-1", "task-2")
        val activeDeleted = bot("b1", "task-2", "task-2")
        val session = session { Fleet(listOf(initial), emptyList()) }
        val stableTarget = assertIs<Chat.BotChat>(
            session.openNotification(target("b1", "task-1")),
        ).target
        listOf(created, switched, inactiveDeleted, activeDeleted).forEach { returned ->
            server.enqueue(json("""{"bot":${CompanionJson.encodeToString(returned)}}"""))
        }

        assertEquals("task-2", session.createTask(initial, null)?.threadId)
        assertEquals("task-1", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        assertEquals("task-1", session.switchTask(BotTask("task-1", "Task 1", 1.0), created)?.threadId)
        assertEquals("task-1", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        session.deleteTask(BotTask("old-inactive", "Old", 0.0), switched)
        assertEquals("task-1", assertIs<Chat.BotChat>(session.state.value.chat(stableTarget)).threadId)

        assertEquals("task-2", session.deleteTask(BotTask("task-1", "Task 1", 1.0), inactiveDeleted)?.threadId)
        assertNull(session.state.value.chat(stableTarget))
        assertEquals(
            listOf(
                "POST /api/bots/b1/tasks",
                "POST /api/bots/b1/tasks/task-1",
                "DELETE /api/bots/b1/tasks/old-inactive",
                "DELETE /api/bots/b1/tasks/task-1",
            ),
            List(4) { server.takeRequest().let { "${it.method} ${it.path}" } },
        )
    }

    @Test
    fun threadChipSwitchesByTheTaskRouteAndLandsOnTheBotWhenTheThreadIsGone() = runTest {
        val scout = bot("scout", "task-1", "task-1", "task-2")
        val switched = scout.copy(threadId = "task-2")
        val session = session { Fleet(listOf(scout), emptyList()) }
        server.enqueue(json("""{"bot":${CompanionJson.encodeToString(switched)}}"""))

        val opened = session.openThread(ThreadRef("scout", "task-2", "Task 2"))

        assertEquals("task-2", opened?.threadId)
        assertEquals("task-2", session.state.value.bot("scout")?.threadId)
        assertEquals("POST /api/bots/scout/tasks/task-2", server.takeRequest().let { "${it.method} ${it.path}" })
        assertNull(session.actionError)

        // The chip's thread was deleted after the chip was written: land on
        // the bot's current thread and say so, never nowhere.
        server.enqueue(json("""{"error":"Task not found."}""", code = 404))
        val fallback = session.openThread(ThreadRef("scout", "task-9", "Gone"))
        assertEquals("task-2", fallback?.threadId)
        assertEquals("POST /api/bots/scout/tasks/task-9", server.takeRequest().let { "${it.method} ${it.path}" })
        assertEquals(Session.THREAD_GONE_MESSAGE, session.actionError)

        // A thread the bot is already on needs no request at all.
        session.actionError = null
        assertEquals("task-2", session.openThread(ThreadRef("scout", "task-2", "Task 2"))?.threadId)
        assertEquals(2, server.requestCount)

        assertNull(session.openThread(ThreadRef("nobody", "task-1", "Nope")))
        assertEquals("That agent no longer exists.", session.actionError)
    }

    @Test
    fun threadChipDoesNotNavigateOnAuthenticationServerOrUnreadableResponseErrors() = runTest {
        val scout = bot("scout", "task-1", "task-1", "task-2")
        val session = session { Fleet(listOf(scout), emptyList()) }
        for (code in listOf(401, 403, 409, 500)) {
            server.enqueue(json("""{"error":"Switch failed: $code"}""", code = code))
            assertNull(session.openThread(ThreadRef("scout", "task-2", "Task 2")))
            assertEquals("Switch failed: $code", session.actionError)
            assertEquals("task-1", session.state.value.bot("scout")?.threadId)
        }
        server.enqueue(json("not json"))
        assertNull(session.openThread(ThreadRef("scout", "task-2", "Task 2")))
        assertTrue(session.actionError != Session.THREAD_GONE_MESSAGE)

        // A successful retry clears the error from the failed tap.
        server.enqueue(json("""{"bot":${CompanionJson.encodeToString(scout.copy(threadId = "task-2"))}}"""))
        assertEquals("task-2", session.openThread(ThreadRef("scout", "task-2", "Task 2"))?.threadId)
        assertNull(session.actionError)
    }

    @Test
    fun threadChipDiscardsAHydrationFromThePreviousComputer() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val session = session(otherComputer = true) {
            started.complete(Unit)
            release.await()
            Fleet(listOf(bot("scout", "task-1", "task-1")), emptyList())
        }
        val opening = async { session.openThread(ThreadRef("scout", "task-1", "Task 1")) }
        started.await()
        session.switchComputer("other")
        runCurrent()
        assertEquals("other", session.connection.value?.id)
        release.complete(Unit)

        assertNull(opening.await())
        assertTrue(session.state.value.bots.isEmpty())
        assertNull(session.actionError)
    }

    @Test
    fun threadChipDiscardsSwitchSuccessAndFailureFromThePreviousComputer() = runTest {
        val scout = bot("scout", "task-1", "task-1", "task-2")
        for (code in listOf(200, 404, 500)) {
            val session = session(otherComputer = true) { Fleet(listOf(scout), emptyList()) }
            session.openThread(ThreadRef("scout", "task-1", "Task 1"))
            val started = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    started.complete(Unit)
                    runBlocking { release.await() }
                    return if (code == 200) json("""{"bot":${CompanionJson.encodeToString(scout.copy(threadId = "task-2"))}}""")
                    else json("""{"error":"Old computer error"}""", code = code)
                }
            }
            val opening = async { session.openThread(ThreadRef("scout", "task-2", "Task 2")) }
            try {
                started.await()
                session.switchComputer("other")
                runCurrent()
                assertEquals("other", session.connection.value?.id)
            } finally {
                release.complete(Unit)
            }
            assertNull(opening.await())
            assertTrue(session.state.value.bots.isEmpty())
            assertNull(session.actionError)
        }
    }

    @Test
    fun threadChipCancellationDoesNotNavigateOrReportADeletedThread() = runTest {
        val scout = bot("scout", "task-1", "task-1", "task-2")
        val session = session { Fleet(listOf(scout), emptyList()) }
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                started.complete(Unit)
                runBlocking { release.await() }
                return json("""{"error":"Task not found."}""", code = 404)
            }
        }
        val opening = async { session.openThread(ThreadRef("scout", "task-2", "Task 2")) }
        try {
            started.await()
            opening.cancel()
        } finally {
            release.complete(Unit)
        }
        assertFailsWith<CancellationException> { opening.await() }
        assertEquals("task-1", session.state.value.bot("scout")?.threadId)
        assertNull(session.actionError)
    }

    @Test
    fun roomTaskNotificationSwitchesTheChannelAndFallsBackWhenTheTaskIsGone() = runTest {
        val room = room("room-1", "room-task-1", "room-task-1", "room-task-2")
        val switched = room.copy(
            threadId = "room-task-2",
            messages = listOf(Message("fresh", Message.Role.USER, Message.Kind.TEXT, 2.0, text = "fresh")),
        )
        val session = session { Fleet(emptyList(), listOf(room)) }
        server.enqueue(json("""{"group":${CompanionJson.encodeToString(switched)}}"""))

        val opened = session.openNotification(target("asker", "room-task-2"))

        assertEquals("room-task-2", assertIs<Chat.RoomChat>(opened).threadId)
        assertEquals("room-task-2", session.state.value.rooms.single().threadId)
        assertEquals("POST /api/groups/room-1/tasks/room-task-2", server.takeRequest().let { "${it.method} ${it.path}" })

        server.enqueue(json("""{"error":"Task not found."}""", code = 404))
        val fallback = session.openNotification(target("asker", "room-task-1"))
        assertEquals("room-task-2", assertIs<Chat.RoomChat>(fallback).threadId)
        assertNull(session.actionError)
    }

    @Test
    fun roomSearchHitSwitchesItsTaskBeforeLoadingTheMatchedPage() = runTest {
        val room = room("room-1", "room-task-1", "room-task-1", "room-task-2")
        val switched = room.copy(threadId = "room-task-2")
        val session = session { Fleet(emptyList(), listOf(room)) }
        // A current task notification only hydrates the fleet; it avoids a
        // private state seam before exercising the public search entry point.
        assertIs<Chat.RoomChat>(session.openNotification(target("asker", "room-task-1")))
        server.enqueue(json("""{"group":${CompanionJson.encodeToString(switched)}}"""))
        server.enqueue(json("""{"messages":[{"id":"matched","role":"user","kind":"text","at":2,"text":"needle"}],"hasMore":false}"""))

        val opened = session.open(SearchHit(
            threadId = "room-task-2",
            messageId = "matched",
            at = 2.0,
            role = Message.Role.USER,
            kind = Message.Kind.TEXT,
            snippet = "needle",
            matchStart = 0,
            matchLength = 6,
            groupId = "room-1",
            name = "room-1",
            onActivePath = true,
        ))

        assertEquals("room-task-2", assertIs<Chat.RoomChat>(opened).threadId)
        assertEquals(listOf("matched"), session.state.value.transcript("room-task-2").map(Message::id))
        assertEquals(
            listOf(
                "POST /api/groups/room-1/tasks/room-task-2",
                "GET /api/threads/room-task-2/messages?limit=50&around=matched",
            ),
            List(2) { server.takeRequest().let { "${it.method} ${it.path}" } },
        )
    }

    @Test
    fun roomNotificationHydratesAndPrefersTheRoomThread() = runTest {
        var hydrates = 0
        val asker = bot("asker", "bot-task", "bot-task")
        val room = room("room-1", "room-thread")
        val session = session {
            hydrates++
            Fleet(listOf(asker), listOf(room))
        }

        val opened = session.openNotification(target("asker", "room-thread"))

        assertEquals("room-1", assertIs<Chat.RoomChat>(opened).id)
        assertEquals(1, hydrates)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun activeTaskNotificationHydratesWithoutSwitching() = runTest {
        var hydrates = 0
        val session = session {
            hydrates++
            Fleet(listOf(bot("b1", "task-1", "task-1", "task-2")), emptyList())
        }

        val opened = session.openNotification(target("b1", "task-1"))

        assertEquals("task-1", assertIs<Chat.BotChat>(opened).threadId)
        assertEquals(1, hydrates)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun inactiveTaskNotificationSwitchesOnceAndRepeatedOpenIsIdempotent() = runTest {
        var hydrates = 0
        val switched = bot("b1", "task-2", "task-1", "task-2")
        val session = session {
            hydrates++
            Fleet(listOf(bot("b1", "task-1", "task-1", "task-2")), emptyList())
        }
        server.enqueue(json("""{"bot":${CompanionJson.encodeToString(switched)}}"""))
        val target = target("b1", "task-2")

        val first = session.openNotification(target)
        val second = session.openNotification(target)

        assertEquals("task-2", assertIs<Chat.BotChat>(first).threadId)
        assertEquals("task-2", assertIs<Chat.BotChat>(second).threadId)
        assertEquals("task-2", session.state.value.bot("b1")?.threadId)
        assertEquals(1, hydrates)
        assertEquals(1, server.requestCount)
        assertEquals("POST /api/bots/b1/tasks/task-2", server.takeRequest().let { "${it.method} ${it.path}" })
    }

    @Test
    fun deletedTaskNotificationFallsBackToTheBotsCurrentChat() = runTest {
        val session = session {
            Fleet(listOf(bot("b1", "task-1", "task-1")), emptyList())
        }
        server.enqueue(json("""{"error":"Task not found."}""", code = 404))

        val opened = session.openNotification(target("b1", "deleted-task"))

        assertEquals("task-1", assertIs<Chat.BotChat>(opened).threadId)
        assertNull(session.actionError)
        assertEquals(1, server.requestCount)
        assertEquals("/api/bots/b1/tasks/deleted-task", server.takeRequest().path)
    }

    @Test
    fun deletedBotNotificationDoesNotChooseAnotherBotsMatchingTask() = runTest {
        val session = session {
            Fleet(
                listOf(bot("other", "other-active", "deleted-task", "other-active")),
                emptyList(),
            )
        }

        val opened = session.openNotification(target("deleted", "deleted-task"))

        assertNull(opened)
        assertEquals("That agent no longer exists.", session.actionError)
        assertEquals(0, server.requestCount)
    }

    private suspend fun TestScope.session(
        otherComputer: Boolean = false,
        hydrate: suspend () -> Fleet = { Fleet(emptyList(), emptyList()) },
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
                override suspend fun loadRegistry() = ConnectionRegistryRestore(
                    ConnectionRegistry(
                        if (otherComputer) listOf(connection, connection.copy(id = "other")) else listOf(connection),
                        connection.id,
                    ),
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

    private fun target(botId: String, threadId: String): NotificationTarget =
        requireNotNull(NotificationTarget.from(botId, threadId))

    private fun permissionCard(options: List<String>, allowKey: String?): OptionCard = OptionCard(
        title = "Approval needed",
        subtitle = "git push",
        options = options,
        requestId = "request-1",
        tool = "Bash",
        allowKey = allowKey,
    )

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

    private fun body(request: RecordedRequest): Map<String, String> =
        CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            .mapValues { it.value.jsonPrimitive.content }
}
