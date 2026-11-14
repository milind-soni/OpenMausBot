# Gesture Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, platform-free gesture state machine in both shared modules that turns touch samples into abstract remote-control intents, with a shared fixture proving iOS and Android behave identically.

**Architecture:** `GestureCore` is a value type holding mode, click-sequence, cursor and zoom state. It is fed `TouchSample`s and `tick(at:)` calls and returns `[GestureIntent]`. It owns every coordinate transform — letterboxing, zoom, pan — so no view and no sink ever does pixel maths. It has no clock, no networking and no platform types, which is what makes it testable under `swift test` and `./gradlew :core:test` with no simulator or emulator.

**Tech Stack:** Swift 5.9 (`ios/Sources/CompanionCore`, XCTest), Kotlin JVM 17 (`android/core`, kotlin.test), JSON fixture shared by both test suites.

**Spec:** `docs/superpowers/specs/2026-09-18-mobile-touch-control-design.md`

**A note on Tasks 8–11.** These are deliberate ports of Swift written out in
full in Tasks 1–6 of this same document, so they name the source task and
section rather than repeating forty lines of near-identical code in a second
language. An executor working Task 9 must read Tasks 2 and 3 first — the
Kotlin is not derivable from Task 9 alone. What makes this safe rather than
hand-waving is Task 12: the shared fixture fails the build if the two ports
disagree about any documented behaviour, so "mirror it" is machine-checked,
not taken on trust.

## Global Constraints

- The core is pure: no `Foundation` networking, no `UIKit`/`android.*`, no `Date()`/`System.currentTimeMillis()`. Time arrives as a `Double` of seconds on every sample and tick.
- Coordinates entering the core are view-space points. Coordinates leaving it in intents are normalised 0..1 against the remote frame. Nothing outside the core converts between them.
- Constants are contract values, identical on both platforms, taken verbatim from the spec: `multiClickWindowMs` 450, `multiClickSlopNorm` 0.02, `longPressMs` 500, `longPressSlopNorm` 0.015, `dragThresholdNorm` 0.01, `maxClicks` 3, `minZoom` 1.0, `maxZoom` 6.0, `momentumDecayPerFrame` 0.94, `momentumCutoffNormPerFrame` 0.0004.
- Trackpad acceleration is exactly: `gain(v) = 1.0` for `v <= 0.35`, else `min(3.0, 1.0 + (v - 0.35) * 2.5)`.
- Zoom is local only. The core never emits an intent that changes remote zoom.
- Swift is `public` where the app target needs it; Kotlin is public by default. Both follow the surrounding files' doc-comment style: explain *why*, not *what*.
- Commit after every task with the repo's `type(scope): subject` convention.

---

### Task 1: Value types, constants and viewport mapping (iOS)

**Files:**
- Create: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureMappingTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `TouchPhase`, `TouchSample`, `RemoteButton`, `GestureIntent`, `GestureMode`, `GestureConstants`, `ViewTransform`, `ViewportMapping` with `remotePoint(viewX:viewY:captured:) -> RemotePoint?`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureMappingTests: XCTestCase {
    /// A 16:9 frame inside a taller view letterboxes top and bottom; the
    /// image's own corners must land exactly on 0,0 and 1,1.
    func testLetterboxedFrameMapsImageCornersToTheUnitSquare() {
        let mapping = ViewportMapping(
            viewWidth: 400, viewHeight: 400,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        )
        // 400 wide / (1280/720) = 225 tall, centred => 87.5 of padding each side.
        let topLeft = mapping.remotePoint(viewX: 0, viewY: 87.5, captured: false)
        let bottomRight = mapping.remotePoint(viewX: 400, viewY: 312.5, captured: false)

        XCTAssertEqual(topLeft?.x ?? .nan, 0, accuracy: 0.0001)
        XCTAssertEqual(topLeft?.y ?? .nan, 0, accuracy: 0.0001)
        XCTAssertEqual(bottomRight?.x ?? .nan, 1, accuracy: 0.0001)
        XCTAssertEqual(bottomRight?.y ?? .nan, 1, accuracy: 0.0001)
    }

    /// A touch in the letterbox belongs to no pixel. It is rejected while
    /// free, but kept once a drag has captured the pointer — otherwise a
    /// selection that strays into the bar would silently stop tracking.
    func testLetterboxRejectsUncapturedTouchesAndClampsCapturedOnes() {
        let mapping = ViewportMapping(
            viewWidth: 400, viewHeight: 400,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        )
        XCTAssertNil(mapping.remotePoint(viewX: 200, viewY: 10, captured: false))
        XCTAssertEqual(mapping.remotePoint(viewX: 200, viewY: 10, captured: true)?.y ?? .nan, 0, accuracy: 0.0001)
    }

    /// Zooming 2x about the frame's centre halves the visible span, so the
    /// view's centre still reads as the frame's centre.
    func testZoomAboutCentreKeepsTheCentrePointStable() {
        let mapping = ViewportMapping(
            viewWidth: 400, viewHeight: 225,
            frameWidth: 1280, frameHeight: 720,
            transform: ViewTransform(scale: 2, offsetX: -0.25, offsetY: -0.25)
        )
        let centre = mapping.remotePoint(viewX: 200, viewY: 112.5, captured: false)
        XCTAssertEqual(centre?.x ?? .nan, 0.5, accuracy: 0.0001)
        XCTAssertEqual(centre?.y ?? .nan, 0.5, accuracy: 0.0001)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureMappingTests`
Expected: FAIL — `cannot find 'ViewportMapping' in scope`.

- [ ] **Step 3: Write minimal implementation**

```swift
import Foundation

/// Contract values shared with android/core's GestureConstants. A value that
/// differs between the two platforms is a bug the parity fixture must catch,
/// so they are stated once here and once there, never derived.
public enum GestureConstants {
    public static let multiClickWindow = 0.450
    public static let multiClickSlop = 0.02
    public static let longPress = 0.500
    public static let longPressSlop = 0.015
    public static let dragThreshold = 0.01
    public static let maxClicks = 3
    public static let minZoom = 1.0
    public static let maxZoom = 6.0
    public static let momentumDecay = 0.94
    public static let momentumCutoff = 0.0004
}

public enum TouchPhase: String, Sendable, Codable { case began, moved, ended, cancelled }

/// One finger at one instant, in the view's own point space. The core does
/// every conversion itself, so an adapter never needs the frame's size.
public struct TouchSample: Sendable, Equatable, Codable {
    public let id: Int
    public let phase: TouchPhase
    public let x: Double
    public let y: Double
    public let t: Double

    public init(id: Int, phase: TouchPhase, x: Double, y: Double, t: Double) {
        self.id = id; self.phase = phase; self.x = x; self.y = y; self.t = t
    }
}

public enum RemoteButton: String, Sendable, Equatable, Codable { case left, right, middle }

/// What the remote should be told. Zoom and pan are deliberately absent:
/// they are local view state, and sending them would reflow the remote page
/// under the person instead of magnifying their own copy of it.
public enum GestureIntent: Sendable, Equatable, Codable {
    case move(x: Double, y: Double)
    case press(button: RemoteButton, clicks: Int)
    case release(button: RemoteButton)
    case scroll(dx: Double, dy: Double)
    case text(String)
    case key(name: String, modifiers: Int)
}

public enum GestureMode: String, Sendable, Codable { case direct, trackpad }

/// Local magnification. `offset` is in normalised frame units and is the
/// top-left of the visible window, so identity shows the whole frame.
public struct ViewTransform: Sendable, Equatable, Codable {
    public var scale: Double
    public var offsetX: Double
    public var offsetY: Double

    public static let identity = ViewTransform(scale: 1, offsetX: 0, offsetY: 0)

    public init(scale: Double, offsetX: Double, offsetY: Double) {
        self.scale = scale; self.offsetX = offsetX; self.offsetY = offsetY
    }
}

public struct RemotePoint: Sendable, Equatable {
    public let x: Double
    public let y: Double
}

/// The only thing in the system that thinks in pixels. It folds three
/// transforms into one: aspect-fit letterboxing, local zoom, and local pan.
public struct ViewportMapping: Sendable, Equatable {
    public let viewWidth: Double
    public let viewHeight: Double
    public let frameWidth: Double
    public let frameHeight: Double
    public let transform: ViewTransform

    public init(viewWidth: Double, viewHeight: Double, frameWidth: Double, frameHeight: Double, transform: ViewTransform) {
        self.viewWidth = viewWidth; self.viewHeight = viewHeight
        self.frameWidth = frameWidth; self.frameHeight = frameHeight
        self.transform = transform
    }

    /// Normalised frame coordinates for a view point, or nil when the point
    /// is in the letterbox and no drag has captured the pointer.
    public func remotePoint(viewX: Double, viewY: Double, captured: Bool) -> RemotePoint? {
        let sizes = [viewWidth, viewHeight, frameWidth, frameHeight]
        guard sizes.allSatisfy({ $0.isFinite && $0 > 0 }), viewX.isFinite, viewY.isFinite else { return nil }

        let fit = min(viewWidth / frameWidth, viewHeight / frameHeight)
        let drawnWidth = frameWidth * fit
        let drawnHeight = frameHeight * fit
        let insetX = (viewWidth - drawnWidth) / 2
        let insetY = (viewHeight - drawnHeight) / 2

        let localX = (viewX - insetX) / drawnWidth
        let localY = (viewY - insetY) / drawnHeight
        if !captured, localX < 0 || localY < 0 || localX > 1 || localY > 1 { return nil }

        let x = transform.offsetX + localX / transform.scale
        let y = transform.offsetY + localY / transform.scale
        return RemotePoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureMappingTests`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/RemoteGestureMappingTests.swift
git commit -m "feat(ios): gesture value types and viewport mapping"
```

---

### Task 2: Click sequencing in direct mode (iOS)

**Files:**
- Modify: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureClickTests.swift`

**Interfaces:**
- Consumes: Task 1's types.
- Produces: `GestureCore` with `init(mode:mapping:)`, `var mode: GestureMode`, `var mapping: ViewportMapping`, `mutating func handle(_ sample: TouchSample) -> [GestureIntent]`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureClickTests: XCTestCase {
    private func core() -> GestureCore {
        GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1280, viewHeight: 720, frameWidth: 1280, frameHeight: 720, transform: .identity
        ))
    }

    func testTapEmitsMoveThenPressThenRelease() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        let intents = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))

        XCTAssertEqual(intents, [
            .move(x: 0.5, y: 0.5),
            .press(button: .left, clicks: 1),
            .release(button: .left),
        ])
    }

    /// A second tap inside the window at the same place is a double click.
    func testSecondTapInsideTheWindowRaisesTheClickCount() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 640, y: 360, t: 0.20))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 640, y: 360, t: 0.25))

        XCTAssertEqual(intents.first(where: { if case .press = $0 { return true }; return false }),
                       .press(button: .left, clicks: 2))
    }

    /// 450ms is the contract. A tap at 460ms starts a new sequence.
    func testTapOutsideTheWindowRestartsTheSequence() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 640, y: 360, t: 0.51))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 640, y: 360, t: 0.56))

        XCTAssertEqual(intents.first(where: { if case .press = $0 { return true }; return false }),
                       .press(button: .left, clicks: 1))
    }

    /// Moving more than the slop between taps means the person meant two
    /// separate clicks, not a double click on one target.
    func testTapBeyondTheSlopRestartsTheSequence() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        // 0.02 normalised of 1280 is 25.6 points; 40 is comfortably past it.
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 690, y: 360, t: 0.20))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 690, y: 360, t: 0.25))

        XCTAssertEqual(intents.first(where: { if case .press = $0 { return true }; return false }),
                       .press(button: .left, clicks: 1))
    }

    func testSequenceWrapsAfterATripleClick() {
        var core = core()
        for tap in 0..<4 {
            let start = Double(tap) * 0.15
            _ = core.handle(TouchSample(id: tap, phase: .began, x: 640, y: 360, t: start))
            let intents = core.handle(TouchSample(id: tap, phase: .ended, x: 640, y: 360, t: start + 0.05))
            let expected = tap % GestureConstants.maxClicks + 1
            XCTAssertEqual(intents.first(where: { if case .press = $0 { return true }; return false }),
                           .press(button: .left, clicks: expected), "tap \(tap)")
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureClickTests`
Expected: FAIL — `cannot find 'GestureCore' in scope`.

- [ ] **Step 3: Write minimal implementation**

Append to `RemoteGestures.swift`:

```swift
/// The gesture state machine. Pure by construction: it holds no clock and no
/// transport, so every behaviour below is reachable from a test that feeds it
/// samples and reads the intents back.
public struct GestureCore: Sendable {
    public var mode: GestureMode
    public var mapping: ViewportMapping

    private var clickCount = 0
    private var lastClickEnd: Double?
    private var lastClickPoint: RemotePoint?
    private var activeTouch: Int?
    private var touchStart: RemotePoint?

    public init(mode: GestureMode, mapping: ViewportMapping) {
        self.mode = mode
        self.mapping = mapping
    }

    public mutating func handle(_ sample: TouchSample) -> [GestureIntent] {
        guard let point = mapping.remotePoint(viewX: sample.x, viewY: sample.y, captured: activeTouch == sample.id) else {
            return []
        }
        switch sample.phase {
        case .began:
            activeTouch = sample.id
            touchStart = point
            return []
        case .moved:
            return []
        case .ended:
            guard activeTouch == sample.id else { return [] }
            activeTouch = nil
            let clicks = nextClickCount(at: point, t: sample.t)
            return [.move(x: point.x, y: point.y), .press(button: .left, clicks: clicks), .release(button: .left)]
        case .cancelled:
            activeTouch = nil
            return []
        }
    }

    /// A sequence continues only while both the gap and the distance stay
    /// inside the contract, and wraps rather than growing without bound.
    private mutating func nextClickCount(at point: RemotePoint, t: Double) -> Int {
        let withinTime = lastClickEnd.map { t - $0 <= GestureConstants.multiClickWindow } ?? false
        let withinSlop = lastClickPoint.map {
            abs($0.x - point.x) <= GestureConstants.multiClickSlop
                && abs($0.y - point.y) <= GestureConstants.multiClickSlop
        } ?? false
        clickCount = (withinTime && withinSlop && clickCount < GestureConstants.maxClicks) ? clickCount + 1 : 1
        lastClickEnd = t
        lastClickPoint = point
        return clickCount
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureClickTests`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/RemoteGestureClickTests.swift
git commit -m "feat(ios): click sequencing for direct-mode taps"
```

---

### Task 3: Long press, drag threshold and held-button drags (iOS)

**Files:**
- Modify: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureLongPressTests.swift`

**Interfaces:**
- Consumes: Task 2's `GestureCore`.
- Produces: `mutating func tick(at t: Double) -> [GestureIntent]`, and long-press-then-drag behaviour on `handle`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureLongPressTests: XCTestCase {
    private func core() -> GestureCore {
        GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1280, viewHeight: 720, frameWidth: 1280, frameHeight: 720, transform: .identity
        ))
    }

    /// The core has no clock, so a long press only fires when the view's
    /// frame callback tells it time has passed. That is what makes it testable.
    func testHoldingPastTheThresholdFiresARightClick() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        XCTAssertEqual(core.tick(at: 0.4), [])

        XCTAssertEqual(core.tick(at: 0.5), [
            .move(x: 0.5, y: 0.5),
            .press(button: .right, clicks: 1),
            .release(button: .right),
        ])
    }

    func testMovingBeyondTheSlopCancelsThePendingLongPress() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        // 0.015 normalised of 1280 is 19.2 points; 40 is past it.
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 680, y: 360, t: 0.1))

        XCTAssertEqual(core.tick(at: 0.6), [])
    }

    /// Once the long press has fired, keeping the finger down and dragging is
    /// a selection: the left button goes down and tracks until lift.
    func testDraggingAfterALongPressHoldsTheLeftButton() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)

        let dragging = core.handle(TouchSample(id: 1, phase: .moved, x: 700, y: 360, t: 0.6))
        XCTAssertEqual(dragging, [
            .press(button: .left, clicks: 1),
            .move(x: 700.0 / 1280.0, y: 0.5),
        ])

        let lifted = core.handle(TouchSample(id: 1, phase: .ended, x: 700, y: 360, t: 0.7))
        XCTAssertEqual(lifted, [.release(button: .left)])
    }

    /// A tap that never crossed the drag threshold must not also emit a click
    /// after a long press already fired — that would be two actions per touch.
    func testLiftingAfterALongPressWithoutDraggingEmitsNothingFurther() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.6)), [])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureLongPressTests`
Expected: FAIL — `value of type 'GestureCore' has no member 'tick'`.

- [ ] **Step 3: Write minimal implementation**

Replace `GestureCore`'s stored state and `handle` with:

```swift
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

    public mutating func handle(_ sample: TouchSample) -> [GestureIntent] {
        guard let point = mapping.remotePoint(viewX: sample.x, viewY: sample.y, captured: activeTouch == sample.id) else {
            return []
        }
        switch sample.phase {
        case .began:
            activeTouch = sample.id
            touchStart = point
            touchStartTime = sample.t
            longPressArmed = true
            longPressFired = false
            dragging = false
            return []

        case .moved:
            guard activeTouch == sample.id, let start = touchStart else { return [] }
            let moved = max(abs(point.x - start.x), abs(point.y - start.y))
            if longPressArmed, moved > GestureConstants.longPressSlop { longPressArmed = false }
            guard longPressFired else { return [] }
            // The first move after a long press is what turns it into a drag,
            // so the button press is deferred to here rather than to the hold.
            if !dragging, moved > GestureConstants.dragThreshold {
                dragging = true
                heldButton = .left
                return [.press(button: .left, clicks: 1), .move(x: point.x, y: point.y)]
            }
            return dragging ? [.move(x: point.x, y: point.y)] : []

        case .ended:
            guard activeTouch == sample.id else { return [] }
            activeTouch = nil
            longPressArmed = false
            if dragging, let button = heldButton {
                dragging = false
                heldButton = nil
                return [.release(button: button)]
            }
            // A fired long press already delivered its right click.
            if longPressFired { longPressFired = false; return [] }
            let clicks = nextClickCount(at: point, t: sample.t)
            return [.move(x: point.x, y: point.y), .press(button: .left, clicks: clicks), .release(button: .left)]

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

    /// Driven by the view's frame callback. The core cannot ask what time it
    /// is, so a hold is only observable when someone tells it time moved.
    public mutating func tick(at t: Double) -> [GestureIntent] {
        guard longPressArmed, !longPressFired, activeTouch != nil, let start = touchStart else { return [] }
        guard t - touchStartTime >= GestureConstants.longPress else { return [] }
        longPressArmed = false
        longPressFired = true
        return [.move(x: start.x, y: start.y), .press(button: .right, clicks: 1), .release(button: .right)]
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureLongPressTests`
Expected: PASS, 4 tests. Re-run `swift test --filter RemoteGesture` and confirm Tasks 1–2 still pass.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/RemoteGestureLongPressTests.swift
git commit -m "feat(ios): long press, drag threshold and held-button drags"
```

---

### Task 4: Trackpad mode — virtual cursor and acceleration (iOS)

**Files:**
- Modify: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureTrackpadTests.swift`

**Interfaces:**
- Consumes: Task 3's `GestureCore`.
- Produces: `var cursor: RemotePoint` on `GestureCore`, and trackpad-mode `handle` behaviour.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureTrackpadTests: XCTestCase {
    private func core() -> GestureCore {
        GestureCore(mode: .trackpad, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000, frameWidth: 1000, frameHeight: 1000, transform: .identity
        ))
    }

    func testCursorStartsCentred() {
        XCTAssertEqual(core().cursor, RemotePoint(x: 0.5, y: 0.5))
    }

    /// Below the acceleration knee the cursor tracks the finger 1:1, so slow
    /// precise movement is predictable.
    func testSlowDragMovesTheCursorOneToOne() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        // 100 points over 1 second is 0.1 normalised/s, well under the 0.35 knee.
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 1.0))

        XCTAssertEqual(intents, [.move(x: 0.6, y: 0.5)])
        XCTAssertEqual(core.cursor.x, 0.6, accuracy: 0.0001)
    }

    /// Above the knee the same finger travel covers more screen. gain at
    /// v = 1.0 is 1 + (1.0 - 0.35) * 2.5 = 2.625.
    func testFastDragAppliesTheAccelerationCurve() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 100, y: 500, t: 0))
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 200, y: 500, t: 0.1))

        guard case let .move(x, _)? = intents.first else { return XCTFail("expected a move") }
        XCTAssertEqual(x, 0.1 + 0.1 * 2.625, accuracy: 0.0001)
    }

    func testCursorClampsAtTheEdgesWithoutWrapping() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 5000, y: 5000, t: 10))

        XCTAssertEqual(core.cursor.x, 1, accuracy: 0.0001)
        XCTAssertEqual(core.cursor.y, 1, accuracy: 0.0001)
    }

    /// The tap lands where the cursor is, not where the finger is — that is
    /// the whole point of the mode.
    func testTapClicksAtTheCursorNotTheFinger() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 1.0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 600, y: 500, t: 1.05))

        _ = core.handle(TouchSample(id: 2, phase: .began, x: 100, y: 100, t: 2.0))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 100, y: 100, t: 2.05))

        XCTAssertEqual(intents, [
            .press(button: .left, clicks: 1),
            .release(button: .left),
        ])
        XCTAssertEqual(core.cursor.x, 0.6, accuracy: 0.0001)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureTrackpadTests`
Expected: FAIL — `value of type 'GestureCore' has no member 'cursor'`.

- [ ] **Step 3: Write minimal implementation**

Add to `GestureCore`:

```swift
    /// Where the remote pointer is believed to be, in normalised frame units.
    /// Trackpad mode owns this; direct mode leaves it alone because the
    /// finger is the pointer there.
    public private(set) var cursor = RemotePoint(x: 0.5, y: 0.5)

    private var lastMovePoint: RemotePoint?
    private var lastMoveTime: Double = 0

    /// The contract curve from the spec. Continuous at the knee and capped,
    /// so a fast flick cannot throw the cursor somewhere unrecoverable.
    static func gain(forSpeed v: Double) -> Double {
        v <= 0.35 ? 1.0 : min(3.0, 1.0 + (v - 0.35) * 2.5)
    }

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
            let dt = max(sample.t - lastMoveTime, 0.001)
            let speed = (dx * dx + dy * dy).squareRoot() / dt
            let gain = Self.gain(forSpeed: speed)
            cursor = RemotePoint(
                x: min(max(cursor.x + dx * gain, 0), 1),
                y: min(max(cursor.y + dy * gain, 0), 1)
            )
            lastMovePoint = point
            lastMoveTime = sample.t
            return [.move(x: cursor.x, y: cursor.y)]

        case .ended:
            guard activeTouch == sample.id else { return [] }
            activeTouch = nil
            let travelled = touchStart.map {
                max(abs(point.x - $0.x), abs(point.y - $0.y))
            } ?? 0
            guard travelled <= GestureConstants.dragThreshold else { return [] }
            let clicks = nextClickCount(at: cursor, t: sample.t)
            return [.press(button: .left, clicks: clicks), .release(button: .left)]

        case .cancelled:
            activeTouch = nil
            return []
        }
    }
```

Then make `handle` dispatch on mode as its first act, after computing `point`:

```swift
        if mode == .trackpad { return handleTrackpad(sample, point: point) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureTrackpadTests`
Expected: PASS, 5 tests. Re-run `swift test --filter RemoteGesture` for no regressions.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/RemoteGestureTrackpadTests.swift
git commit -m "feat(ios): trackpad mode with a virtual cursor and acceleration"
```

---

### Task 5: Scroll, momentum and zoom state (iOS)

**Files:**
- Modify: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureScrollZoomTests.swift`

**Interfaces:**
- Consumes: Task 4's `GestureCore`.
- Produces: `var transform: ViewTransform` (read-only), `mutating func pinch(scale:centreX:centreY:)`, and scroll/momentum on `handle`/`tick`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureScrollZoomTests: XCTestCase {
    private func core(_ mode: GestureMode) -> GestureCore {
        GestureCore(mode: mode, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000, frameWidth: 1000, frameHeight: 1000, transform: .identity
        ))
    }

    /// Direct mode is a touchscreen: the page moves with the finger, so a
    /// downward drag scrolls the content up.
    func testOneFingerDragScrollsInDirectMode() {
        var core = core(.direct)
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.1))

        XCTAssertEqual(intents, [.scroll(dx: 0, dy: -0.1)])
    }

    /// A flick keeps scrolling after the finger leaves, decaying by contract.
    func testMomentumContinuesAfterLiftAndStops() {
        var core = core(.direct)
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.016))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 600, t: 0.032))

        guard case let .scroll(_, first)? = core.tick(at: 0.048).first else {
            return XCTFail("expected momentum to continue")
        }
        guard case let .scroll(_, second)? = core.tick(at: 0.064).first else {
            return XCTFail("expected momentum to continue")
        }
        XCTAssertEqual(second / first, GestureConstants.momentumDecay, accuracy: 0.0001)

        for step in 3..<400 { _ = core.tick(at: 0.032 + Double(step) * 0.016) }
        XCTAssertEqual(core.tick(at: 10), [], "momentum must stop below the cutoff")
    }

    /// Pinching about a point keeps that point under the fingers — the thing
    /// you are zooming into must not slide away.
    func testPinchKeepsTheAnchorPointStable() {
        var core = core(.direct)
        core.pinch(scale: 2, centreX: 250, centreY: 250)

        let anchor = core.mapping.remotePoint(viewX: 250, viewY: 250, captured: false)
        XCTAssertEqual(anchor?.x ?? .nan, 0.25, accuracy: 0.0001)
        XCTAssertEqual(anchor?.y ?? .nan, 0.25, accuracy: 0.0001)
    }

    func testZoomClampsToTheContractBounds() {
        var core = core(.direct)
        core.pinch(scale: 100, centreX: 500, centreY: 500)
        XCTAssertEqual(core.transform.scale, GestureConstants.maxZoom, accuracy: 0.0001)

        core.pinch(scale: 0.001, centreX: 500, centreY: 500)
        XCTAssertEqual(core.transform.scale, GestureConstants.minZoom, accuracy: 0.0001)
        XCTAssertEqual(core.transform.offsetX, 0, accuracy: 0.0001)
        XCTAssertEqual(core.transform.offsetY, 0, accuracy: 0.0001)
    }

    /// Panning cannot reveal anything outside the frame.
    func testPanClampsAtTheFrameEdges() {
        var core = core(.direct)
        core.pinch(scale: 2, centreX: 500, centreY: 500)
        core.pan(dx: -10_000, dy: -10_000)

        XCTAssertEqual(core.transform.offsetX, 0.5, accuracy: 0.0001)
        XCTAssertEqual(core.transform.offsetY, 0.5, accuracy: 0.0001)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureScrollZoomTests`
Expected: FAIL — `value of type 'GestureCore' has no member 'pinch'`.

- [ ] **Step 3: Write minimal implementation**

Add to `GestureCore`:

```swift
    public private(set) var transform = ViewTransform.identity

    private var momentumX: Double = 0
    private var momentumY: Double = 0
    private var lastTickTime: Double?

    /// Zoom about a view point, keeping whatever is under it in place. The
    /// offset correction is what stops the target sliding out from under the
    /// fingers, which is the difference between usable and infuriating.
    public mutating func pinch(scale: Double, centreX: Double, centreY: Double) {
        guard scale.isFinite, scale > 0 else { return }
        let anchor = mapping.remotePoint(viewX: centreX, viewY: centreY, captured: true)
        let next = min(max(transform.scale * scale, GestureConstants.minZoom), GestureConstants.maxZoom)
        guard let anchor else { transform.scale = next; return }

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
        guard dx.isFinite, dy.isFinite, mapping.viewWidth > 0, mapping.viewHeight > 0 else { return }
        transform.offsetX -= dx / (mapping.viewWidth * transform.scale)
        transform.offsetY -= dy / (mapping.viewHeight * transform.scale)
        clampPan()
        syncMapping()
    }

    private mutating func clampPan() {
        let span = 1 / transform.scale
        let limit = max(0, 1 - span)
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
```

In direct mode's `.moved` branch, before the long-press drag logic, add the scroll path:

```swift
            if !longPressFired {
                guard let previous = lastMovePoint else { return [] }
                let dx = point.x - previous.x
                let dy = point.y - previous.y
                lastMovePoint = point
                let dt = max(sample.t - lastMoveTime, 0.001)
                lastMoveTime = sample.t
                guard max(abs(dx), abs(dy)) > 0 else { return [] }
                momentumX = -dx / dt * 0.016
                momentumY = -dy / dt * 0.016
                return [.scroll(dx: -dx, dy: -dy)]
            }
```

Set `lastMovePoint`/`lastMoveTime` in direct mode's `.began` too, and extend `tick` to run momentum after the long-press check:

```swift
        defer { lastTickTime = t }
        guard abs(momentumX) > GestureConstants.momentumCutoff
            || abs(momentumY) > GestureConstants.momentumCutoff else {
            momentumX = 0; momentumY = 0
            return []
        }
        let intent = GestureIntent.scroll(dx: momentumX, dy: momentumY)
        momentumX *= GestureConstants.momentumDecay
        momentumY *= GestureConstants.momentumDecay
        return [intent]
```

Momentum must be cleared on any `.began`, so a new touch stops a running flick.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureScrollZoomTests`
Expected: PASS, 5 tests. Re-run `swift test --filter RemoteGesture`.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/RemoteGestureScrollZoomTests.swift
git commit -m "feat(ios): scroll, momentum and local zoom state"
```

---

### Task 6: Driving gate and held-input flush (iOS)

**Files:**
- Modify: `ios/Sources/CompanionCore/RemoteGestures.swift`
- Test: `ios/Tests/CompanionCoreTests/RemoteGestureFlushTests.swift`

**Interfaces:**
- Consumes: Task 5's `GestureCore`.
- Produces: `var driving: Bool`, `mutating func flush() -> [GestureIntent]`.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import CompanionCore

final class RemoteGestureFlushTests: XCTestCase {
    private func core() -> GestureCore {
        var core = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000, frameWidth: 1000, frameHeight: 1000, transform: .identity
        ))
        core.driving = true
        return core
    }

    /// Watching is not driving. A stray touch while not driving must never
    /// reach the remote, whatever it looks like.
    func testNotDrivingEmitsNothing() {
        var core = core()
        core.driving = false
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 500, t: 0.05)), [])
        XCTAssertEqual(core.tick(at: 1), [])
    }

    /// Backgrounding mid-drag must not leave a button held on the remote.
    func testFlushReleasesAHeldButtonAndStopsMomentum() {
        var core = core()
        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.tick(at: 0.5)
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 0.6))

        XCTAssertEqual(core.flush(), [.release(button: .left)])
        XCTAssertEqual(core.flush(), [], "a second flush has nothing left to release")
        XCTAssertEqual(core.tick(at: 1.0), [], "momentum must not survive a flush")
    }

    func testFlushWithNothingHeldEmitsNothing() {
        XCTAssertEqual(core().flush(), [])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureFlushTests`
Expected: FAIL — `value of type 'GestureCore' has no member 'driving'`.

- [ ] **Step 3: Write minimal implementation**

```swift
    /// The take/release gate. False means watching: no touch may reach the
    /// remote, so a scroll to read cannot become a click on a live page.
    public var driving = false

    /// Release everything held, newest first, and abandon momentum. Called on
    /// explicit release, on backgrounding, and on connection loss — a key or
    /// button left down on the remote outlives the session otherwise.
    public mutating func flush() -> [GestureIntent] {
        momentumX = 0
        momentumY = 0
        activeTouch = nil
        longPressArmed = false
        longPressFired = false
        guard dragging, let button = heldButton else { return [] }
        dragging = false
        heldButton = nil
        return [.release(button: button)]
    }
```

Guard both entry points as their first statement:

```swift
    public mutating func handle(_ sample: TouchSample) -> [GestureIntent] {
        guard driving else { return [] }
        ...
    }

    public mutating func tick(at t: Double) -> [GestureIntent] {
        guard driving else { return [] }
        ...
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureFlushTests`
Expected: PASS, 3 tests.

Then fix the earlier suites, which now need `core.driving = true` in their helpers. Run `cd ios && swift test --filter RemoteGesture` and expect all suites green.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/
git commit -m "feat(ios): driving gate and held-input flush"
```

---

### Task 7: The shared parity fixture (iOS side)

**Files:**
- Create: `ios/Tests/CompanionCoreTests/Fixtures/gesture-parity.json`
- Create: `ios/Tests/CompanionCoreTests/RemoteGestureParityTests.swift`

**Learned during Task 5, binding on this task:** intents must be compared
with a tolerance, never with `==`. Normalising a coordinate through a division
yields `-0.09999999999999998` and a signed `-0.0`, both of which fail exact
equality against the obvious literal. Swift and Kotlin will not round
identically either, so the parity runner on both platforms compares numbers
within `0.0001` and compares only the case and button by identity.

**Interfaces:**
- Consumes: the whole `GestureCore`.
- Produces: `gesture-parity.json`, whose schema Task 12 reads from Kotlin. Schema: `{"cases":[{"name":String,"mode":"direct"|"trackpad","view":[w,h],"frame":[w,h],"driving":Bool,"steps":[{"touch":{...}}|{"tick":Double}],"expect":[Intent]}]}` where an `Intent` is `{"move":{"x":,"y":}}`, `{"press":{"button":,"clicks":}}`, `{"release":{"button":}}` or `{"scroll":{"dx":,"dy":}}`.

- [ ] **Step 1: Write the failing test**

Create the fixture with four cases spanning both modes:

```json
{
  "cases": [
    {
      "name": "direct tap clicks once where the finger landed",
      "mode": "direct", "view": [1000, 1000], "frame": [1000, 1000], "driving": true,
      "steps": [
        {"touch": {"id": 1, "phase": "began", "x": 400, "y": 250, "t": 0}},
        {"touch": {"id": 1, "phase": "ended", "x": 400, "y": 250, "t": 0.05}}
      ],
      "expect": [
        {"move": {"x": 0.4, "y": 0.25}},
        {"press": {"button": "left", "clicks": 1}},
        {"release": {"button": "left"}}
      ]
    },
    {
      "name": "direct double tap inside the window raises the count",
      "mode": "direct", "view": [1000, 1000], "frame": [1000, 1000], "driving": true,
      "steps": [
        {"touch": {"id": 1, "phase": "began", "x": 400, "y": 250, "t": 0}},
        {"touch": {"id": 1, "phase": "ended", "x": 400, "y": 250, "t": 0.05}},
        {"touch": {"id": 2, "phase": "began", "x": 400, "y": 250, "t": 0.2}},
        {"touch": {"id": 2, "phase": "ended", "x": 400, "y": 250, "t": 0.25}}
      ],
      "expect": [
        {"move": {"x": 0.4, "y": 0.25}},
        {"press": {"button": "left", "clicks": 1}},
        {"release": {"button": "left"}},
        {"move": {"x": 0.4, "y": 0.25}},
        {"press": {"button": "left", "clicks": 2}},
        {"release": {"button": "left"}}
      ]
    },
    {
      "name": "direct long press right clicks at the hold point",
      "mode": "direct", "view": [1000, 1000], "frame": [1000, 1000], "driving": true,
      "steps": [
        {"touch": {"id": 1, "phase": "began", "x": 600, "y": 600, "t": 0}},
        {"tick": 0.4},
        {"tick": 0.5}
      ],
      "expect": [
        {"move": {"x": 0.6, "y": 0.6}},
        {"press": {"button": "right", "clicks": 1}},
        {"release": {"button": "right"}}
      ]
    },
    {
      "name": "not driving swallows every touch",
      "mode": "direct", "view": [1000, 1000], "frame": [1000, 1000], "driving": false,
      "steps": [
        {"touch": {"id": 1, "phase": "began", "x": 400, "y": 250, "t": 0}},
        {"touch": {"id": 1, "phase": "ended", "x": 400, "y": 250, "t": 0.05}}
      ],
      "expect": []
    }
  ]
}
```

And the runner:

```swift
import XCTest
@testable import CompanionCore

/// The parity harness. Both platforms run this same file, so a behaviour
/// added on one and not the other fails here rather than in a bug report.
final class RemoteGestureParityTests: XCTestCase {
    func testEveryFixtureCaseProducesItsDocumentedIntents() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/gesture-parity", withExtension: "json"))
        let suite = try JSONDecoder().decode(ParitySuite.self, from: Data(contentsOf: url))
        XCTAssertFalse(suite.cases.isEmpty)

        for testCase in suite.cases {
            var core = GestureCore(mode: testCase.mode, mapping: ViewportMapping(
                viewWidth: testCase.view[0], viewHeight: testCase.view[1],
                frameWidth: testCase.frame[0], frameHeight: testCase.frame[1],
                transform: .identity
            ))
            core.driving = testCase.driving

            var produced: [GestureIntent] = []
            for step in testCase.steps {
                if let touch = step.touch { produced += core.handle(touch) }
                if let tick = step.tick { produced += core.tick(at: tick) }
            }
            XCTAssertEqual(produced, testCase.expect, testCase.name)
        }
    }
}

struct ParitySuite: Decodable { let cases: [ParityCase] }

struct ParityCase: Decodable {
    let name: String
    let mode: GestureMode
    let view: [Double]
    let frame: [Double]
    let driving: Bool
    let steps: [ParityStep]
    let expect: [GestureIntent]
}

struct ParityStep: Decodable {
    let touch: TouchSample?
    let tick: Double?
}
```

`GestureIntent`'s generated `Codable` conformance must match the fixture's shape. Add an explicit `init(from:)`/`encode(to:)` on `GestureIntent` keyed on `move`/`press`/`release`/`scroll` rather than relying on Swift's default enum encoding, which nests under `_0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ios && swift test --filter RemoteGestureParityTests`
Expected: FAIL — either the resource is missing or decoding rejects the intent shape.

- [ ] **Step 3: Write minimal implementation**

Add the explicit `Codable` conformance to `GestureIntent` in `RemoteGestures.swift`, encoding `.move` as `{"move":{"x":…,"y":…}}`, `.press` as `{"press":{"button":…,"clicks":…}}`, `.release` as `{"release":{"button":…}}`, `.scroll` as `{"scroll":{"dx":…,"dy":…}}`, `.text` as `{"text":…}` and `.key` as `{"key":{"name":…,"modifiers":…}}`.

`Package.swift` already copies `Fixtures`, so no manifest change is needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ios && swift test --filter RemoteGestureParityTests`
Expected: PASS, 4 fixture cases.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/CompanionCore/RemoteGestures.swift ios/Tests/CompanionCoreTests/Fixtures/gesture-parity.json ios/Tests/CompanionCoreTests/RemoteGestureParityTests.swift
git commit -m "test(ios): shared gesture parity fixture and runner"
```

---

### Task 8: Kotlin value types and viewport mapping

**Files:**
- Create: `android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt`
- Test: `android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureMappingTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `TouchPhase`, `TouchSample`, `RemoteButton`, `GestureIntent`, `GestureMode`, `GestureConstants`, `ViewTransform`, `ViewportMapping.remotePoint(viewX, viewY, captured): RemotePoint?` — names identical to Task 1.

- [ ] **Step 1: Write the failing test**

Port `RemoteGestureMappingTests` verbatim in behaviour:

```kotlin
package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RemoteGestureMappingTest {
    private fun close(a: Double, b: Double) = assertTrue(abs(a - b) < 0.0001, "$a != $b")

    @Test
    fun letterboxedFrameMapsImageCornersToTheUnitSquare() {
        val mapping = ViewportMapping(400.0, 400.0, 1280.0, 720.0, ViewTransform.IDENTITY)
        val topLeft = assertNotNull(mapping.remotePoint(0.0, 87.5, false))
        val bottomRight = assertNotNull(mapping.remotePoint(400.0, 312.5, false))

        close(topLeft.x, 0.0); close(topLeft.y, 0.0)
        close(bottomRight.x, 1.0); close(bottomRight.y, 1.0)
    }

    @Test
    fun letterboxRejectsUncapturedTouchesAndClampsCapturedOnes() {
        val mapping = ViewportMapping(400.0, 400.0, 1280.0, 720.0, ViewTransform.IDENTITY)
        assertNull(mapping.remotePoint(200.0, 10.0, false))
        close(assertNotNull(mapping.remotePoint(200.0, 10.0, true)).y, 0.0)
    }

    @Test
    fun zoomAboutCentreKeepsTheCentrePointStable() {
        val mapping = ViewportMapping(400.0, 225.0, 1280.0, 720.0, ViewTransform(2.0, -0.25, -0.25))
        val centre = assertNotNull(mapping.remotePoint(200.0, 112.5, false))
        close(centre.x, 0.5); close(centre.y, 0.5)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureMappingTest*'`
Expected: FAIL — unresolved reference `ViewportMapping`.

- [ ] **Step 3: Write minimal implementation**

Mirror Task 1's Swift exactly, using `kotlinx.serialization` annotations so Task 12 can decode the same fixture. Constants go in an `object GestureConstants` with the same names and values.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureMappingTest*'`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureMappingTest.kt
git commit -m "feat(android): gesture value types and viewport mapping"
```

---

### Task 9: Kotlin click sequencing, long press and drags

**Files:**
- Modify: `android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt`
- Test: `android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureClickTest.kt`

**Interfaces:**
- Consumes: Task 8's types.
- Produces: `class GestureCore(var mode: GestureMode, var mapping: ViewportMapping)` with `handle(sample: TouchSample): List<GestureIntent>` and `tick(t: Double): List<GestureIntent>`.

Kotlin's `GestureCore` is a `class`, not a `data class`: it is mutable state, and structural equality on it would be meaningless.

- [ ] **Step 1: Write the failing test**

Port the five cases from Task 2 and the four from Task 3 into one `RemoteGestureClickTest`, keeping each test's name and assertions equivalent.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureClickTest*'`
Expected: FAIL — unresolved reference `GestureCore`.

- [ ] **Step 3: Write minimal implementation**

Mirror Tasks 2 and 3's Swift, keeping identical field names, identical ordering of emitted intents, and the same comments explaining *why* each rule exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureClickTest*'`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureClickTest.kt
git commit -m "feat(android): click sequencing, long press and held-button drags"
```

---

### Task 10: Kotlin trackpad mode

**Files:**
- Modify: `android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt`
- Test: `android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureTrackpadTest.kt`

**Interfaces:**
- Consumes: Task 9's `GestureCore`.
- Produces: `val cursor: RemotePoint`, and `GestureCore.gain(speed: Double): Double` in a companion object.

- [ ] **Step 1: Write the failing test**

Port Task 4's five cases.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureTrackpadTest*'`
Expected: FAIL — unresolved reference `cursor`.

- [ ] **Step 3: Write minimal implementation**

Mirror Task 4, including the exact two-segment `gain` curve.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureTrackpadTest*'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureTrackpadTest.kt
git commit -m "feat(android): trackpad mode with a virtual cursor and acceleration"
```

---

### Task 11: Kotlin scroll, momentum, zoom, driving gate and flush

**Files:**
- Modify: `android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt`
- Test: `android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureScrollZoomTest.kt`

**Interfaces:**
- Consumes: Task 10's `GestureCore`.
- Produces: `val transform: ViewTransform`, `pinch(scale, centreX, centreY)`, `pan(dx, dy)`, `var driving: Boolean`, `flush(): List<GestureIntent>`.

- [ ] **Step 1: Write the failing test**

Port Task 5's five cases and Task 6's three.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureScrollZoomTest*'`
Expected: FAIL — unresolved reference `pinch`.

- [ ] **Step 3: Write minimal implementation**

Mirror Tasks 5 and 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :core:test`
Expected: PASS, whole `:core` suite including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add android/core/src/main/kotlin/com/openmausbot/companion/core/RemoteGestures.kt android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureScrollZoomTest.kt
git commit -m "feat(android): scroll, momentum, zoom, driving gate and flush"
```

---

### Task 12: Kotlin parity runner against the shared fixture

**Files:**
- Create: `android/core/src/test/resources/gesture-parity.json` (symlink or copy of the iOS fixture)
- Create: `android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureParityTest.kt`
- Modify: `docs/superpowers/specs/2026-09-18-mobile-touch-control-design.md` — record where the fixture lives and that both suites must load it.

**Interfaces:**
- Consumes: the whole Kotlin `GestureCore`, and Task 7's fixture schema.
- Produces: nothing further; this is the parity gate.

The fixture must exist once, not twice. Copy it in a Gradle `processTestResources` step sourced from `ios/Tests/CompanionCoreTests/Fixtures/gesture-parity.json` so a case added on either platform is seen by both. A second checked-in copy would drift and defeat the purpose.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.openmausbot.companion.core

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RemoteGestureParityTest {
    @Test
    fun everyFixtureCaseProducesItsDocumentedIntents() {
        val text = checkNotNull(javaClass.getResourceAsStream("/gesture-parity.json")) {
            "gesture-parity.json is not on the test classpath"
        }.bufferedReader().readText()
        val suite = Json { ignoreUnknownKeys = true }.decodeFromString<ParitySuite>(text)
        assertTrue(suite.cases.isNotEmpty())

        for (case in suite.cases) {
            val core = GestureCore(
                case.mode,
                ViewportMapping(case.view[0], case.view[1], case.frame[0], case.frame[1], ViewTransform.IDENTITY),
            )
            core.driving = case.driving

            val produced = buildList {
                for (step in case.steps) {
                    step.touch?.let { addAll(core.handle(it)) }
                    step.tick?.let { addAll(core.tick(it)) }
                }
            }
            assertEquals(case.expect, produced, case.name)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureParityTest*'`
Expected: FAIL — the resource is not on the classpath.

- [ ] **Step 3: Write minimal implementation**

**No Gradle copy task is needed — this plan was wrong about that.**
`android/core/build.gradle.kts` already points the test source set straight at
the iOS fixtures directory:

```kotlin
sourceSets.test {
    resources.srcDir(rootProject.projectDir.resolve("../ios/Tests/CompanionCoreTests/Fixtures"))
}
```

Sharing one fixture directory across both platforms is an existing convention
in this repo, not something to invent. A file dropped in
`ios/Tests/CompanionCoreTests/Fixtures/` is on the Kotlin test classpath with
no build change at all.

Add `@Serializable` data classes `ParitySuite`, `ParityCase`, `ParityStep` and
`ParityIntent` mirroring Task 7's schema. Decode the expectations structurally
— one object with exactly one of `move`/`press`/`release`/`scroll`/`text`/`key`
set — rather than through `GestureIntent`'s polymorphic serializer, which
would expect a discriminator the iOS coder does not write.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd android && ./gradlew :core:test --tests '*RemoteGestureParityTest*'`
Expected: PASS, 4 fixture cases — the same four iOS runs.

Then verify parity is real by breaking one platform's constant and confirming
the gate fails. **Do this, do not skip it.** Doing it caught a hole in the
fixture: the long-press case fed `tick 0.4` then `tick 0.5` and compared only
the accumulated output, so a 300ms threshold produced exactly the same three
intents as a 500ms one and the sabotage passed. A duration is only pinned by a
case that also asserts nothing happens *below* it, which is why the fixture
carries "direct hold short of the threshold does nothing yet".

The general rule for any case added later: an expectation that accumulates
across several steps cannot pin a threshold. Pair it with a case that stops
short.

- [ ] **Step 5: Commit**

```bash
git add android/core/build.gradle.kts android/core/src/test/kotlin/com/openmausbot/companion/core/RemoteGestureParityTest.kt docs/superpowers/specs/2026-09-18-mobile-touch-control-design.md
git commit -m "test(android): run the shared gesture parity fixture"
```

---

## What this plan deliberately leaves to plan 2

- `BrowserLiveSink` on both platforms — mapping intents to `input_mouse` / `input_keyboard` / `char` bodies and posting them.
- The input queue port from `src/lib/browser-input-queue.ts`.
- `browserControlAccess` on `DeviceRecord`, the `routes.ts` allowlist entry, and widening the owner-only gate at `server/index.ts:11570`.
- Platform adapters (`UIGestureRecognizer`, `pointerInput`) and the UI: mode toggle, cursor rendering, keyboard accessory bar, take/release affordance.
- Cellular frame-rate capping and the 429 contention message.

Each depends on the core's interface being settled, which is what this plan delivers.
