package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemoteGestureMappingTest {
    private fun close(actual: Double, expected: Double) =
        assertTrue(abs(actual - expected) < 0.0001, "$actual is not $expected")

    /** A 16:9 frame inside a square view letterboxes top and bottom; the
     * image's own corners must land exactly on 0,0 and 1,1, because every
     * click the person makes is measured from them. */
    @Test
    fun letterboxedFrameMapsImageCornersToTheUnitSquare() {
        val mapping = ViewportMapping(400.0, 400.0, 1280.0, 720.0, ViewTransform.IDENTITY)

        // 400 wide at 16:9 draws 225 tall, centred, so 87.5 of bar each side.
        val topLeft = assertNotNull(mapping.remotePoint(0.0, 87.5, false))
        val bottomRight = assertNotNull(mapping.remotePoint(400.0, 312.5, false))

        close(topLeft.x, 0.0)
        close(topLeft.y, 0.0)
        close(bottomRight.x, 1.0)
        close(bottomRight.y, 1.0)
    }

    /** A touch in the letterbox belongs to no pixel. It is rejected while
     * free, but clamped once a drag has captured the pointer — otherwise a
     * selection that strays into the bar would silently stop tracking. */
    @Test
    fun letterboxRejectsUncapturedTouchesAndClampsCapturedOnes() {
        val mapping = ViewportMapping(400.0, 400.0, 1280.0, 720.0, ViewTransform.IDENTITY)

        assertNull(mapping.remotePoint(200.0, 10.0, false))
        close(assertNotNull(mapping.remotePoint(200.0, 10.0, true)).y, 0.0)
    }

    /** Zooming 2x about the frame's centre halves the visible span, so the
     * view's centre still reads as the frame's centre. */
    @Test
    fun zoomAboutCentreKeepsTheCentrePointStable() {
        val mapping = ViewportMapping(400.0, 225.0, 1280.0, 720.0, ViewTransform(2.0, 0.25, 0.25))

        val centre = assertNotNull(mapping.remotePoint(200.0, 112.5, false))
        close(centre.x, 0.5)
        close(centre.y, 0.5)
    }

    /** A degenerate view or frame size must not produce NaN coordinates that
     * would later be posted to the remote as a click somewhere arbitrary. */
    @Test
    fun degenerateSizesYieldNoPoint() {
        val zeroView = ViewportMapping(0.0, 400.0, 1280.0, 720.0, ViewTransform.IDENTITY)
        val zeroFrame = ViewportMapping(400.0, 400.0, 0.0, 720.0, ViewTransform.IDENTITY)

        assertNull(zeroView.remotePoint(10.0, 10.0, true))
        assertNull(zeroFrame.remotePoint(10.0, 10.0, true))
    }

    /** The constants are the contract with iOS. Stated literally on both
     * sides so a change has to be made twice, deliberately. */
    @Test
    fun constantsMatchTheContract() {
        close(GestureConstants.MULTI_CLICK_WINDOW, 0.450)
        close(GestureConstants.MULTI_CLICK_SLOP, 0.02)
        close(GestureConstants.LONG_PRESS, 0.500)
        close(GestureConstants.LONG_PRESS_SLOP, 0.015)
        close(GestureConstants.DRAG_THRESHOLD, 0.01)
        close(GestureConstants.MIN_ZOOM, 1.0)
        close(GestureConstants.MAX_ZOOM, 6.0)
        close(GestureConstants.MOMENTUM_DECAY, 0.94)
        close(GestureConstants.MOMENTUM_CUTOFF, 0.0004)
        assertTrue(GestureConstants.MAX_CLICKS == 3)
    }
}
