package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The activity log and team memory calls: the paths and queries the sidecar
 * allowlist expects, and the bodies the harness routes parse. Mirrors
 * `ios/Tests/CompanionCoreTests/ActivityClientTests.swift`.
 */
class ActivityClientTest {
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

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun readsTheActivityLogWithALimit() = runBlocking {
        server.enqueue(json("""{"rows":[{"at":"2026-09-07T09:00:00.000Z","threadId":"t1","tool":"GMAIL_SEND_EMAIL","app":"Gmail","label":"Send email","summary":"to finance@","outcome":"waiting"}]}"""))

        val rows = client.activity("bot_1", limit = 50)

        val request = server.takeRequest()
        assertEquals("/api/bots/bot_1/activity?limit=50", request.path)
        assertEquals(1, rows.size)
        assertEquals("Gmail", rows[0].app)
        assertEquals("waiting", rows[0].outcome)
    }

    @Test
    fun readsTeamMemoryForTheGeneralSection() = runBlocking {
        server.enqueue(json("""{"section":"","label":"General","entries":[]}"""))

        val page = client.teamMemory("")

        // the harness requires the parameter even when it is empty
        assertEquals("/api/team-memory?section=", server.takeRequest().path)
        assertEquals("General", page.label)
    }

    @Test
    fun remembersAProposalWithAnAcceptPatchAndSkipsWithADelete() = runBlocking {
        server.enqueue(json("""{"entries":[]}"""))
        server.enqueue(json("""{"entries":[]}"""))

        client.answerTeamMemory("Work", "entry_1", remember = true)
        val patch = server.takeRequest()
        assertEquals("PATCH", patch.method)
        assertEquals("/api/team-memory/entry_1?section=Work", patch.path)
        assertTrue(patch.body.readUtf8().contains("\"accept\":true"))

        client.answerTeamMemory("", "entry_1", remember = false)
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/team-memory/entry_1?section=", delete.path)
    }

    @Test
    fun addsAnEntryByHand() = runBlocking {
        server.enqueue(json("""{"entries":[{"id":"e1","kind":"term","name":"MCHQ","detail":"MissionControlHQ","aliases":[],"status":"accepted","source":{"botId":"","botName":"you","threadId":"","at":1},"updatedAt":1}]}"""))

        val entries = client.addTeamMemory("", kind = "term", name = "MCHQ", detail = "MissionControlHQ")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/team-memory?section=", request.path)
        assertTrue(request.body.readUtf8().contains("\"kind\":\"term\""))
        assertEquals("MCHQ", entries.first().name)
    }
}
