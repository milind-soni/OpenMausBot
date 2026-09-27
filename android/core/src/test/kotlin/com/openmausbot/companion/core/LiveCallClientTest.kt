package com.openmausbot.companion.core

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull

/**
 * The four `/api/live` calls, against the HTTP contract in
 * `docs/superpowers/specs/2026-09-25-live-call-bar-design.md` and
 * `server/routes/live.ts`.
 * Expectations are read off that contract, not off the Kotlin under test.
 */
class LiveCallClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    private val call =
        """{"callId":"c1","botId":"bot-1","threadId":"t1","client":"android","voice":"marin","startedAt":1790000000000,"status":"connecting"}"""

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
    fun startPostsTheOfferByteForByteAndReturnsTheAnswer() = runBlocking {
        server.enqueue(json(201, """{"call":$call,"transport":{"type":"webrtc","sdp":"v=0\r\nanswer \r\n"}}"""))

        val started = client.startLiveCall("bot-1", "t1", "v=0\r\na=x \r\n")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/live/session", request.path)
        assertEquals("Bearer paired-token", request.getHeader("Authorization"))
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("botId", "threadId", "sdp", "client"), body.keys)
        assertEquals("bot-1", body.getValue("botId").jsonPrimitive.content)
        assertEquals("t1", body.getValue("threadId").jsonPrimitive.content)
        assertEquals("v=0\r\na=x \r\n", body.getValue("sdp").jsonPrimitive.content)
        assertEquals("android", body.getValue("client").jsonPrimitive.content)
        val result = assertIs<LiveCallStart.Started>(started)
        assertEquals("c1", result.call.callId)
        assertEquals("v=0\r\nanswer \r\n", result.answerSdp)
    }

    @Test
    fun aMacWithoutAKeyIsNeedsKeyNotABusyBot() = runBlocking {
        server.enqueue(json(409, """{"error":"Add an OpenAI API key to use Live calls.","needsKey":true}"""))
        val result = assertIs<LiveCallStart.NeedsKey>(client.startLiveCall("bot-1", "t1", "v=0"))
        assertEquals("Add an OpenAI API key to use Live calls.", result.message)
    }

    @Test
    fun aRunningCallComesBackAsBusyWithWhoIsOnTheLine() = runBlocking {
        val active = call.replace("\"client\":\"android\"", "\"client\":\"desktop\"")
        server.enqueue(json(409, """{"error":"A Live call is already running.","activeCall":$active}"""))
        val result = assertIs<LiveCallStart.Busy>(client.startLiveCall("bot-1", "t1", "v=0"))
        assertEquals("desktop", result.activeCall.client)
        assertEquals("c1", result.activeCall.callId)
        assertEquals("A Live call is already running.", result.message)
    }

    @Test
    fun otherRefusalsThrowWithTheServersWords() = runBlocking {
        server.enqueue(json(409, """{"error":"Some other conflict."}"""))
        val conflict = assertFailsWith<APIError.Status> { client.startLiveCall("bot-1", "t1", "v=0") }
        assertEquals(409, conflict.code)
        assertEquals("Some other conflict.", conflict.message)

        server.enqueue(json(502, """{"error":"OpenAI refused the call (HTTP 401)."}"""))
        val refused = assertFailsWith<APIError.Status> { client.startLiveCall("bot-1", "t1", "v=0") }
        assertEquals(502, refused.code)
        assertEquals("OpenAI refused the call (HTTP 401).", refused.message)
    }

    @Test
    fun startWaitsLongerThanAnOrdinaryActionForTheMacToReachOpenAI() = runBlocking<Unit> {
        // The harness may spend 20 s on OpenAI and the sidecar allows 30 s for
        // headers; the 20 s action client would have given up here. Slow on
        // purpose (22 s): it is the one proof that the dedicated client is used.
        server.enqueue(
            json(201, """{"call":$call,"transport":{"type":"webrtc","sdp":"v=0\r\n"}}""")
                .setHeadersDelay(22, TimeUnit.SECONDS),
        )
        assertIs<LiveCallStart.Started>(client.startLiveCall("bot-1", "t1", "v=0"))
    }

    @Test
    fun endPostsTheCallIdAndReturnsTheEndedCall() = runBlocking {
        server.enqueue(json(200, """{"call":${call.replace("connecting", "ended")}}"""))
        val ended = client.endLiveCall("c1")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/live/call/end", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(mapOf("callId" to "c1"), body.mapValues { it.value.jsonPrimitive.content })
        assertEquals(LiveCallStatus.ENDED, ended.status)

        server.enqueue(json(404, """{"error":"That call is not running."}"""))
        assertEquals(404, assertFailsWith<APIError.Status> { client.endLiveCall("zz") }.code)
    }

    @Test
    fun liveCallReadsTheCurrentCallOrNull() = runBlocking {
        server.enqueue(json(200, """{"call":null}"""))
        assertNull(client.liveCall())
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/live/call", request.path)

        server.enqueue(json(200, """{"call":$call}"""))
        assertEquals("c1", client.liveCall()?.callId)
    }

    @Test
    fun settingsPatchSendsOnlyTheChangedFieldsAndNeverAKey() = runBlocking {
        server.enqueue(json(200, """{"live":{"configured":true,"voice":"marin","readTypedReplies":false,"idleMinutes":10}}"""))
        val live = client.updateLiveSettings(LiveSettingsPatch(readTypedReplies = false, idleMinutes = 10))
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/live/settings", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("readTypedReplies", "idleMinutes"), body.keys)
        assertEquals(LiveSettings(true, "marin", false, 10), live)
    }

    private fun json(code: Int, body: String): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
