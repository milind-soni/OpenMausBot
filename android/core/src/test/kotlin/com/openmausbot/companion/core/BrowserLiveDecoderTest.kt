package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Mirrors CompanionCore's BrowserLiveDecoderTests.
 *
 * The message type travels in the SSE `event:` name, never in the payload: the
 * server strips it before writing the frame. Every case here passes the name
 * separately for that reason — an earlier version keyed on the payload and
 * decoded precisely nothing.
 */
class BrowserLiveDecoderTest {
    @Test
    fun decodesAFrameWithItsDeviceSize() {
        val json = """{"seq":7,"data":"/9j/abc","format":"jpeg","metadata":{"deviceWidth":1280,"deviceHeight":720}}"""

        val frame = assertIs<BrowserLiveMessage.Frame>(BrowserLiveDecoder.message("frame", json)).frame

        assertEquals(7, frame.seq)
        assertEquals("/9j/abc", frame.data)
        assertEquals(1280.0, frame.deviceWidth)
        assertEquals(720.0, frame.deviceHeight)
    }

    @Test
    fun decodesIntegerAndDecimalMetadataAlike() {
        val json = """{"seq":1,"data":"x","metadata":{"deviceWidth":1280.0,"deviceHeight":720.5}}"""

        val frame = assertIs<BrowserLiveMessage.Frame>(BrowserLiveDecoder.message("frame", json)).frame

        assertEquals(720.5, frame.deviceHeight)
    }

    /** The viewport is what the sink denormalises against, so a status that
     * loses it would put every click in the wrong place. */
    @Test
    fun decodesStatusWithTheViewport() {
        val json = """{"connected":true,"screencasting":true,"viewportWidth":1512,"viewportHeight":982}"""

        val status = assertIs<BrowserLiveMessage.Status>(BrowserLiveDecoder.message("status", json)).status

        assertTrue(status.connected)
        assertEquals(1512.0, status.viewportWidth)
        assertEquals(982.0, status.viewportHeight)
    }

    /** `ready` is the server's name for it, and the only place a viewer id
     * ever arrives. Without it there is nothing to post an action against. */
    @Test
    fun decodesReadyAsTheViewerId() {
        assertEquals(
            "v-1",
            assertIs<BrowserLiveMessage.Ready>(
                BrowserLiveDecoder.message("ready", """{"viewerId":"v-1"}"""),
            ).viewerId,
        )
    }

    @Test
    fun decodesUrlAndTabs() {
        assertEquals(
            "https://example.test/",
            assertIs<BrowserLiveMessage.Url>(
                BrowserLiveDecoder.message("url", """{"url":"https://example.test/"}"""),
            ).url,
        )

        val tabsJson = """{"tabs":[{"tabId":"t1","title":"One","url":"https://a.test/","active":true},{"tabId":"t2","title":"","url":"","active":false}]}"""
        val tabs = assertIs<BrowserLiveMessage.Tabs>(BrowserLiveDecoder.message("tabs", tabsJson)).tabs
        assertEquals(listOf("t1", "t2"), tabs.map { it.tabId })
        assertTrue(tabs[0].active)
    }

    @Test
    fun decodesControlAndHeartbeat() {
        val control = assertIs<BrowserLiveMessage.Control>(
            BrowserLiveDecoder.message("control", """{"controlling":true,"held":false,"owned":true}"""),
        )
        assertTrue(control.controlling)
        assertFalse(control.held)

        assertEquals(BrowserLiveMessage.Heartbeat, BrowserLiveDecoder.message("heartbeat", "{}"))
    }

    @Test
    fun decodesAnErrorWithAFallbackMessage() {
        val message = assertIs<BrowserLiveMessage.Error>(
            BrowserLiveDecoder.message("error", "{}"),
        ).message

        assertFalse(message.isEmpty())
    }

    /** A name we have never seen is a protocol change, not a reason to tear
     * down a stream the person is watching. */
    @Test
    fun anUnknownOrMissingEventNameIsDropped() {
        assertNull(BrowserLiveDecoder.message("something-new", "{}"))
        assertNull(BrowserLiveDecoder.message(null, """{"type":"frame"}"""))
    }

    @Test
    fun malformedInputIsRejectedWithoutThrowing() {
        assertNull(BrowserLiveDecoder.message("frame", "not json"))
        // A frame without its metadata cannot be mapped to coordinates.
        assertNull(BrowserLiveDecoder.message("frame", """{"seq":1,"data":"x"}"""))
    }

    @Test
    fun frameBytesDecodeFromBase64() {
        val json = """{"seq":1,"data":"aGVsbG8=","metadata":{"deviceWidth":10,"deviceHeight":10}}"""

        val frame = assertIs<BrowserLiveMessage.Frame>(BrowserLiveDecoder.message("frame", json)).frame

        assertEquals("hello", frame.bytes()?.decodeToString())
    }
}

/** Mirrors CompanionCore's BrowserLiveErrorTextTests. */
class BrowserErrorTextTest {
    /** The server's own sentence must reach the person. Before this, every
     * 403 read as "browser control is off", whatever the server said. */
    @Test
    fun readsTheServersRefusal() {
        assertEquals(
            "Enable this bot's browser in its profile first.",
            browserErrorText("""{"error":"Enable this bot's browser in its profile first."}"""),
        )
    }

    @Test
    fun aNonJsonBodyYieldsNothingRatherThanGarbage() {
        assertNull(browserErrorText("<html>"))
    }
}
