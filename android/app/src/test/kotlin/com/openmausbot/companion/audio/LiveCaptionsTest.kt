package com.openmausbot.companion.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The captions rule, the same as the desktop's `applyCaption` in `src/lib/live-call-media.ts`. */
class LiveCaptionsTest {
    private fun event(json: String): LiveChannelEvent = requireNotNull(LiveCaptions.parse(json))

    @Test
    fun buildsCaptionsFromTheDataChannel() {
        var (caption, heard) = "" to ""
        LiveCaptions.apply(caption, heard, event("""{"type":"session.input_transcript.delta","delta":"what time ","start_ms":10,"end_ms":20}"""))
            .let { (c, h) -> caption = c; heard = h }
        LiveCaptions.apply(caption, heard, event("""{"type":"session.input_transcript.delta","delta":"is it","start_ms":20,"end_ms":40}"""))
            .let { (c, h) -> caption = c; heard = h }
        assertEquals("" to "what time is it", caption to heard)
        LiveCaptions.apply(caption, heard, event("""{"type":"session.output_transcript.delta","delta":"It is noon.","start_ms":50,"end_ms":90}"""))
            .let { (c, h) -> caption = c; heard = h }
        assertEquals("It is noon." to "", caption to heard)
    }

    @Test
    fun keepsOnlyTheTailOfALongLine() {
        val (caption, _) = LiveCaptions.apply("x".repeat(300), "", event("""{"type":"session.output_transcript.delta","delta":"y"}"""))
        assertEquals(LiveCallSnapshot.CAPTION_CHARS, caption.length)
        assertEquals("y", caption.takeLast(1))
        val (_, heard) = LiveCaptions.apply("", "h".repeat(200), event("""{"type":"session.input_transcript.delta","delta":"!"}"""))
        assertEquals(LiveCallSnapshot.HEARD_CHARS, heard.length)
    }

    @Test
    fun unreadableAndUnrelatedFramesChangeNothing() {
        assertNull(LiveCaptions.parse("not json"))
        assertNull(LiveCaptions.parse("""{"delta":"no type"}"""))
        assertEquals("a" to "b", LiveCaptions.apply("a", "b", event("""{"type":"session.usage.updated","usage":{"seconds":4}}""")))
    }

    @Test
    fun sessionClosedCarriesItsReason() {
        assertEquals(
            LiveChannelEvent("session.closed", null, "connection_lost"),
            event("""{"type":"session.closed","reason":"connection_lost","session":{"id":"s"}}"""),
        )
    }
}
