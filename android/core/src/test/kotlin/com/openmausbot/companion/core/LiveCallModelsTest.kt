package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Live-call wire shapes from `shared/wire.ts` (`LiveCallState`,
 * `LiveSettings`, `Message.via`), decoded the way the harness writes them.
 * Inline JSON on purpose: the shared iOS fixtures under
 * `ios/Tests/CompanionCoreTests/Fixtures` stay untouched.
 */
class LiveCallModelsTest {
    @Test
    fun decodesACallStateAsTheHarnessWritesIt() {
        val call = CompanionJson.decodeFromString<LiveCallState>(
            """{"callId":"c1","botId":"b1","threadId":"t1","client":"android","voice":"marin",
               "startedAt":1790000000000,"status":"live"}""",
        )
        assertEquals("c1", call.callId)
        assertEquals("android", call.client)
        assertEquals(1790000000000.0, call.startedAt)
        assertEquals(LiveCallStatus.LIVE, call.status)
        assertNull(call.endReason)
        assertNull(call.error)
        assertTrue(call.isRunning)
    }

    @Test
    fun anEndedCallCarriesItsReasonAndIsNotRunning() {
        val call = CompanionJson.decodeFromString<LiveCallState>(
            """{"callId":"c1","botId":"b1","threadId":"t1","client":"desktop","voice":"marin",
               "startedAt":1,"status":"ended","endReason":"sideband-lost","error":"Call dropped"}""",
        )
        assertEquals(LiveCallStatus.ENDED, call.status)
        assertEquals("sideband-lost", call.endReason)
        assertEquals("Call dropped", call.error)
        assertFalse(call.isRunning)
    }

    @Test
    fun aStatusThisBuildHasNeverSeenReadsAsUnknownAndStillRunning() {
        val call = CompanionJson.decodeFromString<LiveCallState>(
            """{"callId":"c1","botId":"b1","threadId":"t1","client":"ios","voice":"","startedAt":1,"status":"paused"}""",
        )
        assertEquals(LiveCallStatus.UNKNOWN, call.status)
        // The harness says `ended` when a call is over; guessing that early
        // would hide the bar, and Hang up, for a call still on the line.
        assertTrue(call.isRunning, "a status this build does not know is a call still running (as on the iPhone)")
        assertEquals("\"unknown\"", CompanionJson.encodeToString(LiveCallStatus.serializer(), call.status))
    }

    @Test
    fun liveSettingsDefaultTheWayTheHarnessDoes() {
        val settings = CompanionJson.decodeFromString<LiveSettings>("""{"configured":true,"voice":"cedar"}""")
        assertEquals(LiveSettings(configured = true, voice = "cedar", readTypedReplies = true, idleMinutes = 5), settings)
    }

    @Test
    fun aSettingsPatchOnlyCarriesTheFieldsThatWereSet() {
        val one = CompanionJson.encodeToJsonElement(LiveSettingsPatch.serializer(), LiveSettingsPatch(idleMinutes = 10)).jsonObject
        assertEquals(setOf("idleMinutes"), one.keys)
        val two = CompanionJson.encodeToJsonElement(
            LiveSettingsPatch.serializer(),
            LiveSettingsPatch(voice = "sage", readTypedReplies = false),
        ).jsonObject
        assertEquals(setOf("voice", "readTypedReplies"), two.keys)
    }

    @Test
    fun configStatusCarriesLiveWhenTheHarnessSendsItAndNullOtherwise() {
        val with = CompanionJson.decodeFromString<ConfigStatus>(
            """{"tts":{"configured":false},"live":{"configured":true,"voice":"marin","readTypedReplies":false,"idleMinutes":2}}""",
        )
        assertEquals(LiveSettings(true, "marin", false, 2), with.live)
        val without = CompanionJson.decodeFromString<ConfigStatus>("""{"tts":{"configured":false}}""")
        assertNull(without.live)
    }

    @Test
    fun aSpokenRequestIsLabelledViaCall() {
        val spoken = CompanionJson.decodeFromString<Message>(
            """{"id":"m1","role":"user","kind":"text","at":1,"text":"what time is it","via":"call"}""",
        )
        assertEquals("call", spoken.via)
        val typed = CompanionJson.decodeFromString<Message>("""{"id":"m2","role":"user","kind":"text","at":2,"text":"hi"}""")
        assertNull(typed.via)
        // Existing tests build messages positionally; the new field must be last.
        val positional = Message("m3", Message.Role.USER, Message.Kind.TEXT, 3.0, text = "still compiles")
        assertNull(positional.via)
    }
}
