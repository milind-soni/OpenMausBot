import CoreGraphics
import XCTest

@testable import CompanionCore

/// The body catalog and the path parser that turns it into geometry.
///
/// The parser used to live in `ios/App/AstraAvatar.swift`, where `swift test`
/// could not reach it, and it had exactly one path to get right. It now has
/// ten, all of them generated — so a body that parses to nothing, or lands
/// outside the face box the face is anchored in, has to fail here rather than
/// on someone's phone.
final class AstraBodiesTests: XCTestCase {
    func testEveryBodyParsesToAClosedPathInsideTheFaceBox() {
        for id in AstraBodies.order {
            let path = AstraSilhouette.inFaceBox(id)
            XCTAssertFalse(path.isEmpty, "\(id) parsed to nothing")

            let bounds = AstraSilhouette.faceBoxBounds(id)
            XCTAssertGreaterThan(bounds.width, 0, "\(id) has no width")
            XCTAssertGreaterThan(bounds.height, 0, "\(id) has no height")
            XCTAssertGreaterThanOrEqual(bounds.minX, -1, "\(id) overflows the face box to the left")
            XCTAssertGreaterThanOrEqual(bounds.minY, -1, "\(id) overflows the face box above")
            XCTAssertLessThanOrEqual(
                bounds.maxX, AstraSilhouette.faceBox + 1, "\(id) overflows the face box to the right")
            XCTAssertLessThanOrEqual(
                bounds.maxY, AstraSilhouette.faceBox + 1, "\(id) overflows the face box below")
        }
    }

    func testUnknownBodyFallsBackToTheCursor() {
        XCTAssertEqual(AstraBodies.body("hexagram").id, "cursor")
        XCTAssertEqual(AstraBodies.body(nil).id, "cursor")
        XCTAssertEqual(AstraBodies.body("").id, "cursor")
    }

    /// An unrecognised id must reach the *drawn* geometry as the cursor too,
    /// not just as a catalog entry — the fallback is only useful if the paint
    /// path honours it.
    func testAnUnknownBodyDrawsTheCursor() {
        XCTAssertEqual(
            AstraSilhouette.faceBoxBounds("hexagram"), AstraSilhouette.faceBoxBounds("cursor"))
        XCTAssertEqual(AstraSilhouette.faceBoxBounds(nil), AstraSilhouette.faceBoxBounds("cursor"))

        let unknown = AstraSilhouette.anchor("hexagram")
        let cursor = AstraSilhouette.anchor("cursor")
        XCTAssertEqual(unknown.x, cursor.x)
        XCTAssertEqual(unknown.y, cursor.y)
        XCTAssertEqual(unknown.scale, cursor.scale)
    }

    func testEveryAnchorPlacesAFaceInsideItsBody() {
        for id in AstraBodies.order {
            let anchor = AstraSilhouette.anchor(id)
            XCTAssertGreaterThan(anchor.scale, 0, "\(id) has no face")
            XCTAssertLessThanOrEqual(anchor.scale, 1, "\(id) inflates the face")

            let bounds = AstraSilhouette.faceBoxBounds(id)
            XCTAssertTrue(
                bounds.insetBy(dx: -1, dy: -1).contains(CGPoint(x: anchor.x, y: anchor.y)),
                "\(id) anchors its face outside its own body")
        }
    }

    /// The parser is a character scanner over `M`/`C`/`Z` with newlines as
    /// separators, and it is now responsible for ten paths rather than one.
    func testTheParserUnderstandsTheCatalogsPathGrammar() {
        // A unit square drawn with degenerate curves: four `C` segments in one
        // command, the form the generated catalog actually emits.
        let square = AstraSilhouette.parse(
            """
            M0 0 C0 0 10 0 10 0 C10 0 10 10 10 10
            C10 10 0 10 0 10 C0 10 0 0 0 0Z
            """)
        XCTAssertFalse(square.isEmpty)
        XCTAssertEqual(square.boundingBoxOfPath, CGRect(x: 0, y: 0, width: 10, height: 10))

        // Negative numbers and exponents both appear in the cursor path.
        let negative = AstraSilhouette.parse("M-2.5 0 C-2.5 0 1e1 -5 10 -5Z")
        XCTAssertEqual(negative.boundingBoxOfPath.minX, -2.5, accuracy: 0.0001)
        XCTAssertEqual(negative.boundingBoxOfPath.minY, -5, accuracy: 0.0001)
    }

    /// The cache exists because a chat list redraws hundreds of avatars per
    /// frame and the parser is a character scanner over a four-kilobyte
    /// string. Identical `CGPath` instances prove the second call did not
    /// re-parse; distinct instances across ids prove it is per body.
    func testEachBodyIsParsedOnceAndCachedSeparately() {
        for id in AstraBodies.order {
            XCTAssertTrue(
                AstraSilhouette.inFaceBox(id) === AstraSilhouette.inFaceBox(id),
                "\(id) was parsed twice")
        }
        XCTAssertFalse(AstraSilhouette.inFaceBox("cursor") === AstraSilhouette.inFaceBox("star"))
    }
}
