import XCTest
@testable import CompanionCore

final class RemoteGestureFlushTests: XCTestCase {
    private func core() -> GestureCore {
        var core = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000,
            frameWidth: 1000, frameHeight: 1000,
            transform: .identity
        ))
        core.driving = true
        return core
    }

    /// Watching is not driving. A stray touch while merely watching must
    /// never reach the remote, whatever it looks like — this is the whole
    /// safety property of take/release.
    func testNotDrivingEmitsNothing() {
        var core = core()
        core.driving = false

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 500, t: 0.05)), [])
        XCTAssertEqual(core.tick(at: 1), [])
    }

    /// A core is not driving until someone says so, so forgetting to set it
    /// fails safe rather than handing control away.
    func testDrivingIsOffByDefault() {
        let fresh = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000,
            frameWidth: 1000, frameHeight: 1000,
            transform: .identity
        ))

        XCTAssertFalse(fresh.driving)
    }

    /// Backgrounding mid-drag must not leave a button held down on the
    /// remote, where nothing will ever lift it.
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
        var core = core()

        XCTAssertEqual(core.flush(), [])
    }

    /// A flick interrupted by a disconnect must not keep scrolling when the
    /// session comes back.
    func testFlushAbandonsMomentum() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.016))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 600, t: 0.032))

        XCTAssertEqual(core.flush(), [])
        XCTAssertEqual(core.tick(at: 0.048), [])
    }

    /// After a flush the next touch is a clean gesture, not a continuation of
    /// the one that was interrupted.
    func testATouchAfterAFlushBehavesAsAFreshTap() {
        var core = core()

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.tick(at: 0.5)
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 600, y: 500, t: 0.6))
        _ = core.flush()

        _ = core.handle(TouchSample(id: 2, phase: .began, x: 500, y: 500, t: 1.0))
        XCTAssertEqual(core.handle(TouchSample(id: 2, phase: .ended, x: 500, y: 500, t: 1.05)), [
            .move(x: 0.5, y: 0.5),
            .press(button: .left, clicks: 1),
            .release(button: .left),
        ])
    }
}
