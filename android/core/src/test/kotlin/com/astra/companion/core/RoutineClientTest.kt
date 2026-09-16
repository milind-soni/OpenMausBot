package com.astra.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
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

class RoutineClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        client = CompanionClient(connection, "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun routineCallsMatchThePairedAllowlistAndWireBodies() = runBlocking {
        val routine = routineJson()
        val run = routineRunJson()
        listOf(
            """{"routines":[$routine],"runs":[$run]}""",
            """{"routine":$routine}""",
            """{"routine":$routine}""",
            """{"routine":$routine}""",
            """{"routine":$routine}""",
            """{"run":$run}""",
            "{}",
        ).forEach { server.enqueue(json(it)) }

        val listed = client.routines()
        assertEquals(listOf("routine-1"), listed.routines.map(Routine::id))
        assertEquals(listOf("run-1"), listed.runs.map(RoutineRun::id))
        assertEquals(null, listed.routines.single().timeoutMinutes)
        assertEquals(null, listed.runs.single().timeoutMinutes)

        val exactName = "n".repeat(80)
        val exactPrompt = "p".repeat(20_000)
        client.createRoutine(
            RoutineInput(
                name = exactName,
                prompt = exactPrompt,
                botId = "bot-1",
                schedule = RoutineSchedule.once(2_000_000.0),
                durationMinutes = 5,
            ),
        )
        client.updateRoutine(
            "routine-1",
            RoutineInput(
                name = exactName,
                prompt = exactPrompt,
                botId = "bot-1",
                runOn = "cloud",
                enabled = false,
                schedule = RoutineSchedule.daily("08:05", listOf(1, 2, 3, 4, 5)),
                durationMinutes = 240,
                timeoutMinutes = 240,
            ),
        )
        client.updateRoutine(
            "routine-1",
            RoutineInput(
                name = exactName,
                prompt = exactPrompt,
                botId = "bot-1",
                schedule = RoutineSchedule.interval(
                    everyMinutes = 15,
                    anchorAtMillis = 2_500_000L,
                ),
                clearTimeout = true,
            ),
        )
        client.setRoutineEnabled("routine-1", true)
        client.runRoutine("routine-1")
        client.deleteRoutine("routine-1")

        val requests = List(7) { server.takeRequest() }
        assertEquals(
            listOf(
                "GET /api/routines",
                "POST /api/routines",
                "PATCH /api/routines/routine-1",
                "PATCH /api/routines/routine-1",
                "PATCH /api/routines/routine-1",
                "POST /api/routines/routine-1/run",
                "DELETE /api/routines/routine-1",
            ),
            requests.map { "${it.method} ${it.path}" },
        )
        requests.forEach { assertEquals("Bearer paired-token", it.getHeader("Authorization")) }

        val create = CompanionJson.parseToJsonElement(requests[1].body.readUtf8()).jsonObject
        assertEquals(
            setOf(
                "name",
                "prompt",
                "botId",
                "runOn",
                "schedule",
                "durationMinutes",
            ),
            create.keys,
        )
        assertEquals(exactName, create.getValue("name").jsonPrimitive.content)
        assertEquals(exactPrompt, create.getValue("prompt").jsonPrimitive.content)
        assertEquals("maus", create.getValue("runOn").jsonPrimitive.content)
        assertEquals(5, create.getValue("durationMinutes").jsonPrimitive.content.toInt())
        assertFalse("timeoutMinutes" in create)
        assertEquals(
            mapOf("type" to "once", "at" to "2000000.0"),
            create.getValue("schedule").jsonObject.mapValues { it.value.jsonPrimitive.content },
        )

        val update = CompanionJson.parseToJsonElement(requests[2].body.readUtf8()).jsonObject
        assertEquals("cloud", update.getValue("runOn").jsonPrimitive.content)
        assertFalse(update.getValue("enabled").jsonPrimitive.content.toBoolean())
        assertEquals(240, update.getValue("durationMinutes").jsonPrimitive.content.toInt())
        assertEquals(240, update.getValue("timeoutMinutes").jsonPrimitive.content.toInt())
        val schedule = update.getValue("schedule").jsonObject
        assertEquals("daily", schedule.getValue("type").jsonPrimitive.content)
        assertEquals("08:05", schedule.getValue("time").jsonPrimitive.content)
        assertEquals(
            listOf(1, 2, 3, 4, 5),
            schedule.getValue("weekdays").jsonArray.map { it.jsonPrimitive.content.toInt() },
        )

        val intervalUpdate = CompanionJson.parseToJsonElement(requests[3].body.readUtf8()).jsonObject
        val interval = intervalUpdate.getValue("schedule").jsonObject
        assertEquals(
            mapOf(
                "type" to "interval",
                "everyMinutes" to "15",
                "anchorAt" to "2500000",
            ),
            interval.mapValues { it.value.jsonPrimitive.content },
        )
        assertEquals(JsonNull, intervalUpdate.getValue("timeoutMinutes"))

        assertEquals(
            mapOf("enabled" to "true"),
            CompanionJson.parseToJsonElement(requests[4].body.readUtf8())
                .jsonObject.mapValues { it.value.jsonPrimitive.content },
        )
        assertEquals(0, requests[5].bodySize)
        assertEquals(0, requests[6].bodySize)

        assertFailsWith<APIError.Transport> {
            client.createRoutine(
                RoutineInput(
                    name = "Future schedule",
                    prompt = "Do work",
                    botId = "bot-1",
                    schedule = RoutineSchedule(
                        type = RoutineSchedule.Kind.UNKNOWN,
                        time = "09:00",
                        weekdays = listOf(1),
                    ),
                ),
            )
        }
        assertFailsWith<APIError.Transport> {
            client.createRoutine(
                RoutineInput(
                    name = "Broken interval",
                    prompt = "Do work",
                    botId = "bot-1",
                    schedule = RoutineSchedule(
                        type = RoutineSchedule.Kind.INTERVAL,
                        everyMinutes = 4,
                        anchorAt = 2_500_000L,
                    ),
                ),
            )
        }
        assertFailsWith<APIError.Transport> {
            client.createRoutine(
                RoutineInput(
                    name = "Broken timeout",
                    prompt = "Do work",
                    botId = "bot-1",
                    schedule = RoutineSchedule.daily("09:00", listOf(1)),
                    timeoutMinutes = 241,
                ),
            )
        }
        assertEquals(7, server.requestCount)
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun routineJson(): String = """{
        "id":"routine-1",
        "name":"Brief",
        "prompt":"Summarize",
        "botId":"bot-1",
        "runOn":"astra",
        "enabled":true,
        "schedule":{"type":"once","at":2000000},
        "durationMinutes":30,
        "nextRunAt":2000000,
        "createdAt":1,
        "updatedAt":2
    }""".trimIndent()

    private fun routineRunJson(): String = """{
        "id":"run-1",
        "routineId":"routine-1",
        "routineName":"Brief",
        "prompt":"Summarize",
        "durationMinutes":30,
        "botId":"bot-1",
        "runOn":"astra",
        "scheduledFor":2000000,
        "status":"completed",
        "manual":true,
        "triggerSource":"manual",
        "threadId":"task-1",
        "startedAt":2000001,
        "finishedAt":2000002,
        "output":"Done",
        "createdAt":2000000
    }""".trimIndent()
}
