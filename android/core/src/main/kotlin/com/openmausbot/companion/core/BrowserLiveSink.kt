package com.openmausbot.companion.core

import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One message for `POST /api/bots/:id/browser/action`.
 *
 * The server validates this shape strictly (`parseBrowserLiveAction`), so the
 * fields are exactly what it accepts and nothing else: an unknown key is a
 * rejected action, not an ignored one. Nulls are omitted on the wire.
 */
@Serializable
data class BrowserInputBody(
    val type: String,
    @SerialName("eventType") val eventType: String,
    val x: Double? = null,
    val y: Double? = null,
    val button: String? = null,
    val clickCount: Int? = null,
    val modifiers: Int? = null,
    val deltaX: Double? = null,
    val deltaY: Double? = null,
    val key: String? = null,
    val text: String? = null,
) {
    /** Whether this is replaceable cursor or wheel travel.
     *
     * Movement is the only thing the queue may coalesce: dropping a stale
     * pointer position loses nothing, while dropping a click loses the click. */
    val isMovement: Boolean
        get() = type == "input_mouse" && (eventType == "mouseMoved" || eventType == "mouseWheel")

    /** Whether this releases something the remote is currently holding. These
     * survive a halted queue, because the alternative is a button stuck down
     * on the far side with nothing left to lift it. */
    val isRelease: Boolean
        get() = (type == "input_mouse" && eventType == "mouseReleased") ||
            (type == "input_keyboard" && eventType == "keyUp")
}

/**
 * Turns abstract gesture intents into browser-live protocol bodies.
 *
 * This is the whole of what the browser surface knows about gestures, and the
 * gesture core knows nothing about it. Swapping this for a VNC sink is how the
 * same core will drive the cloud desktop.
 *
 * Mirrors CompanionCore's `BrowserLiveSink`.
 */
class BrowserLiveSink(
    /** The remote viewport in device pixels, as the frame metadata reports it.
     * Intents carry normalised coordinates; the protocol wants pixels, and
     * this is the only place that conversion happens. */
    var frameWidth: Double = 1280.0,
    var frameHeight: Double = 720.0,
) {
    /** Where the pointer was last put. A wheel event must carry a position and
     * a scroll intent does not have one, so the last move supplies it. */
    private var lastX = 0.0
    private var lastY = 0.0
    private var heldButton: RemoteButton? = null

    private fun buttonName(button: RemoteButton) = button.name.lowercase()

    /** The protocol caps coordinates at 8192 and refuses anything outside, so
     * a frame larger than that would otherwise make every event invalid. */
    private fun pixel(normalised: Double, extent: Double) =
        min(max(normalised * extent, 0.0), min(extent, 8192.0))

    fun bodies(intent: GestureIntent): List<BrowserInputBody> = when (intent) {
        is GestureIntent.Move -> {
            lastX = pixel(intent.x, frameWidth)
            lastY = pixel(intent.y, frameHeight)
            listOf(
                BrowserInputBody(
                    type = "input_mouse", eventType = "mouseMoved",
                    x = lastX, y = lastY,
                    button = heldButton?.let(::buttonName) ?: "none",
                    clickCount = 0, modifiers = 0, deltaX = 0.0, deltaY = 0.0,
                ),
            )
        }

        is GestureIntent.Press -> {
            heldButton = intent.button
            listOf(
                BrowserInputBody(
                    type = "input_mouse", eventType = "mousePressed",
                    x = lastX, y = lastY,
                    button = buttonName(intent.button),
                    clickCount = min(max(intent.clicks, 1), 3),
                    modifiers = 0, deltaX = 0.0, deltaY = 0.0,
                ),
            )
        }

        is GestureIntent.Release -> {
            heldButton = null
            listOf(
                BrowserInputBody(
                    type = "input_mouse", eventType = "mouseReleased",
                    x = lastX, y = lastY,
                    button = buttonName(intent.button),
                    clickCount = 1, modifiers = 0, deltaX = 0.0, deltaY = 0.0,
                ),
            )
        }

        is GestureIntent.Scroll -> listOf(
            BrowserInputBody(
                type = "input_mouse", eventType = "mouseWheel",
                x = lastX, y = lastY,
                button = "none", clickCount = 0, modifiers = 0,
                deltaX = min(max(intent.dx * frameWidth, -10_000.0), 10_000.0),
                deltaY = min(max(intent.dy * frameHeight, -10_000.0), 10_000.0),
            ),
        )

        is GestureIntent.Text ->
            if (intent.value.isEmpty()) emptyList()
            else listOf(BrowserInputBody(type = "input_keyboard", eventType = "char", text = intent.value))

        is GestureIntent.Key -> when {
            intent.name.isEmpty() -> emptyList()
            // An unmodified single character would reach the server as a raw
            // keyDown, get added to its held-key set, and never be released —
            // `char` is the route for typing, and this makes that unmissable.
            intent.modifiers == 0 && intent.name.length == 1 ->
                listOf(BrowserInputBody(type = "input_keyboard", eventType = "char", text = intent.name))
            // Only keyDown: the server resolves a modified or named key into a
            // complete press, acknowledging the down/up pair itself.
            else -> listOf(
                BrowserInputBody(
                    type = "input_keyboard", eventType = "keyDown",
                    modifiers = min(max(intent.modifiers, 0), 15),
                    key = intent.name,
                ),
            )
        }
    }
}
