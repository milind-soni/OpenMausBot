package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ProfileClientTest {
    private lateinit var server: MockWebServer
    private lateinit var connection: Connection
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        connection = requireNotNull(Connection.parse(server.url("/").toString()))
        client = CompanionClient(connection, "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun profilePatchPreservesServerLimitsWithoutClientTruncation() = runBlocking {
        val name = "n".repeat(100)
        val title = "t".repeat(200)
        val description = "d".repeat(4_000)
        val voice = "v".repeat(200)
        server.enqueue(json(botResponse()))

        client.updateProfile(
            "avatar-bot",
            BotProfilePatch(name = name, title = title, description = description, voice = voice),
        )

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/bots/avatar-bot/profile", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(name, body.getValue("name").jsonPrimitive.content)
        assertEquals(title, body.getValue("title").jsonPrimitive.content)
        assertEquals(description, body.getValue("description").jsonPrimitive.content)
        assertEquals(voice, body.getValue("voice").jsonPrimitive.content)
    }

    @Test
    fun profilePatchPreservesAnExplicitEmptyWorkspaceDefaultVoice() {
        val body = CompanionJson.parseToJsonElement(
            CompanionJson.encodeToString(BotProfilePatch(voice = "")),
        ).jsonObject

        assertEquals(setOf("voice"), body.keys)
        assertEquals("", body.getValue("voice").jsonPrimitive.content)
    }

    @Test
    fun profilePatchOmitsUnsetFieldsAndCanSendAnEmptyPayload() = runBlocking {
        server.enqueue(json(botResponse()))
        client.updateProfile("avatar-bot", BotProfilePatch())

        val request = server.takeRequest()
        assertEquals("{}", request.body.readUtf8())
        assertEquals("application/json; charset=utf-8", request.getHeader("Content-Type"))
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
    }

    @Test
    fun profilePatchIsClosedToThePairedSafeSurface() {
        val encoded = CompanionJson.encodeToString(
            BotProfilePatch(
                name = "Scout",
                title = "Researcher",
                description = "Finds evidence.",
                notifications = false,
                avatarUrl = BotProfilePatch.AvatarURL.Set(
                    "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
                ),
                avatarCrop = AvatarCrop.ROUNDED,
                voice = "voice-1",
                speakReplies = true,
            ),
        )
        assertEquals(
            setOf(
                "name",
                "title",
                "description",
                "notifications",
                "avatarUrl",
                "avatarCrop",
                "voice",
                "speakReplies",
            ),
            CompanionJson.parseToJsonElement(encoded).jsonObject.keys,
        )
        assertFailsWith<SerializationException> {
            CompanionJson.decodeFromString<BotProfilePatch>("""{"color":"red"}""")
        }
    }

    @Test
    fun profileClientSendsOnlyFieldsOwnedByTheAction() = runBlocking {
        server.enqueue(json(botResponse()))

        client.updateProfile(
            "avatar-bot",
            BotProfilePatch(avatarCrop = AvatarCrop.ROUNDED),
        )

        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("avatarCrop"), body.keys)
        assertEquals("rounded", body.getValue("avatarCrop").jsonPrimitive.content)
    }

    @Test
    fun profileClientEncodesAnExplicitAvatarClearAsNull() = runBlocking {
        server.enqueue(json(botResponse()))

        client.updateProfile(
            "avatar-bot",
            BotProfilePatch(
                avatarUrl = BotProfilePatch.AvatarURL.Clear,
                avatarCrop = AvatarCrop.MASCOT,
            ),
        )

        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("avatarCrop", "avatarUrl"), body.keys)
        assertEquals(JsonNull, body["avatarUrl"])
        assertEquals("mascot", body.getValue("avatarCrop").jsonPrimitive.content)
    }

    @Test
    fun avatarFetchAcceptsOnlyThePathsAcceptedByIos() = runBlocking {
        val valid = listOf(
            "/api/attachments/a.png",
            "/api/attachments/ABC-123.jpg",
            "/api/attachments/a.gif",
            "/api/attachments/a.webp",
        )
        valid.forEach { server.enqueue(MockResponse().setResponseCode(200).setBody("pixels")) }

        valid.forEach { path ->
            assertEquals("pixels", client.avatar(path).toString(Charsets.UTF_8))
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals(path, request.path)
            assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        }

        listOf(
            "/api/attachments/a.jpeg",
            "/api/attachments/a.JPG",
            "/api/attachments/a_b.png",
            "/api/attachments/a.b.png",
            "/api/attachments/nested/a.png",
            "/api/attachments/../a.png",
            "https://tracker.example/a.png",
        ).forEach { path ->
            assertFailsWith<APIError.BadUrl> { client.avatar(path) }
        }
        assertEquals(valid.size, server.requestCount)
    }

    @Test
    fun avatarUploadIsRawImageOnlyAndCappedAtTenMegabytes() = runBlocking {
        val limit = 10 * 1_024 * 1_024
        server.enqueue(json(
            """{"path":"/tmp/attachments/generated.png","mime":"image/png","bytes":$limit}""",
            code = 201,
        ))

        assertEquals(
            "/api/attachments/generated.png",
            client.uploadAvatar(ByteArray(limit), "image/png"),
        )
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/attachments", request.path)
        assertEquals("image/png", request.getHeader("Content-Type"))
        assertEquals(limit.toLong(), request.bodySize)

        assertFailsWith<APIError.Transport> {
            client.uploadAvatar(ByteArray(1), "text/plain")
        }
        assertFailsWith<APIError.Transport> {
            client.uploadAvatar(ByteArray(limit + 1), "image/jpeg")
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun avatarUploadAcceptsTheFourIosImageMimeTypes() = runBlocking {
        val mimeTypes = listOf("image/png", "image/jpeg", "image/gif", "image/webp")
        mimeTypes.forEachIndexed { index, mime ->
            server.enqueue(json(
                """{"path":"/tmp/attachments/generated-$index.png","mime":"$mime","bytes":1}""",
                code = 201,
            ))
        }

        mimeTypes.forEachIndexed { index, mime ->
            assertEquals(
                "/api/attachments/generated-$index.png",
                client.uploadAvatar(byteArrayOf(index.toByte()), mime),
            )
            assertEquals(mime, server.takeRequest().getHeader("Content-Type"))
        }
    }

    @Test
    fun avatarGenerationTruncatesThePromptAndOutlivesTheServerTimeout() = runBlocking {
        var observedReadTimeoutMillis = 0
        val timedClient = CompanionClient(
            connection,
            "paired-token",
            OkHttpClient.Builder().addInterceptor { chain ->
                observedReadTimeoutMillis = chain.readTimeoutMillis()
                chain.proceed(chain.request())
            }.build(),
        )
        server.enqueue(json(generatedAvatarResponse(), code = 201))

        timedClient.generateAvatar("avatar-bot", "p".repeat(401))

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/bots/avatar-bot/avatar/generate", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("p".repeat(400), body.getValue("prompt").jsonPrimitive.content)
        assertTrue(observedReadTimeoutMillis > 120_000)
    }

    @Test
    fun voiceRoutesReturnOnlyLabelsOrAudioAndBoundThePreviewText() = runBlocking {
        server.enqueue(json(
            """{"voices":[{"id":"voice-1","label":"Warm","description":"Calm"}]}""",
        ))
        server.enqueue(MockResponse()
            .setResponseCode(200)
            .setHeader("Content-Type", "audio/mpeg")
            .setBody("audio-bytes"))

        val voices = client.voices()
        assertEquals(listOf(Voice("voice-1", "Warm", "Calm")), voices)
        assertContentEquals(
            "audio-bytes".toByteArray(),
            client.previewVoice("x".repeat(501), "voice-1"),
        )

        val listRequest = server.takeRequest()
        assertEquals("GET", listRequest.method)
        assertEquals("/api/tts/voices", listRequest.path)
        val speakRequest = server.takeRequest()
        assertEquals("POST", speakRequest.method)
        assertEquals("/api/tts/speak", speakRequest.path)
        val body = CompanionJson.parseToJsonElement(speakRequest.body.readUtf8()).jsonObject
        assertEquals(setOf("text", "voiceId"), body.keys)
        assertEquals("x".repeat(500), body.getValue("text").jsonPrimitive.content)
        assertEquals("voice-1", body.getValue("voiceId").jsonPrimitive.content)
    }

    @Test
    fun overviewGrantsReachTheProfileSheetThroughTheSameClient() = runBlocking {
        server.enqueue(json(fixtureText("bot-overview-grants")))

        val overview = client.overview("bot-1")

        assertEquals("GET", server.takeRequest().method)
        assertEquals(
            listOf(
                BotOverviewGrant("gmail", BotOverviewGrantLevel.Partial, toolCount = 2),
                BotOverviewGrant("notion", BotOverviewGrantLevel.None, toolCount = 0),
                BotOverviewGrant("slack", BotOverviewGrantLevel.All, toolCount = 0),
            ),
            overview.grants,
        )
    }

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun botJson(): String = CompanionJson.parseToJsonElement(
        fixtureText("bot-avatar-profile"),
    ).jsonObject.getValue("bots").toString().removePrefix("[").removeSuffix("]")

    private fun botResponse(): String = """{"bot":${botJson()}}"""

    private fun generatedAvatarResponse(): String =
        """{"avatarUrl":"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp","bot":${botJson()}}"""
}
