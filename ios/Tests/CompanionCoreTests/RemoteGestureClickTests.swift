import XCTest
@testable import CompanionCore

final class RemoteGestureClickTests: XCTestCase {
    /// A 1:1 view and frame, so a view point divided by 1280 is its own
    /// normalised coordinate and the expectations stay readable.
    private func core() -> GestureCore {
        var core = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1280, viewHeight: 720,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        ))
        core.driving = true
        return core
    }

    private func press(in intents: [GestureIntent]) -> GestureIntent? {
        intents.first { if case .press = $0 { return true } else { return false } }
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

    func testSecondTapInsideTheWindowRaisesTheClickCount() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 640, y: 360, t: 0.20))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 640, y: 360, t: 0.25))

        XCTAssertEqual(press(in: intents), .press(button: .left, clicks: 2))
    }

    /// 450ms is the contract, so a tap landing after it starts over.
    func testTapOutsideTheWindowRestartsTheSequence() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 640, y: 360, t: 0.51))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 640, y: 360, t: 0.56))

        XCTAssertEqual(press(in: intents), .press(button: .left, clicks: 1))
    }

    /// Moving further than the slop between taps means two clicks on two
    /// targets, not a double click on one.
    func testTapBeyondTheSlopRestartsTheSequence() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 640, y: 360, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 640, y: 360, t: 0.05))
        // The slop is 0.02 normalised, which is 25.6 points across 1280.
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 690, y: 360, t: 0.20))
        let intents = core.handle(TouchSample(id: 2, phase: .ended, x: 690, y: 360, t: 0.25))

        XCTAssertEqual(press(in: intents), .press(button: .left, clicks: 1))
    }

    /// Four taps in a row read 1, 2, 3, 1 — a quadruple click means nothing
    /// to a browser, and an unbounded counter would eventually send one.
    func testSequenceWrapsAfterATripleClick() {
        var core = core()

        for tap in 0..<4 {
            let start = Double(tap) * 0.15
            _ = core.handle(TouchSample(id: tap, phase: .began, x: 640, y: 360, t: start))
            let intents = core.handle(TouchSample(id: tap, phase: .ended, x: 640, y: 360, t: start + 0.05))

            XCTAssertEqual(
                press(in: intents),
                .press(button: .left, clicks: tap % GestureConstants.maxClicks + 1),
                "tap \(tap)"
            )
        }
    }
}
