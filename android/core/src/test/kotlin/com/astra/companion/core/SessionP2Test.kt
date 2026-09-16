package com.astra.companion.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class SessionP2Test {
    @Test
    fun updateProfileFoldsTheReturnedBotIntoSessionState() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
                .copy(id = "connection-1")
            val session = session(connection)
            session.awaitRestored()
            val original = decodeFixture<Fleet>("bot-avatar-profile").bots.first()
            val updatedJson = fixtureBotJson().replace(
                "\"name\":\"Scout\"",
                "\"name\":\"Mobile Scout\"",
            )
            server.enqueue(json("""{"bot":$updatedJson}"""))

            val updated = session.updateProfile(
                BotProfilePatch(name = "Mobile Scout"),
                forBot = original,
            )

            assertEquals("Mobile Scout", updated?.name)
            assertEquals("Mobile Scout", session.state.value.bot(original.id)?.name)
            val request = server.takeRequest()
            assertEquals("PATCH", request.method)
            assertEquals("/api/bots/avatar-bot/profile", request.path)
            assertEquals(
                setOf("name"),
                CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject.keys,
            )
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun routineSessionMethodsLoadSaveToggleRunAndDelete() = runTest {
        val server = MockWebServer()
        server.start()
        try {
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
                .copy(id = "connection-1")
            val session = session(connection)
            session.awaitRestored()
            val routineJson = routineJson()
            val runJson = routineRunJson()
            listOf(
                """{"routines":[$routineJson],"runs":[$runJson]}""",
                """{"routine":$routineJson}""",
                """{"routine":$routineJson}""",
                """{"routine":$routineJson}""",
                """{"run":$runJson}""",
                "{}",
            ).forEach { server.enqueue(json(it)) }

            val loaded = session.loadRoutines()
            val routine = assertNotNull(loaded.routines.firstOrNull())
            val input = RoutineInput(
                name = "Brief",
                prompt = "Summarize",
                botId = "bot-1",
                schedule = RoutineSchedule.once(2_000_000.0),
            )
            assertNotNull(session.saveRoutine(input, id = null))
            assertNotNull(session.saveRoutine(input, id = routine.id))
            assertNotNull(session.setRoutineEnabled(routine, enabled = false))
            assertEquals("task-1", session.runRoutine(routine)?.threadId)
            assertTrue(session.deleteRoutine(routine))

            assertEquals(
                listOf(
                    "GET /api/routines",
                    "POST /api/routines",
                    "PATCH /api/routines/routine-1",
                    "PATCH /api/routines/routine-1",
                    "POST /api/routines/routine-1/run",
                    "DELETE /api/routines/routine-1",
                ),
                List(6) { server.takeRequest() }.map { "${it.method} ${it.path}" },
            )
        } finally {
            server.shutdown()
        }
    }

    private fun kotlinx.coroutines.test.TestScope.session(connection: Connection): Session = Session(
        scope = backgroundScope,
        connectionStore = P2ConnectionStore(connection),
        tokenStore = P2TokenStore(connection.id, "paired-token"),
        onboardingStore = InMemoryOnboardingStore(),
        deviceNameProvider = { "Pixel" },
        eventsFn = { _, _, _ -> emptyFlow() },
    )

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun fixtureBotJson(): String = CompanionJson.parseToJsonElement(
        fixtureText("bot-avatar-profile"),
    ).jsonObject.getValue("bots").toString().removePrefix("[").removeSuffix("]")

    private fun routineJson(): String = """{
        "id":"routine-1","name":"Brief","prompt":"Summarize","botId":"bot-1",
        "runOn":"astra","enabled":true,"schedule":{"type":"once","at":2000000},
        "durationMinutes":30,"nextRunAt":2000000,"createdAt":1,"updatedAt":2
    }""".trimIndent()

    private fun routineRunJson(): String = """{
        "id":"run-1","routineId":"routine-1","routineName":"Brief","botId":"bot-1",
        "runOn":"astra","scheduledFor":2000000,"status":"completed","manual":true,
        "triggerSource":"manual","threadId":"task-1","createdAt":2000000
    }""".trimIndent()
}

private class P2ConnectionStore(initial: Connection) : ConnectionStore {
    private var connection: Connection? = initial

    override suspend fun load(): Connection? = connection

    override suspend fun save(connection: Connection) {
        this.connection = connection
    }

    override suspend fun clear() {
        connection = null
    }
}

private class P2TokenStore(connectionId: String, token: String) : TokenStore {
    private val values = mutableMapOf(connectionId to token)

    override suspend fun save(connectionId: String, token: String) {
        values[connectionId] = token
    }

    override suspend fun read(connectionId: String): TokenStore.ReadResult =
        values[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing

    override suspend fun remove(connectionId: String) {
        values.remove(connectionId)
    }
}
