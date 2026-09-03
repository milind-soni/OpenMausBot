package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * The narrow model route — the port of
 * `ios/Tests/CompanionCoreTests/BotModelClientTests.swift`. Every expectation
 * is read off the Swift, not back out of the Kotlin under test.
 */
class BotModelClientTest {
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
    fun updatesModelAndReasoningThroughTheNarrowRoute() = runBlocking {
        server.enqueue(json(botResponse(effort = "\"high\"")))

        val updated = client.updateModel(
            "bot-1",
            ModelSelection(instanceId = "codex", model = "gpt-5", effort = "high"),
        )

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/bots/bot-1/model", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("instanceId", "model", "effort"), body.keys)
        assertEquals("codex", body.getValue("instanceId").jsonPrimitive.content)
        assertEquals("gpt-5", body.getValue("model").jsonPrimitive.content)
        assertEquals("high", body.getValue("effort").jsonPrimitive.content)
        assertEquals("high", updated.modelSelection.effort)
    }

    @Test
    fun engineDefaultOmitsEffortRatherThanSendingNull() = runBlocking {
        server.enqueue(json(botResponse(effort = null)))

        val updated = client.updateModel("bot-1", ModelSelection(instanceId = "codex", model = "gpt-5"))

        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("instanceId", "model"), body.keys)
        assertNull(updated.modelSelection.effort)
    }

    @Test
    fun rejectsUnsafeBotIdsBeforeNetworking() = runBlocking {
        assertFailsWith<APIError.BadUrl> {
            client.updateModel("..", ModelSelection(instanceId = "codex", model = "gpt-5"))
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun decodesOptionalEffortAndInstanceEffortLevels() {
        val instance = CompanionJson.decodeFromString<Instance>(
            """
            {"instanceId":"codex","driverKind":"codex","snapshot":{"state":"available"},
             "models":{"default":"gpt-5","options":[{"id":"gpt-5","label":"GPT-5"}]},
             "capabilities":{"images":true,"effortLevels":["low","medium","high"]}}
            """.trimIndent(),
        )
        assertEquals(listOf("low", "medium", "high"), instance.capabilities?.effortLevels)

        val old = CompanionJson.decodeFromString<ModelSelection>("""{"instanceId":"codex","model":"gpt-5"}""")
        assertNull(old.effort)
        val new = CompanionJson.decodeFromString<ModelSelection>(
            """{"instanceId":"codex","model":"gpt-5","effort":"xhigh"}""",
        )
        assertEquals("xhigh", new.effort)
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun botResponse(effort: String?): String {
        val effortField = effort?.let { ""","effort":$it""" }.orEmpty()
        return """
            {"bot":{"id":"bot-1","threadId":"thread-1","name":"Scout","title":"","description":"",
             "notifications":true,"color":"#3366ff","unread":false,"createdAt":1.0,
             "modelSelection":{"instanceId":"codex","model":"gpt-5"$effortField}}}
        """.trimIndent()
    }
}
