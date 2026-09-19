package com.openmausbot.companion.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The calls a call makes — the voice half of `Client.swift` on the call-mode branch. */
class VoiceClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: CompanionClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = CompanionClient(requireNotNull(Connection.parse(server.url("/").toString())), "paired-token")
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun prepareSendsTheWholeReplyAndTheBotsVoice() = runBlocking {
        server.enqueue(json("""{"ready":true,"utterances":["One.","Two."]}"""))
        val prepared = client.prepareSpeech("One. Two.", "rachel")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/tts/prepare", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("One. Two.", body.getValue("text").jsonPrimitive.content)
        assertEquals("rachel", body.getValue("voiceId").jsonPrimitive.content)
        assertTrue(prepared.ready)
        assertEquals(listOf("One.", "Two."), prepared.utterances)
    }

    @Test
    fun aMissingVoiceMeansTheWorkspaceDefaultAndIsNotSentAsAnEmptyString() = runBlocking {
        server.enqueue(json("""{"ready":false,"utterances":[]}"""))
        val prepared = client.prepareSpeech("Hello", null)
        val body = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("text"), body.keys)
        assertFalse(prepared.ready)

        server.enqueue(MockResponse().setHeader("Content-Type", "audio/mpeg").setBody("mp3"))
        client.speak("Hello", "")
        val speak = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals(setOf("text"), speak.keys)
    }

    @Test
    fun speakCapsOneUtteranceAtTheServersFiveHundredCharacters() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "audio/mpeg").setBody("mp3"))
        val audio = client.speak("a".repeat(600), "rachel")
        val request = server.takeRequest()
        assertEquals("/api/tts/speak", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(500, body.getValue("text").jsonPrimitive.content.length)
        assertEquals("rachel", body.getValue("voiceId").jsonPrimitive.content)
        assertContentEquals("mp3".toByteArray(), audio)
    }

    @Test
    fun theKeyTravelsAsExactlyTheVoiceShapeTheCompanionForwards() = runBlocking {
        server.enqueue(json("{}"))
        client.updateVoiceKey("  sk_live_abc  ")
        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/config", request.path)
        val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(setOf("tts"), body.keys)
        val tts = body.getValue("tts").jsonObject
        assertEquals(setOf("key"), tts.keys)
        assertEquals("sk_live_abc", tts.getValue("key").jsonPrimitive.content)

        server.enqueue(json("{}"))
        client.updateVoiceProvider("system")
        val provider = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("system", provider.getValue("tts").jsonObject.getValue("provider").jsonPrimitive.content)
    }

    @Test
    fun anEmptyKeyRemovesIt() = runBlocking {
        server.enqueue(json("{}"))
        client.updateVoiceKey("")
        val tts = CompanionJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.getValue("tts").jsonObject
        assertEquals("", tts.getValue("key").jsonPrimitive.content)
    }

    @Test
    fun somethingThatIsNotAKeyNeverLeavesThePhone() = runBlocking {
        assertFailsWith<APIError.Transport> { client.updateVoiceKey("a\nb") }
        assertFailsWith<APIError.Transport> { client.updateVoiceKey("k".repeat(513)) }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theServersRefusalReadsAsItsOwnSentence() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(400).setHeader("Content-Type", "application/json").setBody("""{"error":"ElevenLabs rejected that key"}"""))
        val error = assertFailsWith<APIError.Status> { client.updateVoiceKey("bad") }
        assertEquals("ElevenLabs rejected that key", error.message)
    }

    private fun json(body: String): MockResponse =
        MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body)
}
