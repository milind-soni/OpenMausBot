import XCTest
@testable import CompanionCore

final class RemoteGestureLongPressTests: XCTestCase {
    private func core() -> GestureCore {
        var core = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1280, viewHeight: 720,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        ))
        core.driving = true
        return core
    }

    /// The core has no clock, so a hold is only observable when the view's
    /// frame callback tells it time moved. That is exactly what makes a
    /// duration-based gesture testable without waiting half a second.
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

    /// Fires once, not on every later frame.
    func testTheLongPressDoesNotRepeatWhileTheFingerStaysDown() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)

        XCTAssertEqual(core.tick(at: 0.6), [])
        XCTAssertEqual(core.tick(at: 1.5), [])
    }

    /// The move that cancels the hold is itself a scroll, so it seeds
    /// momentum. What must not happen is the right click.
    func testMovingBeyondTheSlopCancelsThePendingLongPress() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        // The slop is 0.015 normalised, which is 19.2 points across 1280.
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 680, y: 360, t: 0.1))

        let afterTheThreshold = core.tick(at: 0.6)
        XCTAssertFalse(
            afterTheThreshold.contains { if case .press = $0 { return true } else { return false } },
            "a cancelled hold must never click"
        )
    }

    /// Once the long press has fired, keeping the finger down and dragging is
    /// a selection: the left button goes down and tracks until lift.
    func testDraggingAfterALongPressHoldsTheLeftButton() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .moved, x: 700, y: 360, t: 0.6)), [
            .press(button: .left, clicks: 1),
            .move(x: 700.0 / 1280.0, y: 0.5),
        ])
        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .moved, x: 720, y: 360, t: 0.7)), [
            .move(x: 720.0 / 1280.0, y: 0.5),
        ])
        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 720, y: 360, t: 0.8)), [
            .release(button: .left),
        ])
    }

    /// A long press that fired already delivered its right click. Lifting
    /// must not also emit a left click — that would be two actions per touch.
    func testLiftingAfterALongPressWithoutDraggingEmitsNothingFurther() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.6)), [])
    }

    /// A cancelled touch mid-drag must still release, or the remote is left
    /// with a button held down that nothing will ever lift.
    func testCancellingMidDragStillReleasesTheButton() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.tick(at: 0.5)
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 700, y: 360, t: 0.6))

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .cancelled, x: 700, y: 360, t: 0.7)), [
            .release(button: .left),
        ])
    }
}
