package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The Kotlin half of the gesture contract. Mirrors CompanionCore's
 * RemoteGestureClick / LongPress / Trackpad / ScrollZoom / Flush suites; the
 * shared fixture in [RemoteGestureParityTest] is what enforces that they agree.
 */
class RemoteGestureCoreTest {
    private fun close(actual: Double, expected: Double) =
        assertTrue(abs(actual - expected) < 0.0001, "$actual is not $expected")

    /** 1280x720 one to one, so a view point over 1280 is its own coordinate. */
    private fun direct() = GestureCore(
        GestureMode.DIRECT,
        ViewportMapping(1280.0, 720.0, 1280.0, 720.0, ViewTransform.IDENTITY),
    ).apply { driving = true }

    private fun square(mode: GestureMode) = GestureCore(
        mode,
        ViewportMapping(1000.0, 1000.0, 1000.0, 1000.0, ViewTransform.IDENTITY),
    ).apply { driving = true }

    private fun pressIn(intents: List<GestureIntent>) =
        intents.filterIsInstance<GestureIntent.Press>().firstOrNull()

    // ── clicks ──

    @Test
    fun tapEmitsMoveThenPressThenRelease() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        val intents = core.handle(TouchSample(1, TouchPhase.ENDED, 640.0, 360.0, 0.05))

        assertEquals(
            listOf(
                GestureIntent.Move(0.5, 0.5),
                GestureIntent.Press(RemoteButton.LEFT, 1),
                GestureIntent.Release(RemoteButton.LEFT),
            ),
            intents,
        )
    }

    @Test
    fun secondTapInsideTheWindowRaisesTheClickCount() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.ENDED, 640.0, 360.0, 0.05))
        core.handle(TouchSample(2, TouchPhase.BEGAN, 640.0, 360.0, 0.20))
        val intents = core.handle(TouchSample(2, TouchPhase.ENDED, 640.0, 360.0, 0.25))

        assertEquals(GestureIntent.Press(RemoteButton.LEFT, 2), pressIn(intents))
    }

    /** 450ms is the contract, so a tap landing after it starts over. */
    @Test
    fun tapOutsideTheWindowRestartsTheSequence() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.ENDED, 640.0, 360.0, 0.05))
        core.handle(TouchSample(2, TouchPhase.BEGAN, 640.0, 360.0, 0.51))
        val intents = core.handle(TouchSample(2, TouchPhase.ENDED, 640.0, 360.0, 0.56))

        assertEquals(GestureIntent.Press(RemoteButton.LEFT, 1), pressIn(intents))
    }

    /** Moving further than the slop means two clicks on two targets. */
    @Test
    fun tapBeyondTheSlopRestartsTheSequence() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.ENDED, 640.0, 360.0, 0.05))
        // The slop is 0.02 normalised, which is 25.6 points across 1280.
        core.handle(TouchSample(2, TouchPhase.BEGAN, 690.0, 360.0, 0.20))
        val intents = core.handle(TouchSample(2, TouchPhase.ENDED, 690.0, 360.0, 0.25))

        assertEquals(GestureIntent.Press(RemoteButton.LEFT, 1), pressIn(intents))
    }

    /** Four taps read 1, 2, 3, 1: a quadruple click means nothing. */
    @Test
    fun sequenceWrapsAfterATripleClick() {
        val core = direct()

        for (tap in 0 until 4) {
            val start = tap * 0.15
            core.handle(TouchSample(tap, TouchPhase.BEGAN, 640.0, 360.0, start))
            val intents = core.handle(TouchSample(tap, TouchPhase.ENDED, 640.0, 360.0, start + 0.05))

            assertEquals(
                GestureIntent.Press(RemoteButton.LEFT, tap % GestureConstants.MAX_CLICKS + 1),
                pressIn(intents),
                "tap $tap",
            )
        }
    }

    // ── long press ──

    @Test
    fun holdingPastTheThresholdFiresARightClick() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))

        assertEquals(emptyList(), core.tick(0.4))
        assertEquals(
            listOf(
                GestureIntent.Move(0.5, 0.5),
                GestureIntent.Press(RemoteButton.RIGHT, 1),
                GestureIntent.Release(RemoteButton.RIGHT),
            ),
            core.tick(0.5),
        )
    }

    @Test
    fun theLongPressDoesNotRepeatWhileTheFingerStaysDown() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.tick(0.5)

        assertEquals(emptyList(), core.tick(0.6))
        assertEquals(emptyList(), core.tick(1.5))
    }

    /** The move that cancels the hold is itself a scroll, so it seeds
     * momentum. What must not happen is the right click. */
    @Test
    fun movingBeyondTheSlopCancelsThePendingLongPress() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 680.0, 360.0, 0.1))

        assertFalse(core.tick(0.6).any { it is GestureIntent.Press }, "a cancelled hold must never click")
    }

    @Test
    fun draggingAfterALongPressHoldsTheLeftButton() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.tick(0.5)

        assertEquals(
            listOf(
                GestureIntent.Press(RemoteButton.LEFT, 1),
                GestureIntent.Move(700.0 / 1280.0, 0.5),
            ),
            core.handle(TouchSample(1, TouchPhase.MOVED, 700.0, 360.0, 0.6)),
        )
        assertEquals(
            listOf(GestureIntent.Move(720.0 / 1280.0, 0.5)),
            core.handle(TouchSample(1, TouchPhase.MOVED, 720.0, 360.0, 0.7)),
        )
        assertEquals(
            listOf(GestureIntent.Release(RemoteButton.LEFT)),
            core.handle(TouchSample(1, TouchPhase.ENDED, 720.0, 360.0, 0.8)),
        )
    }

    @Test
    fun liftingAfterALongPressWithoutDraggingEmitsNothingFurther() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.tick(0.5)

        assertEquals(emptyList(), core.handle(TouchSample(1, TouchPhase.ENDED, 640.0, 360.0, 0.6)))
    }

    /** A cancelled touch mid-drag must still release, or the remote is left
     * holding a button nothing will ever lift. */
    @Test
    fun cancellingMidDragStillReleasesTheButton() {
        val core = direct()

        core.handle(TouchSample(1, TouchPhase.BEGAN, 640.0, 360.0, 0.0))
        core.tick(0.5)
        core.handle(TouchSample(1, TouchPhase.MOVED, 700.0, 360.0, 0.6))

        assertEquals(
            listOf(GestureIntent.Release(RemoteButton.LEFT)),
            core.handle(TouchSample(1, TouchPhase.CANCELLED, 700.0, 360.0, 0.7)),
        )
    }

    // ── trackpad ──

    @Test
    fun cursorStartsCentred() {
        assertEquals(RemotePoint(0.5, 0.5), square(GestureMode.TRACKPAD).cursor)
    }

    @Test
    fun slowDragMovesTheCursorOneToOne() {
        val core = square(GestureMode.TRACKPAD)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        // 100 points over a second is 0.1 normalised/s, far under the knee.
        val intents = core.handle(TouchSample(1, TouchPhase.MOVED, 600.0, 500.0, 1.0))

        val move = assertIs<GestureIntent.Move>(intents.single())
        close(move.x, 0.6)
        close(core.cursor.x, 0.6)
    }

    /** At v = 1.0 the contract gain is 1 + (1.0 - 0.35) * 2.5 = 2.625. */
    @Test
    fun fastDragAppliesTheAccelerationCurve() {
        val core = square(GestureMode.TRACKPAD)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 100.0, 500.0, 0.0))
        val intents = core.handle(TouchSample(1, TouchPhase.MOVED, 200.0, 500.0, 0.1))

        close(assertIs<GestureIntent.Move>(intents.single()).x, 0.5 + 0.1 * 2.625)
    }

    @Test
    fun theGainCurveIsContinuousAtTheKneeAndCapped() {
        close(GestureCore.gain(0.0), 1.0)
        close(GestureCore.gain(0.35), 1.0)
        assertTrue(abs(GestureCore.gain(0.3501) - 1.0) < 0.001)
        close(GestureCore.gain(100.0), 3.0)
    }

    @Test
    fun cursorClampsAtTheEdgesWithoutWrapping() {
        val core = square(GestureMode.TRACKPAD)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 5000.0, 5000.0, 10.0))

        close(core.cursor.x, 1.0)
        close(core.cursor.y, 1.0)
    }

    /** The tap lands where the cursor is, not where the finger is. */
    @Test
    fun tapClicksAtTheCursorNotTheFinger() {
        val core = square(GestureMode.TRACKPAD)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 600.0, 500.0, 1.0))
        core.handle(TouchSample(1, TouchPhase.ENDED, 600.0, 500.0, 1.05))

        core.handle(TouchSample(2, TouchPhase.BEGAN, 100.0, 100.0, 2.0))
        val intents = core.handle(TouchSample(2, TouchPhase.ENDED, 100.0, 100.0, 2.05))

        // The move must come first, or the sink stamps the click at a stale
        // coordinate while the reticle sits somewhere else entirely.
        assertEquals(
            listOf(
                GestureIntent.Move(0.6, 0.5),
                GestureIntent.Press(RemoteButton.LEFT, 1),
                GestureIntent.Release(RemoteButton.LEFT),
            ),
            intents,
        )
        close(core.cursor.x, 0.6)
    }

    @Test
    fun draggingThenLiftingDoesNotClickInTrackpadMode() {
        val core = square(GestureMode.TRACKPAD)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 700.0, 500.0, 1.0))

        assertEquals(emptyList(), core.handle(TouchSample(1, TouchPhase.ENDED, 700.0, 500.0, 1.05)))
    }

    // ── scroll, momentum, zoom ──

    @Test
    fun oneFingerDragScrollsInDirectMode() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        val intents = core.handle(TouchSample(1, TouchPhase.MOVED, 500.0, 600.0, 0.1))

        val scroll = assertIs<GestureIntent.Scroll>(intents.single())
        close(scroll.dx, 0.0)
        close(scroll.dy, -0.1)
    }

    @Test
    fun scrollingThenLiftingDoesNotClick() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 500.0, 600.0, 0.1))

        assertEquals(emptyList(), core.handle(TouchSample(1, TouchPhase.ENDED, 500.0, 600.0, 0.15)))
    }

    @Test
    fun momentumContinuesAfterLiftThenStops() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 500.0, 600.0, 0.016))
        core.handle(TouchSample(1, TouchPhase.ENDED, 500.0, 600.0, 0.032))

        val first = assertIs<GestureIntent.Scroll>(core.tick(0.048).single()).dy
        val second = assertIs<GestureIntent.Scroll>(core.tick(0.064).single()).dy
        close(second / first, GestureConstants.MOMENTUM_DECAY)

        for (step in 2 until 600) core.tick(0.032 + step * 0.016)
        assertEquals(emptyList(), core.tick(60.0), "momentum must stop below the cutoff")
    }

    @Test
    fun aNewTouchStopsMomentum() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.handle(TouchSample(1, TouchPhase.MOVED, 500.0, 600.0, 0.016))
        core.handle(TouchSample(1, TouchPhase.ENDED, 500.0, 600.0, 0.032))
        core.handle(TouchSample(2, TouchPhase.BEGAN, 500.0, 500.0, 0.05))

        assertEquals(emptyList(), core.tick(0.066))
    }

    @Test
    fun pinchKeepsTheAnchorPointStable() {
        val core = square(GestureMode.DIRECT)

        core.pinch(2.0, 250.0, 250.0)

        val anchor = core.mapping.remotePoint(250.0, 250.0, false)!!
        close(anchor.x, 0.25)
        close(anchor.y, 0.25)
    }

    @Test
    fun zoomClampsToTheContractBounds() {
        val core = square(GestureMode.DIRECT)

        core.pinch(100.0, 500.0, 500.0)
        close(core.transform.scale, GestureConstants.MAX_ZOOM)

        core.pinch(0.001, 500.0, 500.0)
        close(core.transform.scale, GestureConstants.MIN_ZOOM)
        close(core.transform.offsetX, 0.0)
        close(core.transform.offsetY, 0.0)
    }

    @Test
    fun panClampsAtTheFrameEdges() {
        val core = square(GestureMode.DIRECT)

        core.pinch(2.0, 500.0, 500.0)
        core.pan(-10_000.0, -10_000.0)
        close(core.transform.offsetX, 0.5)
        close(core.transform.offsetY, 0.5)

        core.pan(10_000.0, 10_000.0)
        close(core.transform.offsetX, 0.0)
        close(core.transform.offsetY, 0.0)
    }

    /** A finger never holds perfectly still. Before this had a threshold, a
     * tap that wobbled one pixel scrolled by a sub-pixel and then suppressed
     * its own click, so the tap did nothing at all. */
    @Test
    fun aTapThatWobblesAPixelStillClicks() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        val wobble = core.handle(TouchSample(1, TouchPhase.MOVED, 501.0, 500.0, 0.02))
        val lift = core.handle(TouchSample(1, TouchPhase.ENDED, 501.0, 500.0, 0.05))

        assertTrue(wobble.isEmpty(), "a pixel of wobble is not a scroll")
        assertTrue(lift.any { it is GestureIntent.Press }, "and it must not swallow the click")
    }

    /** Panning is measured against the drawn frame, not the view. On a
     * letterboxed frame the two differ — here by 3.6x vertically. */
    @Test
    fun panUsesTheDrawnExtentNotTheViewOnALetterboxedFrame() {
        val core = GestureCore(
            GestureMode.DIRECT,
            ViewportMapping(400.0, 800.0, 1280.0, 720.0, ViewTransform.IDENTITY),
        ).apply { driving = true }

        core.pinch(2.0, 200.0, 400.0)
        val before = core.transform.offsetY
        core.pan(0.0, -112.5)

        close(core.transform.offsetY - before, 0.25)
    }

    @Test
    fun theMappingTracksTheTransformAfterAPinch() {
        val core = square(GestureMode.DIRECT)

        core.pinch(2.0, 500.0, 500.0)

        assertEquals(core.transform, core.mapping.transform)
    }

    // ── driving gate and flush ──

    @Test
    fun notDrivingEmitsNothing() {
        val core = square(GestureMode.DIRECT)
        core.driving = false

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))

        assertEquals(emptyList(), core.handle(TouchSample(1, TouchPhase.ENDED, 500.0, 500.0, 0.05)))
        assertEquals(emptyList(), core.tick(1.0))
    }

    /** Forgetting to set it must fail safe, not hand the remote away. */
    @Test
    fun drivingIsOffByDefault() {
        val fresh = GestureCore(
            GestureMode.DIRECT,
            ViewportMapping(1000.0, 1000.0, 1000.0, 1000.0, ViewTransform.IDENTITY),
        )

        assertFalse(fresh.driving)
    }

    @Test
    fun flushReleasesAHeldButtonAndStopsMomentum() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.tick(0.5)
        core.handle(TouchSample(1, TouchPhase.MOVED, 600.0, 500.0, 0.6))

        assertEquals(listOf(GestureIntent.Release(RemoteButton.LEFT)), core.flush())
        assertEquals(emptyList(), core.flush(), "a second flush has nothing left to release")
        assertEquals(emptyList(), core.tick(1.0), "momentum must not survive a flush")
    }

    @Test
    fun flushWithNothingHeldEmitsNothing() {
        assertEquals(emptyList(), square(GestureMode.DIRECT).flush())
    }

    @Test
    fun aTouchAfterAFlushBehavesAsAFreshTap() {
        val core = square(GestureMode.DIRECT)

        core.handle(TouchSample(1, TouchPhase.BEGAN, 500.0, 500.0, 0.0))
        core.tick(0.5)
        core.handle(TouchSample(1, TouchPhase.MOVED, 600.0, 500.0, 0.6))
        core.flush()

        core.handle(TouchSample(2, TouchPhase.BEGAN, 500.0, 500.0, 1.0))
        assertEquals(
            listOf(
                GestureIntent.Move(0.5, 0.5),
                GestureIntent.Press(RemoteButton.LEFT, 1),
                GestureIntent.Release(RemoteButton.LEFT),
            ),
            core.handle(TouchSample(2, TouchPhase.ENDED, 500.0, 500.0, 1.05)),
        )
    }
}
