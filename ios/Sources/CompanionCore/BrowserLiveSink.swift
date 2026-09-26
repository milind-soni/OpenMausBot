import Foundation

/// One message for `POST /api/bots/:id/browser/action`.
///
/// The server validates this shape strictly (`parseBrowserLiveAction`), so the
/// fields are exactly what it accepts and nothing else: an unknown key is a
/// rejected action, not an ignored one.
public struct BrowserInputBody: Sendable, Equatable, Codable {
    public let type: String
    public let eventType: String
    public var x: Double? = nil
    public var y: Double? = nil
    public var button: String? = nil
    public var clickCount: Int? = nil
    public var modifiers: Int? = nil
    public var deltaX: Double? = nil
    public var deltaY: Double? = nil
    public var key: String? = nil
    public var text: String? = nil

    /// Whether this is replaceable cursor or wheel travel.
    ///
    /// Movement is the only thing the queue may coalesce: dropping a stale
    /// pointer position loses nothing, while dropping a click loses the click.
    public var isMovement: Bool {
        type == "input_mouse" && (eventType == "mouseMoved" || eventType == "mouseWheel")
    }

    /// Whether this releases something the remote is currently holding. These
    /// survive a halted queue, because the alternative is a button stuck down
    /// on the far side with nothing left to lift it.
    public var isRelease: Bool {
        (type == "input_mouse" && eventType == "mouseReleased")
            || (type == "input_keyboard" && eventType == "keyUp")
    }
}

/// Turns abstract gesture intents into browser-live protocol bodies.
///
/// This is the whole of what the browser surface knows about gestures, and
/// the gesture core knows nothing about it. Swapping this for a VNC sink is
/// how the same core will drive the cloud desktop.
public struct BrowserLiveSink: Sendable {
    /// The remote viewport in device pixels, as the frame metadata reports it.
    /// Intents carry normalised coordinates; the protocol wants pixels, and
    /// this is the only place that conversion happens.
    public var frameWidth: Double
    public var frameHeight: Double

    /// Where the pointer was last put. A wheel event must carry a position and
    /// an intent's scroll does not have one, so the last move supplies it.
    private var lastX: Double = 0
    private var lastY: Double = 0
    private var heldButton: RemoteButton?

    public init(frameWidth: Double = 1280, frameHeight: Double = 720) {
        self.frameWidth = frameWidth
        self.frameHeight = frameHeight
    }

    /// The protocol caps coordinates at 8192 and refuses anything outside, so
    /// a frame larger than that would otherwise make every event invalid.
    private func pixel(_ normalised: Double, over extent: Double) -> Double {
        min(max(normalised * extent, 0), min(extent, 8192))
    }

    public mutating func bodies(for intent: GestureIntent) -> [BrowserInputBody] {
        switch intent {
        case let .move(x, y):
            lastX = pixel(x, over: frameWidth)
            lastY = pixel(y, over: frameHeight)
            return [BrowserInputBody(
                type: "input_mouse", eventType: "mouseMoved",
                x: lastX, y: lastY,
                button: heldButton?.rawValue ?? "none",
                clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 0
            )]

        case let .press(button, clicks):
            heldButton = button
            return [BrowserInputBody(
                type: "input_mouse", eventType: "mousePressed",
                x: lastX, y: lastY,
                button: button.rawValue,
                clickCount: min(max(clicks, 1), 3), modifiers: 0, deltaX: 0, deltaY: 0
            )]

        case let .release(button):
            heldButton = nil
            return [BrowserInputBody(
                type: "input_mouse", eventType: "mouseReleased",
                x: lastX, y: lastY,
                button: button.rawValue,
                clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 0
            )]

        case let .scroll(dx, dy):
            return [BrowserInputBody(
                type: "input_mouse", eventType: "mouseWheel",
                x: lastX, y: lastY,
                button: "none", clickCount: 0, modifiers: 0,
                deltaX: min(max(dx * frameWidth, -10_000), 10_000),
                deltaY: min(max(dy * frameHeight, -10_000), 10_000)
            )]

        case let .text(value):
            guard !value.isEmpty else { return [] }
            return [BrowserInputBody(type: "input_keyboard", eventType: "char", text: value)]

        case let .key(name, modifiers):
            guard !name.isEmpty else { return [] }
            // An unmodified single character would reach the server as a raw
            // keyDown, get added to its held-key set, and never be released —
            // `char` is the route for typing, and this makes that unmissable.
            if modifiers == 0, name.count == 1 {
                return [BrowserInputBody(type: "input_keyboard", eventType: "char", text: name)]
            }
            // Only keyDown: the server resolves a modified or named key into a
            // complete press, acknowledging the down/up pair itself.
            return [BrowserInputBody(
                type: "input_keyboard", eventType: "keyDown",
                modifiers: min(max(modifiers, 0), 15),
                key: name
            )]
        }
    }
}
