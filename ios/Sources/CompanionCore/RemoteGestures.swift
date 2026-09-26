import Foundation

/// Contract values shared with android/core's `GestureConstants`. A value that
/// differs between the two platforms is a bug the parity fixture must catch,
/// so they are stated once here and once there rather than derived from
/// anything — a derivation is a place the two can quietly disagree.
public enum GestureConstants {
    /// Longest gap that still extends a click sequence.
    public static let multiClickWindow = 0.450
    /// Furthest a finger may land from the last tap and still count as a
    /// double click rather than two clicks on two different targets.
    public static let multiClickSlop = 0.02
    /// Hold before a long press fires.
    public static let longPress = 0.500
    /// Movement that cancels a pending long press.
    public static let longPressSlop = 0.015
    /// Movement before a touch is a drag rather than a tap.
    public static let dragThreshold = 0.01
    /// A sequence wraps rather than growing without bound.
    public static let maxClicks = 3
    public static let minZoom = 1.0
    public static let maxZoom = 6.0
    /// Per-frame velocity decay at 60fps, and the speed below which a flick
    /// has visibly stopped and should send nothing further.
    public static let momentumDecay = 0.94
    public static let momentumCutoff = 0.0004
}

public enum TouchPhase: String, Sendable, Codable {
    case began, moved, ended, cancelled
}

/// One finger at one instant, in the view's own point space.
///
/// The core does every conversion itself, so an adapter never needs to know
/// the frame's size, the letterbox insets or the zoom. That is what keeps the
/// platform layers free of arithmetic worth testing.
public struct TouchSample: Sendable, Equatable, Codable {
    public let id: Int
    public let phase: TouchPhase
    public let x: Double
    public let y: Double
    /// Seconds from any fixed origin. The core has no clock of its own, so
    /// this is the only time it ever sees.
    public let t: Double

    public init(id: Int, phase: TouchPhase, x: Double, y: Double, t: Double) {
        self.id = id
        self.phase = phase
        self.x = x
        self.y = y
        self.t = t
    }
}

public enum RemoteButton: String, Sendable, Equatable, Codable {
    case left, right, middle
}

/// What the remote should be told.
///
/// Zoom and pan are deliberately absent. They are local view state, and
/// sending them would reflow the remote page under the person instead of
/// magnifying their own copy of it.
public enum GestureIntent: Sendable, Equatable {
    case move(x: Double, y: Double)
    case press(button: RemoteButton, clicks: Int)
    case release(button: RemoteButton)
    case scroll(dx: Double, dy: Double)
    case text(String)
    case key(name: String, modifiers: Int)
}

/// Written by hand rather than synthesised.
///
/// Swift's default enum coding nests payloads under `_0`, which no Kotlin
/// decoder would read. The parity fixture has to be one file both platforms
/// understand, so the wire shape is stated explicitly here and mirrored in
/// android/core: `{"move":{"x":…,"y":…}}` and its siblings.
extension GestureIntent: Codable {
    private enum Key: String, CodingKey {
        case move, press, release, scroll, text, key
    }

    private struct Point: Codable { let x: Double; let y: Double }
    private struct Delta: Codable { let dx: Double; let dy: Double }
    private struct Press: Codable { let button: RemoteButton; let clicks: Int }
    private struct Release: Codable { let button: RemoteButton }
    private struct Key2: Codable { let name: String; let modifiers: Int }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        if let value = try container.decodeIfPresent(Point.self, forKey: .move) {
            self = .move(x: value.x, y: value.y)
        } else if let value = try container.decodeIfPresent(Press.self, forKey: .press) {
            self = .press(button: value.button, clicks: value.clicks)
        } else if let value = try container.decodeIfPresent(Release.self, forKey: .release) {
            self = .release(button: value.button)
        } else if let value = try container.decodeIfPresent(Delta.self, forKey: .scroll) {
            self = .scroll(dx: value.dx, dy: value.dy)
        } else if let value = try container.decodeIfPresent(String.self, forKey: .text) {
            self = .text(value)
        } else if let value = try container.decodeIfPresent(Key2.self, forKey: .key) {
            self = .key(name: value.name, modifiers: value.modifiers)
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .move, in: container, debugDescription: "no known intent key"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case let .move(x, y):
            try container.encode(Point(x: x, y: y), forKey: .move)
        case let .press(button, clicks):
            try container.encode(Press(button: button, clicks: clicks), forKey: .press)
        case let .release(button):
            try container.encode(Release(button: button), forKey: .release)
        case let .scroll(dx, dy):
            try container.encode(Delta(dx: dx, dy: dy), forKey: .scroll)
        case let .text(value):
            try container.encode(value, forKey: .text)
        case let .key(name, modifiers):
            try container.encode(Key2(name: name, modifiers: modifiers), forKey: .key)
        }
    }
}

public enum GestureMode: String, Sendable, Codable {
    case direct, trackpad
}

/// Local magnification. `offset` is the top-left of the visible window in
/// normalised frame units, so identity shows the whole frame.
public struct ViewTransform: Sendable, Equatable, Codable {
    public var scale: Double
    public var offsetX: Double
    public var offsetY: Double

    public static let identity = ViewTransform(scale: 1, offsetX: 0, offsetY: 0)

    public init(scale: Double, offsetX: Double, offsetY: Double) {
        self.scale = scale
        self.offsetX = offsetX
        self.offsetY = offsetY
    }
}

/// A point on the remote surface, normalised to 0...1.
public struct RemotePoint: Sendable, Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// The only thing in the system that thinks in pixels.
///
/// It folds three transforms into one: aspect-fit letterboxing, local zoom
/// and local pan. Keeping them together means there is a single place where a
/// coordinate can be got wrong, and a single place to test.
public struct ViewportMapping: Sendable, Equatable {
    public let viewWidth: Double
    public let viewHeight: Double
    public let frameWidth: Double
    public let frameHeight: Double
    public let transform: ViewTransform

    public init(
        viewWidth: Double,
        viewHeight: Double,
        frameWidth: Double,
        frameHeight: Double,
        transform: ViewTransform
    ) {
        self.viewWidth = viewWidth
        self.viewHeight = viewHeight
        self.frameWidth = frameWidth
        self.frameHeight = frameHeight
        self.transform = transform
    }

    /// Normalised frame coordinates for a view point, or nil when the point
    /// is outside the drawn image and no drag has captured the pointer.
    ///
    /// `captured` is the difference between a stray tap on the letterbox,
    /// which means nothing and is refused, and a selection drag that wandered
    /// off the image, which must keep tracking at the edge.
    /// The aspect-fit size the frame actually occupies, in view points.
    ///
    /// The letterbox bars are not part of it, which is why the render
    /// transform and `pan` must both measure against this rather than the
    /// view: on a portrait phone showing a 16:9 page they differ by 3.6x.
    public var drawnWidth: Double {
        guard viewWidth > 0, viewHeight > 0, frameWidth > 0, frameHeight > 0 else { return 0 }
        return frameWidth * min(viewWidth / frameWidth, viewHeight / frameHeight)
    }

    public var drawnHeight: Double {
        guard viewWidth > 0, viewHeight > 0, frameWidth > 0, frameHeight > 0 else { return 0 }
        return frameHeight * min(viewWidth / frameWidth, viewHeight / frameHeight)
    }

    public func remotePoint(viewX: Double, viewY: Double, captured: Bool) -> RemotePoint? {
        let sizes = [viewWidth, viewHeight, frameWidth, frameHeight]
        guard sizes.allSatisfy({ $0.isFinite && $0 > 0 }),
              viewX.isFinite, viewY.isFinite,
              transform.scale.isFinite, transform.scale > 0 else { return nil }

        let fit = min(viewWidth / frameWidth, viewHeight / frameHeight)
        let drawnWidth = frameWidth * fit
        let drawnHeight = frameHeight * fit
        let localX = (viewX - (viewWidth - drawnWidth) / 2) / drawnWidth
        let localY = (viewY - (viewHeight - drawnHeight) / 2) / drawnHeight
        if !captured, localX < 0 || localY < 0 || localX > 1 || localY > 1 { return nil }

        return RemotePoint(
            x: min(max(transform.offsetX + localX / transform.scale, 0), 1),
            y: min(max(transform.offsetY + localY / transform.scale, 0), 1)
        )
    }
}

/// The gesture state machine.
///
/// Pure by construction: it holds no clock and no transport, so every
/// behaviour it has is reachable from a test that feeds it samples and reads
/// the intents back. That is the whole reason it is a value type in the
/// shared module rather than logic inside a view.
public struct GestureCore: Sendable {
    public var mode: GestureMode
    public var mapping: ViewportMapping

    private var clickCount = 0
    private var lastClickEnd: Double?
    private var lastClickPoint: RemotePoint?
    private var activeTouch: Int?
    private var touchStart: RemotePoint?
    private var touchStartTime: Double = 0
    private var longPressArmed = false
    private var longPressFired = false
    private var dragging = false
    private var heldButton: RemoteButton?
    private var lastMovePoint: RemotePoint?
    private var lastMoveTime: Double = 0
    private var scrolled = false
    private var momentumX: Double = 0
    private var momentumY: Double = 0

    /// Local magnification. Never sent to the remote: magnifying the received
    /// frame reaches a small target without reflowing the page under the
    /// person, which a remote zoom would do.
    public private(set) var transform = ViewTransform.identity

    /// Where the remote pointer is believed to be, in normalised frame units.
    ///
    /// Trackpad mode owns this; direct mode leaves it alone, because there the
    /// finger *is* the pointer. The view draws it locally at frame rate and
    /// never waits for the network, which is what hides the round trip.
    public private(set) var cursor = RemotePoint(x: 0.5, y: 0.5)

    /// The take/release gate.
    ///
    /// False means watching, and no touch may reach the remote: scrolling to
    /// read a page must not become a click on it. Off by default, so a caller
    /// that forgets to set it fails safe instead of handing control away.
    public var driving = false

    public init(mode: GestureMode, mapping: ViewportMapping) {
        self.mode = mode
        self.mapping = mapping
    }

    /// Release everything held and abandon momentum.
    ///
    /// Called on explicit release, on backgrounding and on connection loss.
    /// A button left down on the remote outlives the session otherwise, and
    /// nothing on the far side will ever lift it.
    public mutating func flush() -> [GestureIntent] {
        momentumX = 0
        momentumY = 0
        activeTouch = nil
        touchStart = nil
        lastMovePoint = nil
        longPressArmed = false
        longPressFired = false
        scrolled = false
        guard dragging, let button = heldButton else { return [] }
        dragging = false
        heldButton = nil
        return [.release(button: button)]
    }

    /// The contract acceleration curve. Continuous at the knee and capped, so
    /// a fast flick cannot throw the cursor somewhere unrecoverable.
    static func gain(forSpeed speed: Double) -> Double {
        guard speed.isFinite, speed > 0.35 else { return 1.0 }
        return min(3.0, 1.0 + (speed - 0.35) * 2.5)
    }

    public mutating func handle(_ sample: TouchSample) -> [GestureIntent] {
        guard driving else { return [] }
        guard let point = mapping.remotePoint(
            viewX: sample.x, viewY: sample.y, captured: activeTouch == sample.id
        ) else { return [] }

        if mode == .trackpad { return handleTrackpad(sample, point: point) }

        switch sample.phase {
        case .began:
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
            momentumX = 0
            momentumY = 0
            return []

        case .moved:
            guard activeTouch == sample.id, let start = touchStart else { return [] }
            let travelled = max(abs(point.x - start.x), abs(point.y - start.y))
            if longPressArmed, travelled > GestureConstants.longPressSlop { longPressArmed = false }

            // Without a long press first, a one-finger drag is a scroll: the
            // page moves with the finger, so the deltas are negated.
            if !longPressFired {
                guard let previous = lastMovePoint else { return [] }
                let dx = point.x - previous.x
                let dy = point.y - previous.y
                let interval = max(sample.t - lastMoveTime, 0.001)
                lastMovePoint = point
                lastMoveTime = sample.t
                guard dx != 0 || dy != 0 else { return [] }
                // A finger never holds perfectly still. Without a threshold a
                // tap that wobbles a pixel scrolls by a sub-pixel and then
                // suppresses its own click, so nothing happens at all.
                guard travelled > GestureConstants.dragThreshold else { return [] }
                scrolled = true
                // Velocity expressed as one frame's worth of travel at 60fps,
                // which is the unit tick() decays.
                momentumX = -dx / interval * 0.016
                momentumY = -dy / interval * 0.016
                return [.scroll(dx: -dx, dy: -dy)]
            }

            // The first move after a long press is what turns it into a drag,
            // so the button press waits for movement rather than firing on the
            // hold — a hold alone is a context menu, not a selection.
            if !dragging, travelled > GestureConstants.dragThreshold {
                dragging = true
                heldButton = .left
                return [.press(button: .left, clicks: 1), .move(x: point.x, y: point.y)]
            }
            return dragging ? [.move(x: point.x, y: point.y)] : []

        case .ended:
            // A lift belonging to some other finger must not click; only the
            // touch that began the gesture can end it.
            guard activeTouch == sample.id else { return [] }
            activeTouch = nil
            longPressArmed = false
            if dragging, let button = heldButton {
                dragging = false
                heldButton = nil
                return [.release(button: button)]
            }
            // A fired long press already delivered its right click, so lifting
            // must add nothing or the touch performs two actions. A scroll is
            // likewise complete: a flick through a page of links must not
            // open one on the way out.
            if longPressFired || scrolled {
                longPressFired = false
                scrolled = false
                return []
            }
            let clicks = nextClickCount(at: point, t: sample.t)
            return [
                .move(x: point.x, y: point.y),
                .press(button: .left, clicks: clicks),
                .release(button: .left),
            ]

        case .cancelled:
            activeTouch = nil
            longPressArmed = false
            longPressFired = false
            guard dragging, let button = heldButton else { return [] }
            dragging = false
            heldButton = nil
            return [.release(button: button)]
        }
    }

    /// Trackpad mode: the finger is a rate control for a cursor the core
    /// owns, not a position. Where the finger is at any moment is irrelevant;
    /// only how far it moved since the last sample matters.
    private mutating func handleTrackpad(_ sample: TouchSample, point: RemotePoint) -> [GestureIntent] {
        switch sample.phase {
        case .began:
            activeTouch = sample.id
            touchStart = point
            touchStartTime = sample.t
            lastMovePoint = point
            lastMoveTime = sample.t
            dragging = false
            return []

        case .moved:
            guard activeTouch == sample.id, let previous = lastMovePoint else { return [] }
            let dx = point.x - previous.x
            let dy = point.y - previous.y
            // A zero interval would divide speed to infinity; clamping it low
            // keeps a burst of same-timestamp samples from pinning the gain.
            let interval = max(sample.t - lastMoveTime, 0.001)
            let gain = Self.gain(forSpeed: (dx * dx + dy * dy).squareRoot() / interval)
            lastMovePoint = point
            lastMoveTime = sample.t
            cursor = RemotePoint(
                x: min(max(cursor.x + dx * gain, 0), 1),
                y: min(max(cursor.y + dy * gain, 0), 1)
            )
            return [.move(x: cursor.x, y: cursor.y)]

        case .ended:
            guard activeTouch == sample.id else { return [] }
            activeTouch = nil
            // A drag moved the cursor and is complete; only a touch that
            // stayed put was a click.
            let travelled = touchStart.map { max(abs(point.x - $0.x), abs(point.y - $0.y)) } ?? 0
            guard travelled <= GestureConstants.dragThreshold else { return [] }
            let clicks = nextClickCount(at: cursor, t: sample.t)
            // The move is not decoration. A tap that never moved the finger
            // produced no move intent, so the sink stamped the click at
            // whatever coordinate it last saw — (0,0) on a fresh session,
            // nowhere near the reticle the person was aiming with.
            return [
                .move(x: cursor.x, y: cursor.y),
                .press(button: .left, clicks: clicks),
                .release(button: .left),
            ]

        case .cancelled:
            activeTouch = nil
            return []
        }
    }

    /// Driven by the view's frame callback.
    ///
    /// The core cannot ask what time it is, so a hold only becomes observable
    /// when someone tells it time moved. The cost is one call per frame; the
    /// return is that a half-second gesture is testable in microseconds.
    public mutating func tick(at t: Double) -> [GestureIntent] {
        guard driving else { return [] }
        if longPressArmed, !longPressFired, activeTouch != nil, let start = touchStart,
           t - touchStartTime >= GestureConstants.longPress {
            longPressArmed = false
            longPressFired = true
            return [
                .move(x: start.x, y: start.y),
                .press(button: .right, clicks: 1),
                .release(button: .right),
            ]
        }

        // A flick keeps scrolling after the finger leaves, and stops rather
        // than trickling deltas the person can no longer see.
        guard abs(momentumX) > GestureConstants.momentumCutoff
            || abs(momentumY) > GestureConstants.momentumCutoff else {
            momentumX = 0
            momentumY = 0
            return []
        }
        let carried = GestureIntent.scroll(dx: momentumX, dy: momentumY)
        momentumX *= GestureConstants.momentumDecay
        momentumY *= GestureConstants.momentumDecay
        return [carried]
    }

    /// Zoom about a view point, keeping whatever is under it in place.
    ///
    /// The offset correction is what stops the target sliding out from under
    /// the fingers, which is the difference between zoom that helps reach a
    /// small control and zoom that makes it harder.
    public mutating func pinch(scale: Double, centreX: Double, centreY: Double) {
        guard scale.isFinite, scale > 0 else { return }
        let next = min(max(transform.scale * scale, GestureConstants.minZoom), GestureConstants.maxZoom)
        guard let anchor = mapping.remotePoint(viewX: centreX, viewY: centreY, captured: true) else {
            transform.scale = next
            clampPan()
            syncMapping()
            return
        }

        let localX = (anchor.x - transform.offsetX) * transform.scale
        let localY = (anchor.y - transform.offsetY) * transform.scale
        transform.scale = next
        transform.offsetX = anchor.x - localX / next
        transform.offsetY = anchor.y - localY / next
        clampPan()
        syncMapping()
    }

    /// Pan by a view-space delta in points.
    public mutating func pan(dx: Double, dy: Double) {
        guard dx.isFinite, dy.isFinite,
              mapping.drawnWidth > 0, mapping.drawnHeight > 0 else { return }
        // The drawn extent, not the view's: on a letterboxed frame they differ,
        // and dividing by the view makes panning lag the finger badly.
        transform.offsetX -= dx / (mapping.drawnWidth * transform.scale)
        transform.offsetY -= dy / (mapping.drawnHeight * transform.scale)
        clampPan()
        syncMapping()
    }

    /// The visible window is `1 / scale` wide, so its top-left can never
    /// exceed what is left over. At scale 1 that leaves only zero.
    private mutating func clampPan() {
        let limit = max(0, 1 - 1 / transform.scale)
        transform.offsetX = min(max(transform.offsetX, 0), limit)
        transform.offsetY = min(max(transform.offsetY, 0), limit)
    }

    private mutating func syncMapping() {
        mapping = ViewportMapping(
            viewWidth: mapping.viewWidth, viewHeight: mapping.viewHeight,
            frameWidth: mapping.frameWidth, frameHeight: mapping.frameHeight,
            transform: transform
        )
    }

    /// A sequence continues only while both the gap and the distance stay
    /// inside the contract, and wraps rather than growing without bound — a
    /// quadruple click means nothing to a browser.
    private mutating func nextClickCount(at point: RemotePoint, t: Double) -> Int {
        let soonEnough = lastClickEnd.map { t - $0 <= GestureConstants.multiClickWindow } ?? false
        let closeEnough = lastClickPoint.map {
            abs($0.x - point.x) <= GestureConstants.multiClickSlop
                && abs($0.y - point.y) <= GestureConstants.multiClickSlop
        } ?? false

        clickCount = soonEnough && closeEnough && clickCount < GestureConstants.maxClicks
            ? clickCount + 1
            : 1
        lastClickEnd = t
        lastClickPoint = point
        return clickCount
    }
}
