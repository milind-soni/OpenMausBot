package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Mirrors CompanionCore's BrowserLiveSinkTests. */
class BrowserLiveSinkTest {
    private fun close(actual: Double, expected: Double) =
        assertTrue(abs(actual - expected) < 0.001, "$actual is not $expected")

    private fun sink() = BrowserLiveSink(1280.0, 720.0)

    /** Intents are normalised; the protocol is in device pixels. This is the
     * only place that conversion happens, so the only place it can go wrong. */
    @Test
    fun moveDenormalisesToDevicePixels() {
        val body = sink().bodies(GestureIntent.Move(0.5, 0.25)).single()

        assertEquals("input_mouse", body.type)
        assertEquals("mouseMoved", body.eventType)
        close(body.x!!, 640.0)
        close(body.y!!, 180.0)
        assertEquals("none", body.button)
    }

    /** A wheel event must carry a position and a scroll intent has none, so
     * the last move supplies it. */
    @Test
    fun scrollCarriesTheLastPointerPositionAndPixelDeltas() {
        val sink = sink()

        sink.bodies(GestureIntent.Move(0.5, 0.5))
        val body = sink.bodies(GestureIntent.Scroll(0.0, -0.1)).single()

        assertEquals("mouseWheel", body.eventType)
        close(body.x!!, 640.0)
        close(body.deltaY!!, -72.0)
    }

    /** The server tells a drag from a hover by the button on the move. */
    @Test
    fun movesReportTheHeldButtonWhileDragging() {
        val sink = sink()

        sink.bodies(GestureIntent.Press(RemoteButton.LEFT, 1))
        assertEquals("left", sink.bodies(GestureIntent.Move(0.6, 0.6)).single().button)

        sink.bodies(GestureIntent.Release(RemoteButton.LEFT))
        assertEquals("none", sink.bodies(GestureIntent.Move(0.7, 0.7)).single().button)
    }

    @Test
    fun pressCarriesTheClickCountClampedToWhatTheServerAccepts() {
        val sink = sink()

        assertEquals(2, sink.bodies(GestureIntent.Press(RemoteButton.RIGHT, 2)).single().clickCount)
        assertEquals(3, sink.bodies(GestureIntent.Press(RemoteButton.LEFT, 99)).single().clickCount)
        assertEquals(1, sink.bodies(GestureIntent.Press(RemoteButton.LEFT, 0)).single().clickCount)
    }

    @Test
    fun typedTextBecomesACharEvent() {
        val body = sink().bodies(GestureIntent.Text("hello")).single()

        assertEquals("input_keyboard", body.type)
        assertEquals("char", body.eventType)
        assertEquals("hello", body.text)
    }

    /** The server resolves a named or modified key into a complete press and
     * acknowledges the pair itself, so only keyDown goes out. */
    @Test
    fun namedAndModifiedKeysSendOnlyKeyDown() {
        val sink = sink()

        val enter = sink.bodies(GestureIntent.Key("Enter", 0)).single()
        assertEquals("keyDown", enter.eventType)
        assertEquals("Enter", enter.key)

        // Control is bit 2 in the contract bitmask.
        val chord = sink.bodies(GestureIntent.Key("c", 2)).single()
        assertEquals("c", chord.key)
        assertEquals(2, chord.modifiers)
    }

    /** An unmodified single character sent as a key would reach the server as
     * a raw keyDown, enter its held-key set and never be released. */
    @Test
    fun anUnmodifiedSingleCharacterKeyBecomesText() {
        val body = sink().bodies(GestureIntent.Key("a", 0)).single()

        assertEquals("char", body.eventType)
        assertEquals("a", body.text)
    }

    @Test
    fun emptyTextAndEmptyKeysProduceNothing() {
        val sink = sink()

        assertTrue(sink.bodies(GestureIntent.Text("")).isEmpty())
        assertTrue(sink.bodies(GestureIntent.Key("", 2)).isEmpty())
    }

    /** The protocol refuses a coordinate over 8192. */
    @Test
    fun coordinatesStayInsideWhatTheProtocolAccepts() {
        val body = BrowserLiveSink(16_000.0, 12_000.0).bodies(GestureIntent.Move(1.0, 1.0)).single()

        assertTrue(body.x!! <= 8192.0)
        assertTrue(body.y!! <= 8192.0)
    }

    @Test
    fun scrollDeltasClampToTheProtocolLimit() {
        val body = BrowserLiveSink(100_000.0, 100_000.0)
            .bodies(GestureIntent.Scroll(1.0, -1.0)).single()

        close(body.deltaX!!, 10_000.0)
        close(body.deltaY!!, -10_000.0)
    }

    /** The queue decides what it may drop by asking the body. */
    @Test
    fun movementAndReleaseAreClassifiedForTheQueue() {
        val sink = sink()

        assertTrue(sink.bodies(GestureIntent.Move(0.1, 0.1)).single().isMovement)
        assertTrue(sink.bodies(GestureIntent.Scroll(0.0, 0.1)).single().isMovement)
        assertFalse(sink.bodies(GestureIntent.Press(RemoteButton.LEFT, 1)).single().isMovement)

        assertTrue(sink.bodies(GestureIntent.Release(RemoteButton.LEFT)).single().isRelease)
        assertFalse(sink.bodies(GestureIntent.Press(RemoteButton.LEFT, 1)).single().isRelease)
    }
}
