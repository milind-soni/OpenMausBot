package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Contract values shared with CompanionCore's `GestureConstants`. A value that
 * differs between the two platforms is a bug the parity fixture must catch, so
 * they are stated once here and once there rather than derived from anything —
 * a derivation is a place the two can quietly disagree.
 */
object GestureConstants {
    /** Longest gap that still extends a click sequence. */
    const val MULTI_CLICK_WINDOW = 0.450

    /** Furthest a finger may land from the last tap and still count as a
     * double click rather than two clicks on two different targets. */
    const val MULTI_CLICK_SLOP = 0.02

    /** Hold before a long press fires. */
    const val LONG_PRESS = 0.500

    /** Movement that cancels a pending long press. */
    const val LONG_PRESS_SLOP = 0.015

    /** Movement before a touch is a drag rather than a tap. */
    const val DRAG_THRESHOLD = 0.01

    /** A sequence wraps rather than growing without bound. */
    const val MAX_CLICKS = 3

    const val MIN_ZOOM = 1.0
    const val MAX_ZOOM = 6.0

    /** Per-frame velocity decay at 60fps, and the speed below which a flick
     * has visibly stopped and should send nothing further. */
    const val MOMENTUM_DECAY = 0.94
    const val MOMENTUM_CUTOFF = 0.0004
}

@Serializable
enum class TouchPhase {
    @SerialName("began")
    BEGAN,

    @SerialName("moved")
    MOVED,

    @SerialName("ended")
    ENDED,

    @SerialName("cancelled")
    CANCELLED,
}

/**
 * One finger at one instant, in the view's own pixel space.
 *
 * The core does every conversion itself, so an adapter never needs to know the
 * frame's size, the letterbox insets or the zoom. That is what keeps the
 * platform layers free of arithmetic worth testing.
 *
 * @property t seconds from any fixed origin; the core has no clock of its own,
 *   so this is the only time it ever sees.
 */
@Serializable
data class TouchSample(
    val id: Int,
    val phase: TouchPhase,
    val x: Double,
    val y: Double,
    val t: Double,
)

@Serializable
enum class RemoteButton {
    @SerialName("left")
    LEFT,

    @SerialName("right")
    RIGHT,

    @SerialName("middle")
    MIDDLE,
}

/**
 * What the remote should be told.
 *
 * Zoom and pan are deliberately absent. They are local view state, and sending
 * them would reflow the remote page under the person instead of magnifying
 * their own copy of it.
 *
 * The wire shape mirrors CompanionCore's hand-written coding so one parity
 * fixture serves both platforms: `{"move":{"x":…,"y":…}}` and its siblings.
 */
@Serializable
sealed interface GestureIntent {
    @Serializable
    @SerialName("move")
    data class Move(val x: Double, val y: Double) : GestureIntent

    @Serializable
    @SerialName("press")
    data class Press(val button: RemoteButton, val clicks: Int) : GestureIntent

    @Serializable
    @SerialName("release")
    data class Release(val button: RemoteButton) : GestureIntent

    @Serializable
    @SerialName("scroll")
    data class Scroll(val dx: Double, val dy: Double) : GestureIntent

    @Serializable
    @SerialName("text")
    data class Text(val value: String) : GestureIntent

    @Serializable
    @SerialName("key")
    data class Key(val name: String, val modifiers: Int) : GestureIntent
}

@Serializable
enum class GestureMode {
    @SerialName("direct")
    DIRECT,

    @SerialName("trackpad")
    TRACKPAD,
}

/**
 * Local magnification. [offsetX] and [offsetY] are the top-left of the visible
 * window in normalised frame units, so identity shows the whole frame.
 */
@Serializable
data class ViewTransform(val scale: Double, val offsetX: Double, val offsetY: Double) {
    companion object {
        val IDENTITY = ViewTransform(1.0, 0.0, 0.0)
    }
}

/** A point on the remote surface, normalised to 0..1. */
data class RemotePoint(val x: Double, val y: Double)

/**
 * The only thing in the system that thinks in pixels.
 *
 * It folds three transforms into one: aspect-fit letterboxing, local zoom and
 * local pan. Keeping them together means there is a single place where a
 * coordinate can be got wrong, and a single place to test.
 */
data class ViewportMapping(
    val viewWidth: Double,
    val viewHeight: Double,
    val frameWidth: Double,
    val frameHeight: Double,
    val transform: ViewTransform,
) {
    /**
     * Normalised frame coordinates for a view point, or null when the point is
     * outside the drawn image and no drag has captured the pointer.
     *
     * [captured] is the difference between a stray tap on the letterbox, which
     * means nothing and is refused, and a selection drag that wandered off the
     * image, which must keep tracking at the edge.
     */
    /** The aspect-fit size the frame actually occupies, in view pixels.
     *
     * The letterbox bars are not part of it, which is why the render transform
     * and [GestureCore.pan] must both measure against this rather than the
     * view: on a portrait phone showing a 16:9 page they differ by 3.6x. */
    val drawnWidth: Double
        get() = if (viewWidth <= 0 || viewHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) 0.0
        else frameWidth * min(viewWidth / frameWidth, viewHeight / frameHeight)

    val drawnHeight: Double
        get() = if (viewWidth <= 0 || viewHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) 0.0
        else frameHeight * min(viewWidth / frameWidth, viewHeight / frameHeight)

    fun remotePoint(viewX: Double, viewY: Double, captured: Boolean): RemotePoint? {
        val sizes = listOf(viewWidth, viewHeight, frameWidth, frameHeight)
        if (sizes.any { !it.isFinite() || it <= 0 }) return null
        if (!viewX.isFinite() || !viewY.isFinite()) return null
        if (!transform.scale.isFinite() || transform.scale <= 0) return null

        val fit = min(viewWidth / frameWidth, viewHeight / frameHeight)
        val drawnWidth = frameWidth * fit
        val drawnHeight = frameHeight * fit
        val localX = (viewX - (viewWidth - drawnWidth) / 2) / drawnWidth
        val localY = (viewY - (viewHeight - drawnHeight) / 2) / drawnHeight
        if (!captured && (localX < 0 || localY < 0 || localX > 1 || localY > 1)) return null

        return RemotePoint(
            x = min(max(transform.offsetX + localX / transform.scale, 0.0), 1.0),
            y = min(max(transform.offsetY + localY / transform.scale, 0.0), 1.0),
        )
    }
}

/**
 * The gesture state machine.
 *
 * Pure by construction: it holds no clock and no transport, so every behaviour
 * it has is reachable from a test that feeds it samples and reads the intents
 * back. A class rather than a data class — it is mutable state, and structural
 * equality on it would be meaningless.
 *
 * Mirrors CompanionCore's `GestureCore` exactly; [RemoteGestureParityTest] is
 * what keeps the two honest.
 */
class GestureCore(
    var mode: GestureMode,
    var mapping: ViewportMapping,
) {
    private var clickCount = 0
    private var lastClickEnd: Double? = null
    private var lastClickPoint: RemotePoint? = null
    private var activeTouch: Int? = null
    private var touchStart: RemotePoint? = null
    private var touchStartTime = 0.0
    private var longPressArmed = false
    private var longPressFired = false
    private var dragging = false
    private var heldButton: RemoteButton? = null
    private var lastMovePoint: RemotePoint? = null
    private var lastMoveTime = 0.0
    private var scrolled = false
    private var momentumX = 0.0
    private var momentumY = 0.0

    /** Local magnification. Never sent to the remote: magnifying the received
     * frame reaches a small target without reflowing the page under the
     * person, which a remote zoom would do. */
    var transform = ViewTransform.IDENTITY
        private set

    /** Where the remote pointer is believed to be, in normalised frame units.
     *
     * Trackpad mode owns this; direct mode leaves it alone, because there the
     * finger *is* the pointer. The view draws it locally at frame rate and
     * never waits for the network, which is what hides the round trip. */
    var cursor = RemotePoint(0.5, 0.5)
        private set

    /** The take/release gate.
     *
     * False means watching, and no touch may reach the remote: scrolling to
     * read a page must not become a click on it. Off by default, so a caller
     * that forgets to set it fails safe instead of handing control away. */
    var driving = false

    companion object {
        /** The contract acceleration curve. Continuous at the knee and capped,
         * so a fast flick cannot throw the cursor somewhere unrecoverable. */
        fun gain(speed: Double): Double =
            if (!speed.isFinite() || speed <= 0.35) 1.0 else min(3.0, 1.0 + (speed - 0.35) * 2.5)
    }

    /** Release everything held and abandon momentum.
     *
     * Called on explicit release, on backgrounding and on connection loss. A
     * button left down on the remote outlives the session otherwise, and
     * nothing on the far side will ever lift it. */
    fun flush(): List<GestureIntent> {
        momentumX = 0.0
        momentumY = 0.0
        activeTouch = null
        touchStart = null
        lastMovePoint = null
        longPressArmed = false
        longPressFired = false
        scrolled = false
        val button = heldButton
        if (!dragging || button == null) return emptyList()
        dragging = false
        heldButton = null
        return listOf(GestureIntent.Release(button))
    }

    fun handle(sample: TouchSample): List<GestureIntent> {
        if (!driving) return emptyList()
        val point = mapping.remotePoint(sample.x, sample.y, activeTouch == sample.id)
            ?: return emptyList()

        if (mode == GestureMode.TRACKPAD) return handleTrackpad(sample, point)

        return when (sample.phase) {
            TouchPhase.BEGAN -> {
                activeTouch = sample.id
                touchStart = point
                touchStartTime = sample.t
                lastMovePoint = point
                lastMoveTime = sample.t
                longPressArmed = true
                longPressFired = false
                dragging = false
                scrolled = false
                // Touching during a flick stops it, as every scroll view does.
                momentumX = 0.0
                momentumY = 0.0
                emptyList()
            }

            TouchPhase.MOVED -> {
                val start = touchStart
                if (activeTouch != sample.id || start == null) return emptyList()
                val travelled = max(abs(point.x - start.x), abs(point.y - start.y))
                if (longPressArmed && travelled > GestureConstants.LONG_PRESS_SLOP) longPressArmed = false

                // Without a long press first, a one-finger drag is a scroll:
                // the page moves with the finger, so the deltas are negated.
                if (!longPressFired) {
                    val previous = lastMovePoint ?: return emptyList()
                    val dx = point.x - previous.x
                    val dy = point.y - previous.y
                    val interval = max(sample.t - lastMoveTime, 0.001)
                    lastMovePoint = point
                    lastMoveTime = sample.t
                    if (dx == 0.0 && dy == 0.0) return emptyList()
                    // A finger never holds perfectly still. Without a
                    // threshold a tap that wobbles a pixel scrolls by a
                    // sub-pixel and then suppresses its own click, so nothing
                    // happens at all.
                    if (travelled <= GestureConstants.DRAG_THRESHOLD) return emptyList()
                    scrolled = true
                    // Velocity as one frame's travel at 60fps, the unit tick decays.
                    momentumX = -dx / interval * 0.016
                    momentumY = -dy / interval * 0.016
                    return listOf(GestureIntent.Scroll(-dx, -dy))
                }

                // The first move after a long press turns it into a drag, so
                // the button press waits for movement rather than the hold —
                // a hold alone is a context menu, not a selection.
                if (!dragging && travelled > GestureConstants.DRAG_THRESHOLD) {
                    dragging = true
                    heldButton = RemoteButton.LEFT
                    return listOf(
                        GestureIntent.Press(RemoteButton.LEFT, 1),
                        GestureIntent.Move(point.x, point.y),
                    )
                }
                if (dragging) listOf(GestureIntent.Move(point.x, point.y)) else emptyList()
            }

            TouchPhase.ENDED -> {
                // Only the touch that began the gesture can end it.
                if (activeTouch != sample.id) return emptyList()
                activeTouch = null
                longPressArmed = false
                val button = heldButton
                if (dragging && button != null) {
                    dragging = false
                    heldButton = null
                    return listOf(GestureIntent.Release(button))
                }
                // A fired long press already delivered its right click, and a
                // scroll is likewise complete: a flick through a page of links
                // must not open one on the way out.
                if (longPressFired || scrolled) {
                    longPressFired = false
                    scrolled = false
                    return emptyList()
                }
                val clicks = nextClickCount(point, sample.t)
                listOf(
                    GestureIntent.Move(point.x, point.y),
                    GestureIntent.Press(RemoteButton.LEFT, clicks),
                    GestureIntent.Release(RemoteButton.LEFT),
                )
            }

            TouchPhase.CANCELLED -> {
                activeTouch = null
                longPressArmed = false
                longPressFired = false
                val button = heldButton
                if (!dragging || button == null) return emptyList()
                dragging = false
                heldButton = null
                listOf(GestureIntent.Release(button))
            }
        }
    }

    /** Trackpad mode: the finger is a rate control for a cursor the core owns,
     * not a position. Where the finger is at any moment is irrelevant; only
     * how far it moved since the last sample matters. */
    private fun handleTrackpad(sample: TouchSample, point: RemotePoint): List<GestureIntent> =
        when (sample.phase) {
            TouchPhase.BEGAN -> {
                activeTouch = sample.id
                touchStart = point
                touchStartTime = sample.t
                lastMovePoint = point
                lastMoveTime = sample.t
                dragging = false
                emptyList()
            }

            TouchPhase.MOVED -> {
                val previous = lastMovePoint
                if (activeTouch != sample.id || previous == null) {
                    emptyList()
                } else {
                    val dx = point.x - previous.x
                    val dy = point.y - previous.y
                    // A zero interval would divide speed to infinity; clamping
                    // it low keeps same-timestamp samples from pinning the gain.
                    val interval = max(sample.t - lastMoveTime, 0.001)
                    val gain = gain(sqrt(dx * dx + dy * dy) / interval)
                    lastMovePoint = point
                    lastMoveTime = sample.t
                    cursor = RemotePoint(
                        x = min(max(cursor.x + dx * gain, 0.0), 1.0),
                        y = min(max(cursor.y + dy * gain, 0.0), 1.0),
                    )
                    listOf(GestureIntent.Move(cursor.x, cursor.y))
                }
            }

            TouchPhase.ENDED -> {
                if (activeTouch != sample.id) {
                    emptyList()
                } else {
                    activeTouch = null
                    val start = touchStart
                    // A drag moved the cursor and is complete; only a touch
                    // that stayed put was a click.
                    val travelled = if (start == null) 0.0
                    else max(abs(point.x - start.x), abs(point.y - start.y))
                    if (travelled > GestureConstants.DRAG_THRESHOLD) {
                        emptyList()
                    } else {
                        val clicks = nextClickCount(cursor, sample.t)
                        // The move is not decoration. A tap that never moved
                        // the finger produced no move intent, so the sink
                        // stamped the click at whatever coordinate it last
                        // saw — (0,0) on a fresh session, nowhere near the
                        // reticle the person was aiming with.
                        listOf(
                            GestureIntent.Move(cursor.x, cursor.y),
                            GestureIntent.Press(RemoteButton.LEFT, clicks),
                            GestureIntent.Release(RemoteButton.LEFT),
                        )
                    }
                }
            }

            TouchPhase.CANCELLED -> {
                activeTouch = null
                emptyList()
            }
        }

    /** Driven by the view's frame callback.
     *
     * The core cannot ask what time it is, so a hold only becomes observable
     * when someone tells it time moved. The cost is one call per frame; the
     * return is that a half-second gesture is testable in microseconds. */
    fun tick(t: Double): List<GestureIntent> {
        if (!driving) return emptyList()

        val start = touchStart
        if (longPressArmed && !longPressFired && activeTouch != null && start != null &&
            t - touchStartTime >= GestureConstants.LONG_PRESS
        ) {
            longPressArmed = false
            longPressFired = true
            return listOf(
                GestureIntent.Move(start.x, start.y),
                GestureIntent.Press(RemoteButton.RIGHT, 1),
                GestureIntent.Release(RemoteButton.RIGHT),
            )
        }

        // A flick keeps scrolling after the finger leaves, and stops rather
        // than trickling deltas the person can no longer see.
        if (abs(momentumX) <= GestureConstants.MOMENTUM_CUTOFF &&
            abs(momentumY) <= GestureConstants.MOMENTUM_CUTOFF
        ) {
            momentumX = 0.0
            momentumY = 0.0
            return emptyList()
        }
        val carried = GestureIntent.Scroll(momentumX, momentumY)
        momentumX *= GestureConstants.MOMENTUM_DECAY
        momentumY *= GestureConstants.MOMENTUM_DECAY
        return listOf(carried)
    }

    /** Zoom about a view point, keeping whatever is under it in place.
     *
     * The offset correction is what stops the target sliding out from under
     * the fingers, which is the difference between zoom that helps reach a
     * small control and zoom that makes it harder. */
    fun pinch(scale: Double, centreX: Double, centreY: Double) {
        if (!scale.isFinite() || scale <= 0) return
        val next = min(max(transform.scale * scale, GestureConstants.MIN_ZOOM), GestureConstants.MAX_ZOOM)
        val anchor = mapping.remotePoint(centreX, centreY, true)
        if (anchor == null) {
            transform = transform.copy(scale = next)
            clampPan()
            syncMapping()
            return
        }

        val localX = (anchor.x - transform.offsetX) * transform.scale
        val localY = (anchor.y - transform.offsetY) * transform.scale
        transform = ViewTransform(
            scale = next,
            offsetX = anchor.x - localX / next,
            offsetY = anchor.y - localY / next,
        )
        clampPan()
        syncMapping()
    }

    /** Pan by a view-space delta in pixels. */
    fun pan(dx: Double, dy: Double) {
        if (!dx.isFinite() || !dy.isFinite()) return
        if (mapping.drawnWidth <= 0 || mapping.drawnHeight <= 0) return
        // The drawn extent, not the view's: on a letterboxed frame they differ,
        // and dividing by the view makes panning lag the finger badly.
        transform = transform.copy(
            offsetX = transform.offsetX - dx / (mapping.drawnWidth * transform.scale),
            offsetY = transform.offsetY - dy / (mapping.drawnHeight * transform.scale),
        )
        clampPan()
        syncMapping()
    }

    /** The visible window is `1 / scale` wide, so its top-left can never
     * exceed what is left over. At scale 1 that leaves only zero. */
    private fun clampPan() {
        val limit = max(0.0, 1 - 1 / transform.scale)
        transform = transform.copy(
            offsetX = min(max(transform.offsetX, 0.0), limit),
            offsetY = min(max(transform.offsetY, 0.0), limit),
        )
    }

    private fun syncMapping() {
        mapping = mapping.copy(transform = transform)
    }

    /** A sequence continues only while both the gap and the distance stay
     * inside the contract, and wraps rather than growing without bound — a
     * quadruple click means nothing to a browser. */
    private fun nextClickCount(point: RemotePoint, t: Double): Int {
        val last = lastClickEnd
        val where = lastClickPoint
        val soonEnough = last != null && t - last <= GestureConstants.MULTI_CLICK_WINDOW
        val closeEnough = where != null &&
            abs(where.x - point.x) <= GestureConstants.MULTI_CLICK_SLOP &&
            abs(where.y - point.y) <= GestureConstants.MULTI_CLICK_SLOP

        clickCount = if (soonEnough && closeEnough && clickCount < GestureConstants.MAX_CLICKS) {
            clickCount + 1
        } else {
            1
        }
        lastClickEnd = t
        lastClickPoint = point
        return clickCount
    }
}
