import XCTest
@testable import CompanionCore

final class RemoteGestureTrackpadTests: XCTestCase {
    /// A square 1000x1000 view over a square frame, so a view point divided
    /// by 1000 is its own normalised coordinate.
    private func core() -> GestureCore {
        var core = GestureCore(mode: .trackpad, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000,
            frameWidth: 1000, frameHeight: 1000,
            transform: .identity
        ))
        core.driving = true
        return core
    }

    func testCursorStartsCentred() {
        XCTAssertEqual(core().cursor, RemotePoint(x: 0.5, y: 0.5))
    }

    /// Below the acceleration knee the cursor tracks the finger one to one,
    /// so slow precise movement is predictable — which is the entire reason
    /// this mode exists.
    func testSlowDragMovesTheCursorOneToOne() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        // 100 points over a second is 0.1 normalised/s, far under the 0.35 knee.
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 1.0))

        XCTAssertEqual(intents, [.move(x: 0.6, y: 0.5)])
        XCTAssertEqual(core.cursor.x, 0.6, accuracy: 0.0001)
    }

    /// Above the knee the same finger travel covers more screen. At v = 1.0
    /// the contract gain is 1 + (1.0 - 0.35) * 2.5 = 2.625.
    func testFastDragAppliesTheAccelerationCurve() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 100, y: 500, t: 0))
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 200, y: 500, t: 0.1))

        guard case let .move(x, _)? = intents.first else { return XCTFail("expected a move") }
        XCTAssertEqual(x, 0.5 + 0.1 * 2.625, accuracy: 0.0001)
    }

    /// The curve is continuous at the knee and capped, so a flick cannot
    /// throw the cursor somewhere the person has to hunt for it.
    func testTheGainCurveIsContinuousAtTheKneeAndCapped() {
        XCTAssertEqual(GestureCore.gain(forSpeed: 0.0), 1.0, accuracy: 0.0001)
        XCTAssertEqual(GestureCore.gain(forSpeed: 0.35), 1.0, accuracy: 0.0001)
        XCTAssertEqual(GestureCore.gain(forSpeed: 0.3501), 1.0, accuracy: 0.001)
        XCTAssertEqual(GestureCore.gain(forSpeed: 100), 3.0, accuracy: 0.0001)
    }

    func testCursorClampsAtTheEdgesWithoutWrapping() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 5000, y: 5000, t: 10))

        XCTAssertEqual(core.cursor.x, 1, accuracy: 0.0001)
        XCTAssertEqual(core.cursor.y, 1, accuracy: 0.0001)
    }

    /// The tap lands where the cursor is, not where the finger is. That is
    /// the whole point of the mode, and the one thing a port must not get
    /// subtly wrong.
    func testTapClicksAtTheCursorNotTheFinger() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 1.0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 600, y: 500, t: 1.05))

        _ = core.handle(TouchSample(id: 2, phase: .began, x: 100, y: 100, t: 2.0))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 100, y: 100, t: 2.05))

        // The move must come first, or the sink stamps the click at a stale
        // coordinate while the reticle sits somewhere else entirely.
        XCTAssertEqual(intents, [
            .move(x: 0.6, y: 0.5),
            .press(button: .left, clicks: 1),
            .release(button: .left),
        ])
        XCTAssertEqual(core.cursor.x, 0.6, accuracy: 0.0001)
    }

    /// A drag is a move, not a click. Lifting after travelling must not also
    /// click wherever the cursor stopped.
    func testDraggingThenLiftingDoesNotClick() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 700, y: 500, t: 1.0))

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 700, y: 500, t: 1.05)), [])
    }
}
