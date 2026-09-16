package com.astra.companion.ui

import com.astra.companion.avatar.AvatarImageRules
import com.astra.companion.core.AvatarCrop
import com.astra.companion.core.Bot
import com.astra.companion.core.BotProfilePatch
import com.astra.companion.core.CompanionJson
import com.astra.companion.core.ConfigFlag
import com.astra.companion.core.ConfigStatus
import com.astra.companion.core.Connection
import com.astra.companion.core.ConnectionStore
import com.astra.companion.core.Fleet
import com.astra.companion.core.InMemoryOnboardingStore
import com.astra.companion.core.ModelSelection
import com.astra.companion.core.RoutineRunLocation
import com.astra.companion.core.RoutineSchedule
import com.astra.companion.core.Session
import com.astra.companion.core.TokenStore
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * What the profile sheet and the routine editor actually put on the wire.
 *
 * The rules objects decide, but only a request proves the decision survives the
 * serializer: an omitted field and a field set to `null` are two different
 * instructions to the server (`ios/Sources/CompanionCore/Models.swift:420-481`),
 * and truncation that happens after the encoder would be invisible to a pure
 * test. So this drives a real [Session] against a real socket, with the bodies
 * built exactly the way `AgentProfileView.profilePatch` and
 * `RoutineEditorView.save` build theirs.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ProfileRoutineWireTest {
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
    fun `saving an untouched profile sends an empty patch`() = runTest {
        val session = session()
        val form = ProfileForm.of(bot)
        server.enqueue(botResponse(bot))

        session.updateProfile(ProfileRules.patch(form, form, speaking), bot)

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/bots/bot-1/profile", request.path)
        assertEquals(emptySet(), body(request).keys)
    }

    @Test
    fun `saving an edited profile sends only what changed`() = runTest {
        val session = session()
        val baseline = ProfileForm.of(bot)
        val form = baseline.copy(
            name = "  Scout II ",
            description = " Finds things, faster ",
            notifications = false,
        )
        server.enqueue(botResponse(bot.copy(name = "Scout II")))

        session.updateProfile(ProfileRules.patch(form, baseline, speaking), bot)

        val sent = body(server.takeRequest())
        assertEquals(setOf("name", "description", "notifications"), sent.keys)
        assertEquals("Scout II", sent.getValue("name").jsonPrimitive.content)
        assertEquals("Finds things, faster", sent.getValue("description").jsonPrimitive.content)
        assertEquals(false, sent.getValue("notifications").jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `choosing the workspace default sends an empty voice, not an omitted one`() = runTest {
        val session = session()
        val baseline = ProfileForm.of(bot.copy(voice = "voice-7", speakReplies = true))
        val form = baseline.copy(voice = "")
        server.enqueue(botResponse(bot))

        session.updateProfile(ProfileRules.patch(form, baseline, speaking), bot)

        val sent = body(server.takeRequest())
        assertEquals(setOf("voice"), sent.keys, "the default still speaks, so the toggle is unchanged")
        assertEquals("", sent.getValue("voice").jsonPrimitive.content)
    }

    @Test
    fun `a voice nothing can speak turns the toggle off on the wire`() = runTest {
        val session = session()
        val baseline = ProfileForm.of(bot.copy(voice = "voice-7", speakReplies = true))
        val form = baseline.copy(voice = "")
        server.enqueue(botResponse(bot))

        session.updateProfile(ProfileRules.patch(form, baseline, configuredWithoutDefault), bot)

        val sent = body(server.takeRequest())
        assertEquals(setOf("voice", "speakReplies"), sent.keys)
        assertEquals("", sent.getValue("voice").jsonPrimitive.content)
        assertEquals(false, sent.getValue("speakReplies").jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `Use mascot clears the stored image with a JSON null`() = runTest {
        val session = session()
        server.enqueue(botResponse(bot))

        session.updateProfile(
            BotProfilePatch(
                avatarUrl = BotProfilePatch.AvatarURL.Clear,
                avatarCrop = AvatarCrop.MASCOT,
            ),
            bot,
        )

        val sent = body(server.takeRequest())
        assertEquals(setOf("avatarUrl", "avatarCrop"), sent.keys)
        assertEquals(JsonNull, sent.getValue("avatarUrl"))
        assertEquals("mascot", sent.getValue("avatarCrop").jsonPrimitive.content)
    }

    @Test
    fun `an upload posts the raw image and then persists the drawable crop`() = runTest {
        val session = session()
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1, 2, 3)
        val prepared = AvatarImageRules.prepare(png)
        assertTrue(prepared is com.astra.companion.avatar.PreparedAvatar.Ready)
        server.enqueue(
            json("""{"path":"/store/avatars/abc-1.png","mime":"image/png","bytes":7}"""),
        )
        server.enqueue(botResponse(bot.copy(avatarUrl = "/api/attachments/abc-1.png")))

        // The selector still says Mascot, which is not a crop an image can wear.
        val intended = AvatarImageRules.intendedUploadCrop(AvatarCrop.MASCOT)
        session.uploadAvatar(prepared.data, prepared.mime, bot, intended)

        val upload = server.takeRequest()
        assertEquals("POST", upload.method)
        assertEquals("/api/attachments", upload.path)
        assertEquals("image/png", upload.getHeader("Content-Type"))
        assertEquals(png.toList(), upload.body.readByteArray().toList())

        val patch = body(server.takeRequest())
        assertEquals(setOf("avatarUrl", "avatarCrop"), patch.keys)
        assertEquals("/api/attachments/abc-1.png", patch.getValue("avatarUrl").jsonPrimitive.content)
        assertEquals("circle", patch.getValue("avatarCrop").jsonPrimitive.content)
    }

    @Test
    fun `a preview asks for this agent's greeting in the chosen voice`() = runTest {
        val session = session()
        server.enqueue(MockResponse().setResponseCode(200).setBody("audio-bytes"))

        session.previewVoice("voice-7", bot)

        val request = server.takeRequest()
        assertEquals("/api/tts/speak", request.path)
        val sent = body(request)
        assertEquals("Hello, I'm Scout.", sent.getValue("text").jsonPrimitive.content)
        assertEquals("voice-7", sent.getValue("voiceId").jsonPrimitive.content)
    }

    @Test
    fun `a new daily routine posts trimmed, capped fields and a cron-free schedule`() = runTest {
        val session = session()
        server.enqueue(json("""{"routine":${CompanionJson.encodeToString(routineJson())}}"""))

        val schedule = RoutineRules.schedule(
            kind = RoutineSchedule.Kind.DAILY,
            onceAtMillis = 0.0,
            hour = 7,
            minute = 5,
            weekdays = setOf(5, 1),
        )
        session.saveRoutine(
            RoutineRules.input(
                name = "  " + "n".repeat(120),
                prompt = " Do the thing ",
                botId = "bot-1",
                runOn = RoutineRunLocation.MAUS,
                enabled = null,
                schedule = schedule,
                durationMinutes = 45,
            ),
            id = null,
        )

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/routines", request.path)
        val sent = body(request)
        assertEquals(
            setOf(
                "name",
                "prompt",
                "botId",
                "runOn",
                "schedule",
                "durationMinutes",
                "timeoutMinutes",
            ),
            sent.keys,
            "a new routine sends no enabled flag",
        )
        assertEquals(80, sent.getValue("name").jsonPrimitive.content.length)
        assertEquals("Do the thing", sent.getValue("prompt").jsonPrimitive.content)
        assertEquals("maus", sent.getValue("runOn").jsonPrimitive.content)
        assertEquals(45, sent.getValue("durationMinutes").jsonPrimitive.int)
        assertEquals(JsonNull, sent.getValue("timeoutMinutes"))

        val wire = sent.getValue("schedule").jsonObject
        assertEquals(setOf("type", "time", "weekdays"), wire.keys, "no cron field, and no instant")
        assertEquals("daily", wire.getValue("type").jsonPrimitive.content)
        assertEquals("07:05", wire.getValue("time").jsonPrimitive.content)
        assertEquals(
            listOf(1, 5),
            wire.getValue("weekdays").jsonArray.map { it.jsonPrimitive.int },
        )
    }

    @Test
    fun `an interval routine posts only its cadence and anchor`() = runTest {
        val session = session()
        server.enqueue(json("""{"routine":${CompanionJson.encodeToString(routineJson())}}"""))

        session.saveRoutine(
            RoutineRules.input(
                name = "Frequent check",
                prompt = "Check for updates",
                botId = "bot-1",
                runOn = RoutineRunLocation.MAUS,
                enabled = null,
                schedule = RoutineRules.schedule(
                    kind = RoutineSchedule.Kind.INTERVAL,
                    onceAtMillis = 1_700_000_000_000.0,
                    hour = 0,
                    minute = 0,
                    weekdays = emptySet(),
                    everyMinutes = 5,
                ),
                durationMinutes = RoutineRules.LEGACY_DURATION_MINUTES,
                timeoutMinutes = RoutineRules.DEFAULT_INTERVAL_TIMEOUT,
            ),
            id = null,
        )

        val sent = body(server.takeRequest())
        assertEquals(30, sent.getValue("durationMinutes").jsonPrimitive.int)
        assertEquals(30, sent.getValue("timeoutMinutes").jsonPrimitive.int)
        val wire = sent.getValue("schedule").jsonObject
        assertEquals(setOf("type", "everyMinutes", "anchorAt"), wire.keys)
        assertEquals("interval", wire.getValue("type").jsonPrimitive.content)
        assertEquals(5, wire.getValue("everyMinutes").jsonPrimitive.int)
        assertEquals("1700000000000", wire.getValue("anchorAt").jsonPrimitive.content)
    }

    @Test
    fun `a prompt longer than the contract's limit is cut before it reaches the wire`() = runTest {
        // `String(prompt.trimming….prefix(20_000))` in `RoutineEditorView.save`.
        // The cap has to survive the encoder, not only the intermediate object.
        val session = session()
        server.enqueue(json("""{"routine":${CompanionJson.encodeToString(routineJson())}}"""))

        session.saveRoutine(
            RoutineRules.input(
                name = "Nightly",
                prompt = "  " + "p".repeat(30_000) + "  ",
                botId = "bot-1",
                runOn = RoutineRunLocation.MAUS,
                enabled = null,
                schedule = RoutineSchedule.daily("09:00", listOf(1)),
                durationMinutes = 30,
            ),
            id = null,
        )

        val sent = body(server.takeRequest()).getValue("prompt").jsonPrimitive.content
        assertEquals(20_000, sent.length)
        assertEquals("p".repeat(20_000), sent, "trimmed first, then cut")
    }

    @Test
    fun `editing a routine keeps its enabled state and PATCHes its id`() = runTest {
        val session = session()
        server.enqueue(json("""{"routine":${CompanionJson.encodeToString(routineJson())}}"""))

        session.saveRoutine(
            RoutineRules.input(
                name = "Nightly",
                prompt = "Do the thing",
                botId = "bot-1",
                runOn = RoutineRunLocation.CLOUD,
                enabled = false,
                schedule = RoutineRules.schedule(
                    kind = RoutineSchedule.Kind.ONCE,
                    onceAtMillis = 1_700_000_000_000.0,
                    hour = 0,
                    minute = 0,
                    weekdays = emptySet(),
                ),
                durationMinutes = 30,
            ),
            id = "routine-1",
        )

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/routines/routine-1", request.path)
        val sent = body(request)
        assertEquals(false, sent.getValue("enabled").jsonPrimitive.content.toBoolean())
        assertEquals("cloud", sent.getValue("runOn").jsonPrimitive.content)
        val wire = sent.getValue("schedule").jsonObject
        assertEquals(setOf("type", "at"), wire.keys)
        assertEquals("once", wire.getValue("type").jsonPrimitive.content)
    }

    private val bot = Bot(
        id = "bot-1",
        threadId = "task-1",
        name = "Scout",
        title = "research",
        description = "Finds things",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance-1", "model-1"),
        createdAt = 0.0,
    )

    private val speaking = ConfigStatus(tts = ConfigFlag(configured = true, voice = "shared-voice"))
    private val configuredWithoutDefault = ConfigStatus(tts = ConfigFlag(configured = true))

    private fun routineJson(): JsonObject = buildJsonObject {
        put("id", CompanionJson.encodeToJsonElement("routine-1"))
        put("name", CompanionJson.encodeToJsonElement("Nightly"))
        put("prompt", CompanionJson.encodeToJsonElement("Do the thing"))
        put("botId", CompanionJson.encodeToJsonElement("bot-1"))
        put("runOn", CompanionJson.encodeToJsonElement("astra"))
        put("enabled", CompanionJson.encodeToJsonElement(true))
        put("schedule", CompanionJson.encodeToJsonElement(RoutineSchedule.daily("09:00", listOf(1))))
        put("durationMinutes", CompanionJson.encodeToJsonElement(30))
        put("createdAt", CompanionJson.encodeToJsonElement(0.0))
        put("updatedAt", CompanionJson.encodeToJsonElement(0.0))
    }

    private fun botResponse(bot: Bot): MockResponse =
        json("""{"bot":${CompanionJson.encodeToString(Bot.serializer(), bot)}}""")

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun body(request: RecordedRequest): Map<String, kotlinx.serialization.json.JsonElement> =
        CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject

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
}
