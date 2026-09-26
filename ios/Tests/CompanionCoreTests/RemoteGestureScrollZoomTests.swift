import XCTest
@testable import CompanionCore

final class RemoteGestureScrollZoomTests: XCTestCase {
    private func core(_ mode: GestureMode) -> GestureCore {
        var core = GestureCore(mode: mode, mapping: ViewportMapping(
            viewWidth: 1000, viewHeight: 1000,
            frameWidth: 1000, frameHeight: 1000,
            transform: .identity
        ))
        core.driving = true
        return core
    }

    /// Direct mode is a touchscreen: the page moves with the finger, so
    /// dragging down scrolls the content up.
    func testOneFingerDragScrollsInDirectMode() {
        var core = core(.direct)

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        let intents = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.1))

        // Compared with tolerance, not equality: normalising through a
        // division leaves -0.09999999999999998, and an exact match here would
        // be a test that fails on arithmetic rather than on behaviour.
        guard case let .scroll(dx, dy)? = intents.first, intents.count == 1 else {
            return XCTFail("expected exactly one scroll, got \(intents)")
        }
        XCTAssertEqual(dx, 0, accuracy: 0.0001)
        XCTAssertEqual(dy, -0.1, accuracy: 0.0001)
    }

    /// Scrolling must not also click on lift — a flick through a page of
    /// links would otherwise open one.
    func testScrollingThenLiftingDoesNotClick() {
        var core = core(.direct)

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.1))

        XCTAssertEqual(core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 600, t: 0.15)), [])
    }

    /// A flick keeps scrolling after the finger leaves, decaying by contract
    /// and stopping rather than trickling forever.
    func testMomentumContinuesAfterLiftThenStops() {
        var core = core(.direct)

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.016))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 600, t: 0.032))

        guard case let .scroll(_, first)? = core.tick(at: 0.048).first,
              case let .scroll(_, second)? = core.tick(at: 0.064).first else {
            return XCTFail("expected momentum to continue after the lift")
        }
        XCTAssertEqual(second / first, GestureConstants.momentumDecay, accuracy: 0.0001)

        for step in 2..<600 { _ = core.tick(at: 0.032 + Double(step) * 0.016) }
        XCTAssertEqual(core.tick(at: 60), [], "momentum must stop below the cutoff")
    }

    /// Touching the screen during a flick stops it, the way every scroll view
    /// on both platforms behaves.
    func testANewTouchStopsMomentum() {
        var core = core(.direct)

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        _ = core.handle(TouchSample(id: 1, phase: .moved, x: 500, y: 600, t: 0.016))
        _ = core.handle(TouchSample(id: 1, phase: .ended, x: 500, y: 600, t: 0.032))
        _ = core.handle(TouchSample(id: 2, phase: .began, x: 500, y: 500, t: 0.05))

        XCTAssertEqual(core.tick(at: 0.066), [])
    }

    /// Pinching about a point keeps that point under the fingers. If the
    /// target slides away, zooming to reach a small control is useless.
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

    /// Panning cannot reveal anything outside the frame, at any zoom.
    func testPanClampsAtTheFrameEdges() {
        var core = core(.direct)

        core.pinch(scale: 2, centreX: 500, centreY: 500)
        core.pan(dx: -10_000, dy: -10_000)

        XCTAssertEqual(core.transform.offsetX, 0.5, accuracy: 0.0001)
        XCTAssertEqual(core.transform.offsetY, 0.5, accuracy: 0.0001)

        core.pan(dx: 10_000, dy: 10_000)
        XCTAssertEqual(core.transform.offsetX, 0, accuracy: 0.0001)
        XCTAssertEqual(core.transform.offsetY, 0, accuracy: 0.0001)
    }

    /// A finger never holds perfectly still. Before this had a threshold, a
    /// tap that wobbled one pixel scrolled by a sub-pixel and then suppressed
    /// its own click, so the tap did nothing at all.
    func testATapThatWobblesAPixelStillClicks() {
        var core = core(.direct)

        _ = core.handle(TouchSample(id: 1, phase: .began, x: 500, y: 500, t: 0))
        let wobble = core.handle(TouchSample(id: 1, phase: .moved, x: 501, y: 500, t: 0.02))
        let lift = core.handle(TouchSample(id: 1, phase: .ended, x: 501, y: 500, t: 0.05))

        XCTAssertTrue(wobble.isEmpty, "a pixel of wobble is not a scroll")
        XCTAssertTrue(
            lift.contains { if case .press = $0 { return true } else { return false } },
            "and it must not swallow the click"
        )
    }

    /// Panning is measured against the drawn frame, not the view. On a
    /// letterboxed frame the two differ — here by 3.6x vertically — and
    /// dividing by the view made panning lag the finger badly.
    func testPanUsesTheDrawnExtentNotTheViewOnALetterboxedFrame() {
        var core = GestureCore(mode: .direct, mapping: ViewportMapping(
            viewWidth: 400, viewHeight: 800,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        ))
        core.driving = true

        core.pinch(scale: 2, centreX: 200, centreY: 400)
        let before = core.transform.offsetY
        // 225 points of drag: the whole drawn height at this aspect fit.
        core.pan(dx: 0, dy: -112.5)

        // Half the drawn height at 2x is a quarter of the frame.
        XCTAssertEqual(core.transform.offsetY - before, 0.25, accuracy: 0.001)
    }

    /// Zoom changes what a view point means, so the mapping the core hands
    /// back must already carry the new transform.
    func testTheMappingTracksTheTransformAfterAPinch() {
        var core = core(.direct)

        core.pinch(scale: 2, centreX: 500, centreY: 500)

        XCTAssertEqual(core.mapping.transform, core.transform)
    }
}
