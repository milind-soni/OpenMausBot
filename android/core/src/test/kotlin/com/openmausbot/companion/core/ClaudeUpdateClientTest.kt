package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The in-chat Claude Code update route. */
class ClaudeUpdateClientTest {
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
    fun postsAnEmptyObjectAndReturnsTheNewVersion() = runBlocking {
        server.enqueue(json("""{"ok":true,"version":"2.3.1 (Claude Code)"}"""))

        val version = client.updateClaude("claude-code.local")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/instances/claude-code.local/claude-update", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertTrue(body.isEmpty())
        assertEquals("2.3.1 (Claude Code)", version)
    }

    @Test
    fun theHarnessRefusalReachesThePersonInItsOwnWords() = runBlocking {
        server.enqueue(json("""{"error":"Stop the running Claude turn first, then update."}""", code = 409))

        val error = assertFailsWith<APIError.Status> { client.updateClaude("claude") }

        assertEquals(409, error.code)
        assertEquals("Stop the running Claude turn first, then update.", error.message)
    }

    @Test
    fun refusesIdsThatAreNotInstanceIdsWithoutCallingTheComputer() = runBlocking {
        listOf("", ".", "..", "a/b", "a b", "ä", "../x").forEach { bad ->
            assertFailsWith<APIError.BadUrl>(bad) { client.updateClaude(bad) }
        }
        assertEquals(0, server.requestCount)
    }

    private fun json(body: String, code: Int = 200) = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
