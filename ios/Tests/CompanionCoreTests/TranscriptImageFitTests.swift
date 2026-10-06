import XCTest
@testable import CompanionCore

final class TranscriptImageFitTests: XCTestCase {
    /// The bubble on a 393-point iPhone: 16-point margins, the 56-point gutter
    /// on the far side, and the bubble's own 15-point padding.
    private let phone = 393.0 - 32 - 56 - 30

    func testAWideScreenshotFitsTheBubbleInsteadOfWideningIt() throws {
        // 2400×260 is the shape that pushed the chat off both sides of the
        // screen: at the old 168-point height it asked for ~1550 points.
        let aspect = try XCTUnwrap(TranscriptImageFit.cardAspect(width: 2_400, height: 260))
        XCTAssertEqual(aspect, 4)
        let card = TranscriptImageFit.cardSize(aspect: aspect, available: phone)
        XCTAssertEqual(card.width, phone)
        XCTAssertEqual(card.height, phone / 4, accuracy: 0.001)

        let banner = try XCTUnwrap(TranscriptImageFit.cardAspect(width: 1_600, height: 240))
        XCTAssertEqual(TranscriptImageFit.cardSize(aspect: banner, available: phone).width, phone)
    }

    func testOrdinaryShapesKeepTheirOwnAspect() throws {
        let wide = try XCTUnwrap(TranscriptImageFit.cardAspect(width: 1_920, height: 1_080))
        XCTAssertEqual(wide, 16.0 / 9.0, accuracy: 0.0001)
        let card = TranscriptImageFit.cardSize(aspect: wide, available: phone)
        XCTAssertEqual(card.width, phone)
        XCTAssertEqual(card.height, phone * 9 / 16, accuracy: 0.001)

        let square = try XCTUnwrap(TranscriptImageFit.cardAspect(width: 1_024, height: 1_024))
        XCTAssertEqual(TranscriptImageFit.cardSize(aspect: square, available: phone).height, phone)
    }

    func testTallImagesStopAtTheHeightCapAndNarrow() throws {
        for (width, height) in [(600.0, 1_300.0), (1_179.0, 2_556.0)] {
            let aspect = try XCTUnwrap(TranscriptImageFit.cardAspect(width: width, height: height))
            XCTAssertEqual(aspect, 0.75, "\(width)×\(height) is drawn whole inside a 3:4 card")
            let card = TranscriptImageFit.cardSize(aspect: aspect, available: phone)
            XCTAssertEqual(card.height, TranscriptImageFit.maximumHeight, accuracy: 0.001)
            XCTAssertEqual(card.width, 225, accuracy: 0.001)
        }
    }

    func testNoCardIsWiderThanItsBubbleOrTheIPadColumn() throws {
        for (width, height) in [(2_400.0, 260.0), (1_920.0, 1_080.0), (1_024.0, 1_024.0), (600.0, 1_300.0)] {
            let aspect = try XCTUnwrap(TranscriptImageFit.cardAspect(width: width, height: height))
            for available in [0.0, 120.0, phone, 700.0, .infinity] {
                let card = TranscriptImageFit.cardSize(aspect: aspect, available: available)
                XCTAssertLessThanOrEqual(card.width, min(available, TranscriptImageFit.maximumWidth))
                XCTAssertLessThanOrEqual(card.height, TranscriptImageFit.maximumHeight + 0.001)
            }
        }
    }

    func testASizeWithoutAShapeHasNoAspect() {
        XCTAssertNil(TranscriptImageFit.cardAspect(width: 0, height: 100))
        XCTAssertNil(TranscriptImageFit.cardAspect(width: 100, height: 0))
        XCTAssertNil(TranscriptImageFit.cardAspect(width: .nan, height: 100))
        XCTAssertNil(TranscriptImageFit.cardAspect(width: .infinity, height: 100))
    }
}
