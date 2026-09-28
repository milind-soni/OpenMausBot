package com.openmausbot.companion.ui

import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp

/**
 * A deliberate swipe right across this surface asks for what every back
 * affordance on the screen already asks for.
 *
 * Android gives gesture-navigation users an edge swipe that means back, but the
 * edge belongs to the system: the app never sees those touches, and users on
 * three-button navigation or a keyboard have no swipe at all. This modifier
 * extends the same meaning to the body of the screen, where the app does own
 * the touches — deliberately *without* claiming the system gesture insets, so
 * the platform's edge behavior, predictive back included, stays exactly as the
 * system defines it. An edge swipe remains the system's; a swipe that starts
 * in the body of the screen becomes ours.
 *
 * Coexistence is the Compose nesting contract, not a rule this modifier
 * enforces: children consume in the main pass before their parents, so the
 * transcript's vertical scroll claims vertical drags (a horizontal detector
 * never reaches its touch slop on them), the composer's text selection claims
 * its own drags, and this detector cancels the moment anything inside has
 * consumed. It only engages on a drag whose horizontal slop arrives first and
 * unconsumed — a swipe that is unmistakably aimed across the screen.
 *
 * The verdict is net travel at release, never the peak: a drag out and back is
 * a change of mind, and a cancelled drag (a child took over mid-gesture) is no
 * gesture at all. Leftward travel counts against the net, so a scrub right
 * then left does not leave.
 */
fun Modifier.horizontalBackSwipe(onBack: () -> Unit): Modifier =
    // A constant key: keying on the callback would cancel an in-flight
    // detector whenever recomposition produces a new lambda. Callers pass
    // through rememberUpdatedState so the block still reads the latest
    // exit decision at release.
    this.pointerInput(Unit) {
        // Inside the pointer scope the density is fixed, so the threshold is
        // resolved once rather than recomputed on every event.
        val deliberateTravel = DeliberateBackSwipeDistance.toPx()
        var netTravel = 0f
        detectHorizontalDragGestures(
            onHorizontalDrag = { change, dragAmount ->
                change.consume()
                netTravel += dragAmount
            },
            onDragEnd = {
                if (netTravel >= deliberateTravel) onBack()
                netTravel = 0f
            },
            onDragCancel = { netTravel = 0f },
        )
    }

/**
 * How far right a released drag must net before it counts as intent, rather
 * than the horizontal jitter every vertical scroll carries. Comfortably past
 * touch slop, small enough that a thumb's natural arc reaches it.
 */
private val DeliberateBackSwipeDistance = 72.dp
