package com.openmausbot.companion.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import com.openmausbot.companion.core.GestureCore
import com.openmausbot.companion.core.GestureIntent
import com.openmausbot.companion.core.GestureMode
import com.openmausbot.companion.core.RemotePoint
import com.openmausbot.companion.core.TouchPhase
import com.openmausbot.companion.core.TouchSample
import com.openmausbot.companion.core.ViewTransform
import com.openmausbot.companion.core.ViewportMapping
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * The platform half of the gesture layer: real fingers in, TouchSamples out.
 *
 * It makes no decisions. Whether a tap is a double click, whether a drag is a
 * scroll or a selection, where the cursor ends up — all of that lives in
 * core's [GestureCore], which is testable without an emulator. This file
 * exists to feed it and to drive its clock.
 *
 * Mirrors iOS's BrowserTouchSurface.
 */
@Composable
fun Modifier.browserTouchSurface(
    core: GestureCore,
    mode: GestureMode,
    driving: Boolean,
    frameWidth: Double,
    frameHeight: Double,
    onIntents: (List<GestureIntent>) -> Unit,
    onViewState: (ViewTransform, RemotePoint) -> Unit,
): Modifier {
    val intents = rememberUpdatedState(onIntents)
    val viewState = rememberUpdatedState(onViewState)
    // One origin shared by both clocks. pointerInput restarts whenever mode or
    // driving changes, so a per-block origin made touch time jump backwards
    // relative to tick time — after taking control every touch looked older
    // than the long-press threshold and fired a right click instead of a tap.
    val epoch = remember { System.nanoTime() }
    fun elapsed() = (System.nanoTime() - epoch) / 1_000_000_000.0
    var surface by remember { mutableStateOf(0.0 to 0.0) }

    // The core has no clock; a long press only becomes observable when
    // something tells it time moved, and momentum only decays then.
    LaunchedEffect(core) {
        while (isActive) {
            val now = elapsed()
            val produced = core.tick(now)
            if (produced.isNotEmpty()) intents.value(produced)
            viewState.value(core.transform, core.cursor)
            delay(16)
        }
    }

    // The frame size arrives from the stream and the view size from layout;
    // either changing must rebuild the mapping, or clicks land against a
    // viewport the remote no longer has.
    LaunchedEffect(surface, frameWidth, frameHeight) {
        val (width, height) = surface
        if (width > 0 && height > 0) {
            core.mapping = ViewportMapping(
                viewWidth = width,
                viewHeight = height,
                frameWidth = maxOf(frameWidth, 1.0),
                frameHeight = maxOf(frameHeight, 1.0),
                transform = core.transform,
            )
        }
    }

    return this
        .onSizeChanged { size ->
            if (size.width > 0 && size.height > 0) {
                surface = size.width.toDouble() to size.height.toDouble()
            }
        }
        .pointerInput(mode, driving) {
            core.mode = mode
            core.driving = driving

            awaitEachGesture {
                var tracked: Long? = null
                var zooming = false

                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Main)
                    val changes = event.changes
                    val down = changes.filter { it.pressed }

                    // Two fingers mean zoom or pan, which the core never sees
                    // as touches. Let go of the tracked one rather than track
                    // half a pinch.
                    if (down.size >= 2) {
                        if (tracked != null) {
                            val released = core.flush()
                            if (released.isNotEmpty()) intents.value(released)
                            tracked = null
                        }
                        zooming = true
                        val zoom = event.calculateZoom()
                        val pan = event.calculatePan()
                        val centroid = event.calculateCentroid()
                        if (zoom != 1f && centroid.x.isFinite()) {
                            core.pinch(zoom.toDouble(), centroid.x.toDouble(), centroid.y.toDouble())
                        }
                        if (pan.x != 0f || pan.y != 0f) {
                            when (mode) {
                                // Direct mode is a touchscreen: two fingers move
                                // your view of the page, one moves the page.
                                GestureMode.DIRECT -> core.pan(pan.x.toDouble(), pan.y.toDouble())
                                // Trackpad mode is a laptop: two fingers scroll.
                                GestureMode.TRACKPAD -> if (driving &&
                                    core.mapping.viewWidth > 0 && core.mapping.viewHeight > 0
                                ) {
                                    intents.value(
                                        listOf(
                                            GestureIntent.Scroll(
                                                -pan.x.toDouble() / core.mapping.viewWidth,
                                                -pan.y.toDouble() / core.mapping.viewHeight,
                                            ),
                                        ),
                                    )
                                }
                            }
                        }
                        viewState.value(core.transform, core.cursor)
                        changes.forEach { it.consume() }
                        continue
                    }

                    if (down.isEmpty()) {
                        val last = changes.firstOrNull { it.id.value == tracked }
                        if (last != null) {
                            val produced = core.handle(
                                TouchSample(
                                    id = (tracked ?: 0L).toInt(),
                                    phase = TouchPhase.ENDED,
                                    x = last.position.x.toDouble(),
                                    y = last.position.y.toDouble(),
                                    t = elapsed(),
                                ),
                            )
                            if (produced.isNotEmpty()) intents.value(produced)
                            viewState.value(core.transform, core.cursor)
                        }
                        break
                    }

                    // A gesture that began as a pinch does not become a drag
                    // when one finger lifts; it ends.
                    if (zooming) continue

                    val finger = down.first()
                    val phase = when {
                        tracked == null -> {
                            tracked = finger.id.value
                            TouchPhase.BEGAN
                        }
                        finger.id.value != tracked -> continue
                        else -> TouchPhase.MOVED
                    }
                    val produced = core.handle(
                        TouchSample(
                            id = finger.id.value.toInt(),
                            phase = phase,
                            x = finger.position.x.toDouble(),
                            y = finger.position.y.toDouble(),
                            t = elapsed(),
                        ),
                    )
                    if (produced.isNotEmpty()) intents.value(produced)
                    viewState.value(core.transform, core.cursor)
                    if (phase == TouchPhase.MOVED) finger.consume()
                }
            }
        }
}
