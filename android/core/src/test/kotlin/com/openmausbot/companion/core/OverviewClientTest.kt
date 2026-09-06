package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OverviewClientTest {
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
    fun fetchesABotOverview() = runBlocking {
        server.enqueue(json(fixtureText("bot-overview")))

        val overview = client.overview("bot-1")

        assertEquals("Kiwi", overview.who.name)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/bots/bot-1/overview", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
    }

    private fun json(body: String, code: Int = 200): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
