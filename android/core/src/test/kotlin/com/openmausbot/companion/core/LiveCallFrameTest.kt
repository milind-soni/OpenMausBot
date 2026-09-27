package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The `live.call` SSE frame: `{ kind, botId, threadId, call | null }` from
 * `shared/wire.ts`. Frames are keyed by `kind`; the top-level ids are there
 * so the harness's member filter can hide calls on bots a member cannot see.
 */
class LiveCallFrameTest {
    private val running =
        """{"callId":"c1","botId":"b1","threadId":"t1","client":"ios","voice":"marin","startedAt":1790000000000,"status":"connecting"}"""

    @Test
    fun decodesARunningCall() {
        val stream = CompanionJson.decodeFromString<StreamFrame>(
            """{"kind":"live.call","botId":"b1","threadId":"t1","call":$running,"seq":7}""",
        )
        assertEquals(7, stream.seq)
        val frame = stream.frame as Frame.LiveCall
        assertEquals("b1", frame.botId)
        assertEquals("t1", frame.threadId)
        assertEquals("c1", frame.call?.callId)
        assertEquals(LiveCallStatus.CONNECTING, frame.call?.status)
    }

    @Test
    fun decodesTheEndOfACallAsNull() {
        val frame = CompanionJson.decodeFromString<StreamFrame>(
            """{"kind":"live.call","botId":"b1","threadId":"t1","call":null,"seq":8}""",
        ).frame
        assertEquals(Frame.LiveCall("b1", "t1", null), frame)
    }

    @Test
    fun aFrameWithoutACallKeyIsBrokenNotALineThatIsFree() {
        // Only `"call": null` says the line is free; a frame that leaves the
        // key out says nothing, and the next frame or GET restates the truth.
        val frame = CompanionJson.decodeFromString<StreamFrame>(
            """{"kind":"live.call","botId":"b1","threadId":"t1","seq":10}""",
        ).frame
        assertEquals(Frame.Unknown("live.call"), frame)
    }

    @Test
    fun aCallThisBuildCannotReadIsAbsorbedAsUnknown() {
        val frame = CompanionJson.decodeFromString<StreamFrame>(
            """{"kind":"live.call","botId":"b1","threadId":"t1","call":{"callId":42},"seq":9}""",
        ).frame
        assertEquals(Frame.Unknown("live.call"), frame)
    }

    @Test
    fun roundTripsThroughTheEncoder() {
        val original = CompanionJson.decodeFromString<StreamFrame>(
            """{"kind":"live.call","botId":"b1","threadId":"t1","call":$running,"seq":7}""",
        )
        val encoded = CompanionJson.encodeToString(StreamFrame.serializer(), original)
        assertEquals(original, CompanionJson.decodeFromString<StreamFrame>(encoded))
        val ended = StreamFrame(Frame.LiveCall("b1", "t1", null), seq = 8)
        val encodedEnd = CompanionJson.encodeToString(StreamFrame.serializer(), ended)
        assertEquals(ended, CompanionJson.decodeFromString<StreamFrame>(encodedEnd))
    }

    @Test
    fun theFrameNamesNoThreadForUnreadBookkeeping() {
        // A call is not transcript activity: the unread/notification path ignores it.
        // Typed as Frame so this reaches the Frame.threadId extension that path
        // reads; on a Frame.LiveCall receiver the data-class member would win.
        val frame: Frame = Frame.LiveCall("b1", "t1", null)
        assertNull(frame.threadId)
    }
}
