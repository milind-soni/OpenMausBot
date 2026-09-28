package com.openmausbot.companion.core

import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientTest {
    private lateinit var server: MockWebServer
    private lateinit var connection: Connection
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        connection = requireNotNull(Connection.parse(server.url("/").toString()))
        client = CompanionClient(connection, "device-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun pairingUsesTheRightCredentialFieldAndNoAuthorization() = runBlocking {
        server.enqueue(json(fixtureText("pair-response")))
        val older = CompanionClient.pair(connection, "004209", "Ada's phone")
        assertTrue(older.token.startsWith("omb_"))
        server.takeRequest().let { request ->
            assertEquals("POST", request.method)
            assertEquals("/api/pair", request.path)
            assertEquals(null, request.getHeader("Authorization"))
            assertEquals(
                mapOf("code" to "004209", "deviceName" to "Ada's phone"),
                stringBody(request.body.readUtf8()),
            )
        }

        val token = "omb_pair_" + "a".repeat(43)
        server.enqueue(json(fixtureText("pair-response")))
        CompanionClient.pair(connection, token, "Ada's phone")
        val body = stringBody(server.takeRequest().body.readUtf8())
        assertEquals(token, body["credential"])
        assertFalse("code" in body)
    }

    @Test
    fun readingCallsMatchTheAllowlist() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json(fixtureText("bots-paged")))
        server.enqueue(json(fixtureText("thread-page")))
        server.enqueue(json(fixtureText("thread-page")))
        server.enqueue(json("""{"hits":[]}"""))
        server.enqueue(MockResponse()
            .setResponseCode(200)
            .setHeader("Content-Disposition", "attachment; filename=chat.md")
            .setHeader("Content-Type", "text/markdown")
            .setBody("transcript"))
        server.enqueue(json(fixtureText("instances")))
        server.enqueue(json(fixtureText("config")))
        server.enqueue(MockResponse().setResponseCode(200).setBody("pixels"))

        assertEquals(true, client.health()["ok"]?.jsonPrimitive?.content?.toBoolean())
        assertTrue(client.fleet().bots.isNotEmpty())
        assertEquals(2, client.messages("t1", before = "m0").messages.size)
        assertEquals(2, client.messagesAround("t1", "m4").messages.size)
        assertTrue(client.search("needle").isEmpty())
        val exported = client.export("t1", "md")
        assertEquals("chat.md", exported.filename)
        assertEquals("text/markdown", exported.contentType)
        assertTrue(client.instances().isNotEmpty())
        assertEquals("Ada Lovelace", client.config().profile?.name)
        assertEquals("pixels", client.image("t1", "m1").toString(Charsets.UTF_8))

        val requests = List(9) { server.takeRequest() }
        assertEquals(
            listOf(
                "GET /api/health",
                "GET /api/bots?messages=50",
                "GET /api/threads/t1/messages?limit=50&before=m0",
                "GET /api/threads/t1/messages?limit=50&around=m4",
                "GET /api/search?q=needle&limit=40",
                "GET /api/threads/t1/export?format=md",
                "GET /api/instances",
                "GET /api/config",
                "GET /api/threads/t1/messages/m1/image",
            ),
            requests.map { "${it.method} ${it.path}" },
        )
        requests.forEach { assertEquals("Bearer device-token", it.getHeader("Authorization")) }
    }

    @Test
    fun endpointRefreshUsesAuthenticatedWireRouteAndRequiresUsableMetadata() = runBlocking {
        server.enqueue(json(
            """{"serverName":"Mac","endpoints":[{"url":"https://future.example","kind":"future","priority":1},{"url":"https://mac.example","kind":"hosted","priority":0}]}""",
        ))

        val metadata = client.connectionMetadata()

        assertEquals(listOf("https://mac.example"), metadata.endpoints.map { it.url })
        server.takeRequest().let { request ->
            assertEquals("GET", request.method)
            assertEquals("/api/companion/endpoints", request.path)
            assertEquals("Bearer device-token", request.getHeader("Authorization"))
        }
    }

    @Test
    fun createRoomSendsMembersAndMirrorsIosWhitespaceNameRules() = runBlocking {
        val cases = listOf<Pair<String?, Boolean>>(
            "Launch Team" to true,
            null to false,
            "" to false,
            "   " to false,
            "\t" to false,
            " \t\n" to true,
            "\n" to true,
            "\r" to true,
        )
        repeat(cases.size) { server.enqueue(json("""{"group":${roomJson()}}""")) }

        cases.forEachIndexed { index, (name, includesName) ->
            val memberIds = if (index == 0) listOf("b1", "b2") else listOf("b$index")
            val room = client.createRoom(name, memberIds)
            if (index == 0) {
                assertEquals("g-new", room.id)
                assertEquals("Launch Team", room.name)
                assertEquals(listOf("b1", "b2"), room.memberIds)
            }

            val request = server.takeRequest()
            assertEquals("POST", request.method)
            assertEquals("/api/groups", request.path)
            val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals(
                memberIds,
                body.getValue("memberIds").jsonArray.map { it.jsonPrimitive.content },
            )
            if (includesName) {
                assertEquals(name, body.getValue("name").jsonPrimitive.content)
            } else {
                assertFalse("name" in body)
            }
        }
    }

    @Test
    fun assignSectionUsesTheNarrowAtomicOrganizerRoute() = runBlocking {
        server.enqueue(json("""{"section":"Research","bots":[${botJson()}]}"""))

        val bots = client.assignSection("Research", listOf("b2", "b1"))

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sidebar-sections", request.path)
        assertEquals("Bearer device-token", request.getHeader("Authorization"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("Research", body.getValue("name").jsonPrimitive.content)
        assertEquals(listOf("b2", "b1"), body.getValue("botIds").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(1, bots.size)
    }

    @Test
    fun actionCallsMatchTheAllowlist() = runBlocking {
        val bot = botJson()
        val room = """{"id":"g1","threadId":"gt1","name":"Room","memberIds":[],"defaultResponder":{"kind":"auto"},"bulletin":"","unread":false,"createdAt":0,"tasks":[{"threadId":"gt1","title":"Room task","createdAt":0}]}"""
        val message = fixtureText("options-card")
        listOf(
            """{"bot":$bot}""", // create bot
            "{}", // bot message
            "{}", // room message
            "{}", // respond
            "{}", // always allow
            """{"message":$message}""", // reaction
            "{}", // edit
            """{"activeLeafId":"m2"}""", // branch
            """{"bot":$bot}""", // create task
            """{"bot":$bot}""", // switch task
            "{}", // rename task
            """{"bot":$bot}""", // delete task
            """{"group":$room}""", // create room task
            """{"group":$room}""", // switch room task
            "{}", // rename room task
            """{"group":$room}""", // delete room task
            "{}", // interrupt
            """{"joinUrl":"https://desktop.example/session/fresh"}""", // cloud desktop
            "{}", // bot read
            "{}", // room read
            "{}", // archive task
            "{}", // unarchive task
        ).forEach { server.enqueue(json(it)) }

        client.createBot()
        client.sendToBot("b1", "hello")
        client.sendToRoom("g1", "hello room")
        client.respond("t1", "r1", "answer", "Yes")
        client.alwaysAllow("b1", "Bash:git")
        client.toggleReaction("t1", "m1", "👍")
        client.edit("b1", "m1", "retry")
        assertEquals("m2", client.setActiveBranch("b1", "m2"))
        client.createTask("b1", "Next")
        client.switchTask("b1", "t2")
        client.renameTask("b1", "t2", "Renamed")
        client.deleteTask("b1", "t2")
        client.createRoomTask("g1", "Channel next")
        client.switchRoomTask("g1", "gt2")
        client.renameRoomTask("g1", "gt2", "Channel renamed")
        client.deleteRoomTask("g1", "gt2")
        client.interrupt("b1")
        assertEquals("https://desktop.example/session/fresh", client.cloudDesktop("b1").url.toString())
        client.markBotRead("b1")
        client.markRoomRead("g1")
        client.setTaskArchived("b1", "t2", 123.0)
        client.setTaskArchived("b1", "t2", null)

        val requests = List(22) { server.takeRequest() }
        assertEquals(
            listOf(
                "POST /api/bots",
                "POST /api/bots/b1/messages",
                "POST /api/groups/g1/messages",
                "POST /api/threads/t1/respond",
                "POST /api/bots/b1/always-allow",
                "POST /api/threads/t1/messages/m1/reactions",
                "POST /api/bots/b1/messages/m1/edit",
                "POST /api/bots/b1/active-branch",
                "POST /api/bots/b1/tasks",
                "POST /api/bots/b1/tasks/t2",
                "PATCH /api/bots/b1/tasks/t2",
                "DELETE /api/bots/b1/tasks/t2",
                "POST /api/groups/g1/tasks",
                "POST /api/groups/g1/tasks/gt2",
                "PATCH /api/groups/g1/tasks/gt2",
                "DELETE /api/groups/g1/tasks/gt2",
                "POST /api/bots/b1/interrupt",
                "POST /api/bots/b1/computer/join",
                "POST /api/bots/b1/read",
                "POST /api/groups/g1/read",
                "PATCH /api/bots/b1/tasks/t2",
                "PATCH /api/bots/b1/tasks/t2",
            ),
            requests.map { "${it.method} ${it.path}" },
        )
        assertEquals(mapOf("text" to "hello"), stringBody(requests[1].body.readUtf8()))
        assertEquals(mapOf("text" to "hello room"), stringBody(requests[2].body.readUtf8()))
        assertEquals(
            mapOf("requestId" to "r1", "behavior" to "answer", "message" to "Yes"),
            stringBody(requests[3].body.readUtf8()),
        )
        assertEquals(mapOf("allowKey" to "Bash:git"), stringBody(requests[4].body.readUtf8()))
        assertEquals(mapOf("emoji" to "👍"), stringBody(requests[5].body.readUtf8()))
        assertEquals(mapOf("text" to "retry"), stringBody(requests[6].body.readUtf8()))
        assertEquals(mapOf("messageId" to "m2"), stringBody(requests[7].body.readUtf8()))
        assertEquals(mapOf("title" to "Next"), stringBody(requests[8].body.readUtf8()))
        assertEquals(mapOf("title" to "Renamed"), stringBody(requests[10].body.readUtf8()))
        assertEquals(mapOf("title" to "Channel next"), stringBody(requests[12].body.readUtf8()))
        assertEquals(mapOf("title" to "Channel renamed"), stringBody(requests[14].body.readUtf8()))
        // Unarchive is the one task PATCH that must carry an explicit null;
        // stamps stay plain integers, never scientific notation.
        assertEquals("""{"archivedAt":123}""", requests[20].body.readUtf8())
        assertEquals("""{"archivedAt":null}""", requests[21].body.readUtf8())
        requests.forEach { assertEquals("Bearer device-token", it.getHeader("Authorization")) }
    }

    @Test
    fun skillApprovalEchoesTheReviewedHashButDenialDoesNotNeedOne() = runBlocking {
        val hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        repeat(2) { server.enqueue(json("{}")) }

        client.respond("thread-1", "request-1", "allow", reviewedSha256 = hash)
        client.respond("thread-1", "request-2", "deny")

        assertEquals(
            mapOf(
                "requestId" to "request-1",
                "behavior" to "allow",
                "reviewedSha256" to hash,
            ),
            stringBody(server.takeRequest().body.readUtf8()),
        )
        assertEquals(
            mapOf("requestId" to "request-2", "behavior" to "deny"),
            stringBody(server.takeRequest().body.readUtf8()),
        )
    }

    @Test
    fun switchingTheVoiceEngineWritesOnlyTheProvider() = runBlocking {
        server.enqueue(json("""{"tts":{"configured":true,"provider":"chatterbox","voice":"ex01"}}"""))

        val status = client.updateVoiceProvider(VoiceProvider.CHATTERBOX)

        assertEquals(VoiceProvider.CHATTERBOX, status.voiceProvider)
        server.takeRequest().let { request ->
            assertEquals("PUT", request.method)
            assertEquals("/api/config", request.path)
            // The raw body rather than stringBody: the write is nested, and
            // the whole point is that the provider is the only field in it.
            assertEquals("""{"tts":{"provider":"chatterbox"}}""", request.body.readUtf8())
        }
    }

    @Test
    fun sharedUploadsAndSendUseRawBodiesAndStableIds() = runBlocking {
        server.enqueue(json("""{"path":"/Users/test/attachments/image.png","mime":"image/png","bytes":4}""", 201))
        server.enqueue(json("""{"path":"/Users/test/files/id.pdf","name":"Q3 plan.pdf","mime":"application/pdf","bytes":3}""", 201))
        server.enqueue(json("{}"))
        val imageUploadId = "7DB8737D-85B9-4BE5-A3D8-FA8D74EBA52B"
        val fileUploadId = "8E50CD29-DBB2-4D76-971B-112DD962C9FA"

        assertEquals("/Users/test/attachments/image.png", client.uploadImage(byteArrayOf(1, 2, 3, 4), "IMAGE/PNG", imageUploadId))
        assertEquals(
            UploadedFile("/Users/test/files/id.pdf", "Q3 plan.pdf"),
            client.uploadFile(byteArrayOf(1, 2, 3), "../Q3 plan.pdf", "application/pdf", fileUploadId),
        )
        client.send(
            text = "Review this",
            to = MessageDestination.Bot("bot-1", "task_1"),
            sendId = "share_1234567890123456",
        )

        val image = server.takeRequest()
        assertEquals("/api/attachments?uploadId=$imageUploadId", image.path)
        assertEquals("image/png", image.getHeader("Content-Type"))
        assertEquals("\u0001\u0002\u0003\u0004", image.body.readUtf8())
        val file = server.takeRequest()
        assertEquals("/api/files?name=Q3%20plan.pdf&uploadId=$fileUploadId", file.path)
        assertEquals("application/pdf", file.getHeader("Content-Type"))
        assertEquals("\u0001\u0002\u0003", file.body.readUtf8())
        val send = server.takeRequest()
        assertEquals("/api/bots/bot-1/messages", send.path)
        assertEquals(
            mapOf("text" to "Review this", "threadId" to "task_1", "sendId" to "share_1234567890123456"),
            stringBody(send.body.readUtf8()),
        )
    }

    @Test
    fun sharedSendAndUploadIdsRejectUnsafeValuesBeforeNetworking() = runBlocking {
        assertFailsWith<APIError.BadUrl> {
            client.send("No", MessageDestination.Bot("../config", "task"), "share_1234567890123456")
        }
        assertFailsWith<APIError.BadUrl> {
            client.uploadImage(byteArrayOf(1), "image/png", "not-an-upload-id")
        }
        assertFailsWith<APIError.BadUrl> {
            client.uploadFile(byteArrayOf(1), "notes.pdf", "application/pdf", "not-an-upload-id")
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun uploadsUseIdleTimeoutsWithoutACallDeadline() = runBlocking {
        data class Seen(
            val path: String?,
            val callTimeoutNanos: Long,
            val connectMs: Int,
            val readMs: Int,
            val writeMs: Int,
        )
        val seen = mutableListOf<Seen>()
        val base = okhttp3.OkHttpClient.Builder()
            .addInterceptor { chain ->
                seen += Seen(
                    path = chain.request().url.encodedPath,
                    callTimeoutNanos = chain.call().timeout().timeoutNanos(),
                    connectMs = chain.connectTimeoutMillis(),
                    readMs = chain.readTimeoutMillis(),
                    writeMs = chain.writeTimeoutMillis(),
                )
                chain.proceed(chain.request())
            }
            .build()
        val wired = CompanionClient(connection, "device-token", base)
        server.enqueue(json("""{"ok":true}"""))
        server.enqueue(json("""{"path":"/Users/test/attachments/image.png","mime":"image/png","bytes":4}""", 201))
        server.enqueue(json("""{"path":"/Users/test/files/id.pdf","name":"doc.pdf","mime":"application/pdf","bytes":3}""", 201))

        wired.health()
        wired.uploadImage(byteArrayOf(1, 2, 3, 4), "image/png")
        wired.uploadFile(byteArrayOf(1, 2, 3), "doc.pdf", "application/pdf")

        assertEquals(listOf("/api/health", "/api/attachments", "/api/files"), seen.map { it.path })
        val actionCallTimeout = java.util.concurrent.TimeUnit.SECONDS.toNanos(20)
        assertEquals(actionCallTimeout, seen[0].callTimeoutNanos)
        assertEquals(0L, seen[1].callTimeoutNanos)
        assertEquals(0L, seen[2].callTimeoutNanos)
        seen.forEach { timeouts ->
            assertEquals(20_000, timeouts.connectMs)
            assertEquals(20_000, timeouts.readMs)
            assertEquals(20_000, timeouts.writeMs)
        }
    }

    @Test
    fun eventRequestCarriesResumeCursorAndScreenChoice() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            "data: {\"kind\":\"hello\",\"cursor\":\"stream:7\",\"resumed\":true}\n\n",
        ))
        val frames = client.events("stream:6", screens = true).take(1).toList()
        assertEquals(1, frames.size)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("on", request.requestUrl?.queryParameter("screens"))
        assertEquals("stream:6", request.requestUrl?.queryParameter("since"))
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals("Bearer device-token", request.getHeader("Authorization"))
    }

    @Test
    fun statusErrorsCarryTheHarnessMessageAndUnauthorizedMeaning() = runBlocking {
        server.enqueue(json("""{"error":"The bot is occupied."}""", 409))
        val busy = assertFailsWith<APIError.Status> { client.createBot() }
        assertEquals(409, busy.code)
        assertEquals("The bot is occupied.", busy.message)
        assertFalse(busy.isUnauthorized)

        server.enqueue(json(fixtureText("unauthorized"), 401))
        val unauthorized = assertFailsWith<APIError.Status> { client.fleet() }
        assertTrue(unauthorized.isUnauthorized)
    }

    @Test
    fun opaqueIdsCannotReshapeTheRoute() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        client.markBotRead("../../evil")
        assertEquals("/api/bots/..%2F..%2Fevil/read", server.takeRequest().path)

        server.enqueue(json("""{"ok":true}"""))
        client.markRoomRead("g/../..")
        assertEquals("/api/groups/g%2F..%2F../read", server.takeRequest().path)

        // `%2e` is a dot to OkHttp's resolver, so the escape itself is escaped.
        server.enqueue(json("""{"ok":true}"""))
        client.interrupt("%2e%2e")
        assertEquals("/api/bots/%252e%252e/interrupt", server.takeRequest().path)

        server.enqueue(json("""{"ok":true}"""))
        client.markBotRead("b 1")
        assertEquals("/api/bots/b%201/read", server.takeRequest().path)

        server.enqueue(json("""{"ok":true}"""))
        client.deleteRoutine("r#1")
        assertEquals("/api/routines/r%231", server.takeRequest().path)
    }

    @Test
    fun idsThatAreOnlyPathSyntaxAreRefusedBeforeTheRequest() = runBlocking {
        assertFailsWith<APIError.BadUrl> { client.markBotRead("..") }
        assertFailsWith<APIError.BadUrl> { client.markBotRead(".") }
        assertFailsWith<APIError.BadUrl> { client.markBotRead("") }
        assertFailsWith<APIError.BadUrl> { client.deleteRoutine("..") }
        assertFailsWith<APIError.BadUrl> { client.image("t1", "..") }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun ordinaryIdsReachTheSameRouteAsBefore() = runBlocking {
        server.enqueue(json("""{"ok":true}"""))
        client.markBotRead("b-1.2_x~y")
        assertEquals("/api/bots/b-1.2_x~y/read", server.takeRequest().path)

        server.enqueue(json("""{"ok":true}"""))
        client.markRoomRead("g1")
        assertEquals("/api/groups/g1/read", server.takeRequest().path)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun stringBody(raw: String): Map<String, String> =
        CompanionJson.parseToJsonElement(raw).jsonObject.mapValues { it.value.jsonPrimitive.content }

    private fun botJson(): String {
        val root = CompanionJson.parseToJsonElement(fixtureText("bots-full")).jsonObject
        return root.getValue("bots").toString().removePrefix("[").removeSuffix("]")
    }

    private fun roomJson(): String = """{
        "id":"g-new",
        "threadId":"t-new",
        "name":"Launch Team",
        "memberIds":["b1","b2"],
        "defaultResponder":{"kind":"mentions"},
        "bulletin":"",
        "unread":false,
        "createdAt":3
    }""".trimIndent()
}
