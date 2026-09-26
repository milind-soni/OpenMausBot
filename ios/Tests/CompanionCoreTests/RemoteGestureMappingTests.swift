import XCTest
@testable import CompanionCore

final class RemoteGestureMappingTests: XCTestCase {
    /// A 16:9 frame inside a square view letterboxes top and bottom; the
    /// image's own corners must land exactly on 0,0 and 1,1, because every
    /// click the person makes is measured from them.
    func testLetterboxedFrameMapsImageCornersToTheUnitSquare() {
        let mapping = ViewportMapping(
            viewWidth: 400, viewHeight: 400,
            frameWidth: 1280, frameHeight: 720,
            transform: .identity
        )
        // 400 wide at 16:9 draws 225 tall, centred, so 87.5 of bar each side.
        let topLeft = mapping.remotePoint(viewX: 0, viewY: 87.5, captured: false)
        let bottomRight = mapping.remotePoint(viewX: 400, viewY: 312.5, captured: false)

        XCTAssertEqual(topLeft?.x ?? .nan, 0, accuracy: 0.0001)
        XCTAssertEqual(topLeft?.y ?? .nan, 0, accuracy: 0.0001)
        XCTAssertEqual(bottomRight?.x ?? .nan, 1, accuracy: 0.0001)
        XCTAssertEqual(bottomRight?.y ?? .nan, 1, accuracy: 0.0001)
    }

    /// A touch in the letterbox belongs to no pixel. It is rejected while
    /// free, but clamped once a drag has captured the pointer — otherwise a
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
            transform: ViewTransform(scale: 2, offsetX: 0.25, offsetY: 0.25)
        )

        let centre = mapping.remotePoint(viewX: 200, viewY: 112.5, captured: false)
        XCTAssertEqual(centre?.x ?? .nan, 0.5, accuracy: 0.0001)
        XCTAssertEqual(centre?.y ?? .nan, 0.5, accuracy: 0.0001)
    }

    /// A degenerate view or frame size must not produce NaN coordinates that
    /// would later be posted to the remote as a click somewhere arbitrary.
    func testDegenerateSizesYieldNoPoint() {
        let zeroView = ViewportMapping(
            viewWidth: 0, viewHeight: 400, frameWidth: 1280, frameHeight: 720, transform: .identity
        )
        let zeroFrame = ViewportMapping(
            viewWidth: 400, viewHeight: 400, frameWidth: 0, frameHeight: 720, transform: .identity
        )

        XCTAssertNil(zeroView.remotePoint(viewX: 10, viewY: 10, captured: true))
        XCTAssertNil(zeroFrame.remotePoint(viewX: 10, viewY: 10, captured: true))
    }
}
