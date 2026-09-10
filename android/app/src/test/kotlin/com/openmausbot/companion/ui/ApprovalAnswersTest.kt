package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.ConnectionStore
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.GroupResponder
import com.openmausbot.companion.core.InMemoryOnboardingStore
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.TokenStore
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * What the two buttons on an approval card put on the wire.
 *
 * The expectations come from the Swift, not from the Kotlin under them:
 * `ios/App/ChatView.swift` draws the card's own options and answers each with
 * `session.answer(chat:card:choice:)`, and draws the separate "Always allow this
 * tool" which calls `session.alwaysAllow` and *then* answers with
 * `rememberingPermission: false`. `ios/App/Session.swift:473-511` is what those
 * two turn into: a grant only for a permission card with a key answered "Always
 * allow", and a behavior from `OptionCard.responseBehavior`, which
 * `ios/Tests/CompanionCoreTests/DecodingTests.swift:184-225` pins as "Approve",
 * "Yes" and "Always allow" meaning allow and a padded "deny" meaning deny.
 *
 * A real socket rather than a stub, because the claim worth checking is a count:
 * one grant per tap, never two, and never one the user did not ask for.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ApprovalAnswersTest {
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
    fun `the card's own Always allow records the grant, then answers allow`() = runTest {
        val session = session()
        val card = permissionCard(listOf("Always allow", "Deny"), allowKey = "Bash:git push")
        repeat(2) { server.enqueue(ok()) }

        ApprovalAnswers.choose(session, botChat, card, "Always allow")

        assertEquals(
            listOf("/api/bots/bot-1/always-allow", "/api/threads/task-1/respond"),
            paths(2),
        )
        assertEquals(2, server.requestCount, "one grant and one answer, nothing else")
    }

    @Test
    fun `every other option the card offered answers allow and records nothing`() = runTest {
        val session = session()
        val offered = listOf("Allow", "Approve", "Yes", "Allow once")
        val card = permissionCard(offered, allowKey = "Bash:git push")
        repeat(offered.size) { server.enqueue(ok()) }

        offered.forEach { ApprovalAnswers.choose(session, botChat, card, it) }

        val sent = List(offered.size) { server.takeRequest() }
        assertEquals(List(offered.size) { "/api/threads/task-1/respond" }, sent.map { it.path })
        assertEquals(List(offered.size) { "allow" }, sent.map { body(it).getValue("behavior") })
        assertEquals(offered.size, server.requestCount, "no option but Always allow grants")
    }

    @Test
    fun `the refusal answers deny, however it is padded`() = runTest {
        val session = session()
        val card = permissionCard(listOf("Allow", "Deny"), allowKey = "Bash:git push")
        repeat(2) { server.enqueue(ok()) }

        ApprovalAnswers.choose(session, botChat, card, "Deny")
        ApprovalAnswers.choose(session, botChat, card, " \ndeny\t")

        val sent = List(2) { body(server.takeRequest()) }
        assertEquals(listOf("deny", "deny"), sent.map { it.getValue("behavior") })
        assertEquals(List(2) { setOf("requestId", "behavior") }, sent.map { it.keys })
    }

    @Test
    fun `a question answers with the literal option that was tapped`() = runTest {
        val session = session()
        val card = OptionCard(
            title = "Which branch?",
            subtitle = "",
            options = listOf("main", "release"),
            requestId = "request-1",
        )
        server.enqueue(ok())

        ApprovalAnswers.choose(session, botChat, card, "main")

        assertEquals(
            mapOf("requestId" to "request-1", "behavior" to "answer", "message" to "main"),
            body(server.takeRequest()),
        )
    }

    @Test
    fun `the separate button records the grant once, even when its choice is Always allow`() =
        runTest {
            val session = session()
            // No literal "Allow" among the options, so the choice the button
            // answers with is the card's own "Always allow" — the shape that
            // would have written the grant a second time.
            val card = permissionCard(listOf("Always allow", "Deny"), allowKey = "Bash:git push")
            val choice = ApprovalChoices.alwaysAllowChoice(card)
            assertEquals("Always allow", choice)
            repeat(2) { server.enqueue(ok()) }

            ApprovalAnswers.grant(session, botChat, card, choice!!)

            val grant = server.takeRequest()
            val answer = server.takeRequest()
            assertEquals("/api/bots/bot-1/always-allow", grant.path)
            assertEquals(mapOf("allowKey" to "Bash:git push", "threadId" to "task-1"), body(grant))
            assertEquals("/api/threads/task-1/respond", answer.path)
            assertEquals(mapOf("requestId" to "request-1", "behavior" to "allow"), body(answer))
            assertEquals(2, server.requestCount, "the grant must not be written twice")
        }

    @Test
    fun `the separate button answers with the card's conventional label when it has one`() =
        runTest {
            val session = session()
            val card = permissionCard(listOf("Allow", "Deny"), allowKey = "Bash:git push")
            repeat(2) { server.enqueue(ok()) }

            ApprovalAnswers.grant(session, botChat, card, ApprovalChoices.alwaysAllowChoice(card)!!)

            assertEquals(
                listOf("/api/bots/bot-1/always-allow", "/api/threads/task-1/respond"),
                paths(2),
            )
            assertEquals(2, server.requestCount)
        }

    @Test
    fun `a room answers without ever recording a grant`() = runTest {
        val session = session()
        val card = permissionCard(listOf("Always allow", "Deny"), allowKey = "Bash:git push")
        server.enqueue(ok())

        ApprovalAnswers.choose(session, roomChat, card, "Always allow")

        val answer = server.takeRequest()
        assertEquals("/api/threads/room-thread/respond", answer.path)
        assertEquals(mapOf("requestId" to "request-1", "behavior" to "allow"), body(answer))
        assertEquals(1, server.requestCount, "a room has no bot to hang a grant on")
    }

    private val botChat = Chat.BotChat(
        Bot(
            id = "bot-1",
            threadId = "task-1",
            name = "Scout",
            title = "research",
            description = "",
            notifications = true,
            color = "green",
            unread = false,
            modelSelection = ModelSelection("instance-1", "model-1"),
            createdAt = 0.0,
        ),
    )

    private val roomChat = Chat.RoomChat(
        Room(
            id = "room-1",
            threadId = "room-thread",
            name = "Standup",
            memberIds = listOf("bot-1"),
            defaultResponder = GroupResponder("mentions"),
            bulletin = "",
            unread = false,
            createdAt = 0.0,
        ),
    )

    private fun permissionCard(options: List<String>, allowKey: String?) = OptionCard(
        title = "Run a command",
        subtitle = "git push",
        options = options,
        requestId = "request-1",
        tool = "Bash",
        allowKey = allowKey,
    )

    private suspend fun TestScope.session(): Session {
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
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        ).also { it.awaitRestored() }
    }

    private fun paths(count: Int): List<String?> = List(count) { server.takeRequest().path }

    private fun ok(): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody("{}")

    private fun body(request: RecordedRequest): Map<String, String> =
        CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            .mapValues { it.value.jsonPrimitive.content }
}
