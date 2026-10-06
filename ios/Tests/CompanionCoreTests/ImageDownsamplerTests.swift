import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CompanionCore

/// The fixtures are synthesised rather than checked in, as in
/// AnimatedImageTests: building them is how the tests choose their sizes.
final class ImageDownsamplerTests: XCTestCase {
    // MARK: - sizes

    func testFullSizeDecodeKeepsTheSourceSize() throws {
        let decoded = try XCTUnwrap(ImageDownsampler.decode(encode(width: 64, height: 32, as: .png)))

        XCTAssertEqual(decoded.pixelWidth, 64)
        XCTAssertEqual(decoded.pixelHeight, 32)
    }

    func testMaxPixelSizeBoundsTheLongerSide() throws {
        let decoded = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 1_600, height: 1_200, as: .jpeg), maxPixelSize: 200
        ))

        XCTAssertEqual(decoded.pixelWidth, 200)
        XCTAssertEqual(decoded.pixelHeight, 150)
    }

    func testFillingASquareCoversItWithTheShorterSide() throws {
        // A 4:3 photo drawn scaledToFill into 34 pt at 3x: the shorter side
        // must reach 102 px or the crop is upscaled and soft.
        let decoded = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 1_600, height: 1_200, as: .jpeg), fillingSquare: 102
        ))

        XCTAssertEqual(decoded.pixelHeight, 102)
        XCTAssertEqual(decoded.pixelWidth, 136)
    }

    func testFillBudgetNeverAsksForMoreThanTheSourceHas() {
        XCTAssertEqual(ImageDownsampler.fillBudget(side: 500, width: 300, height: 200), 300)
        XCTAssertEqual(ImageDownsampler.fillBudget(side: 100, width: 1_000, height: 1_000), 100)
        XCTAssertEqual(ImageDownsampler.fillBudget(side: 100, width: 400, height: 1_200), 300)
        XCTAssertEqual(ImageDownsampler.fillBudget(side: 0, width: 400, height: 300), 2)
    }

    func testFittingAWidthDrawsTheImageThatWideAndKeepsItsShape() throws {
        // A desktop frame drawn across a 361 pt column at 3x.
        let wide = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 2_560, height: 1_600, as: .png), fittingWidth: 1_083
        ))
        XCTAssertEqual(wide.pixelWidth, 1_083)
        XCTAssertEqual(wide.pixelHeight, 677, accuracy: 1)

        // A phone screenshot is taller than wide: its height may exceed the
        // column width, its width must not.
        let tall = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 1_170, height: 2_532, as: .png), fittingWidth: 390
        ))
        XCTAssertEqual(tall.pixelWidth, 390, accuracy: 1)
        XCTAssertEqual(tall.pixelHeight, 844, accuracy: 1)
    }

    func testFittingAWidthNeverScalesUpOrIgnoresAQuarterTurn() throws {
        let small = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 40, height: 20, as: .png), fittingWidth: 300
        ))
        XCTAssertEqual(small.pixelWidth, 40)
        XCTAssertEqual(small.pixelHeight, 20)

        // Stored 80 × 40 and turned a quarter: drawn 40 wide, 80 tall.
        let turned = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 80, height: 40, as: .jpeg, orientation: 6), fittingWidth: 20
        ))
        XCTAssertEqual(turned.pixelWidth, 20)
        XCTAssertEqual(turned.pixelHeight, 40)
    }

    func testFitBudgetIsTheLongerSideAtTheDrawnWidth() {
        XCTAssertEqual(ImageDownsampler.fitBudget(width: 1_000, across: 2_000, longer: 2_000), 1_000)
        XCTAssertEqual(ImageDownsampler.fitBudget(width: 390, across: 1_170, longer: 2_532), 844)
        XCTAssertEqual(ImageDownsampler.fitBudget(width: 5_000, across: 400, longer: 800), 800)
        XCTAssertEqual(ImageDownsampler.fitBudget(width: 0, across: 0, longer: 0), 1)
    }

    func testSmallerSourceIsNotScaledUp() throws {
        let decoded = try XCTUnwrap(ImageDownsampler.decode(
            encode(width: 40, height: 20, as: .png), fillingSquare: 300
        ))

        XCTAssertEqual(decoded.pixelWidth, 40)
        XCTAssertEqual(decoded.pixelHeight, 20)
    }

    func testExifOrientationIsAppliedAsUIImageWould() throws {
        let rotated = encode(width: 8, height: 4, as: .jpeg, orientation: 6)

        let full = try XCTUnwrap(ImageDownsampler.decode(rotated))
        XCTAssertEqual(full.pixelWidth, 4)
        XCTAssertEqual(full.pixelHeight, 8)

        let filled = try XCTUnwrap(ImageDownsampler.decode(rotated, fillingSquare: 2))
        XCTAssertLessThan(filled.pixelWidth, filled.pixelHeight)
    }

    func testGarbageDecodesAsNilRatherThanCrashing() {
        XCTAssertNil(ImageDownsampler.decode(Data("not an image".utf8)))
        XCTAssertNil(ImageDownsampler.decode(Data()))
        XCTAssertNil(ImageDownsampler.decode(Data("not an image".utf8), fillingSquare: 34))
        XCTAssertNil(ImageDownsampler.decode(base64: "%%% not base64 %%%"))
    }

    func testBase64FramesDecodeAtFullSize() throws {
        let frame = encode(width: 32, height: 18, as: .png).base64EncodedString()

        let decoded = try XCTUnwrap(ImageDownsampler.decode(base64: frame))

        XCTAssertEqual(decoded.pixelWidth, 32)
        XCTAssertEqual(decoded.pixelHeight, 18)
    }

    /// The composer chip's case: a 12 MP camera photo drawn at 34 pt.
    /// Decoded at full size it is a 4032 × 3024 bitmap; downsampled it is
    /// a thumbnail just large enough to fill the chip at 3x.
    func testTwelveMegapixelPhotoBecomesAThumbnailNotAFullBitmap() throws {
        let photo = encode(width: 4_032, height: 3_024, as: .jpeg)

        let full = try XCTUnwrap(ImageDownsampler.decode(photo))
        let chip = try XCTUnwrap(ImageDownsampler.decode(photo, fillingSquare: 34 * 3))

        XCTAssertGreaterThanOrEqual(full.byteCount, 4_032 * 3_024 * 4)
        XCTAssertEqual(chip.pixelHeight, 102)
        XCTAssertEqual(chip.pixelWidth, 136)
        XCTAssertLessThanOrEqual(chip.byteCount, 136 * 102 * 4 + 64 * 102)
        XCTAssertLessThan(chip.byteCount * 500, full.byteCount)
    }

    // MARK: - decoded once

    func testTheSameInputIsDecodedOnceHoweverOftenItIsAskedFor() async throws {
        let photo = encode(width: 800, height: 600, as: .jpeg)
        let cache = DecodedImageCache<DecodedImage>(countLimit: 8, totalCostLimit: 8 << 20) { $0.byteCount }
        let decodes = Counter()

        for _ in 0..<100 {
            let image = await cache.value(for: "avatar-a|\(photo.count)|156") {
                decodes.increment()
                return ImageDownsampler.decode(photo, fillingSquare: 156)
            }
            XCTAssertEqual(image?.pixelHeight, 156)
        }

        XCTAssertEqual(decodes.value, 1)
        XCTAssertEqual(cache.stats, .init(hits: 99, decodes: 1))
    }

    func testADifferentInputOrSizeIsANewDecode() async throws {
        let photo = encode(width: 800, height: 600, as: .jpeg)
        let other = encode(width: 600, height: 800, as: .jpeg)
        let cache = DecodedImageCache<DecodedImage>(countLimit: 8, totalCostLimit: 8 << 20) { $0.byteCount }

        let first = await cache.value(for: "a|156") { ImageDownsampler.decode(photo, fillingSquare: 156) }
        let otherInput = await cache.value(for: "b|156") { ImageDownsampler.decode(other, fillingSquare: 156) }
        let otherSize = await cache.value(for: "a|78") { ImageDownsampler.decode(photo, fillingSquare: 78) }
        let again = await cache.value(for: "a|156") { ImageDownsampler.decode(photo, fillingSquare: 156) }

        XCTAssertEqual(first?.pixelWidth, 208)
        XCTAssertEqual(otherInput?.pixelWidth, 156)
        XCTAssertEqual(otherInput?.pixelHeight, 208)
        XCTAssertEqual(otherSize?.pixelHeight, 78)
        XCTAssertTrue(again?.cgImage === first?.cgImage)
        XCTAssertEqual(cache.stats, .init(hits: 1, decodes: 3))
    }

    func testFacesAppearingTogetherShareOneDecode() async {
        let cache = DecodedImageCache<Int>(countLimit: 8, totalCostLimit: 1 << 20) { _ in 1 }
        let decodes = Counter()

        let results = await withTaskGroup(of: Int?.self) { group in
            for _ in 0..<20 {
                group.addTask {
                    await cache.value(for: "same") {
                        decodes.increment()
                        Thread.sleep(forTimeInterval: 0.05)
                        return 7
                    }
                }
            }
            return await group.reduce(into: [Int?]()) { $0.append($1) }
        }

        XCTAssertEqual(results, Array(repeating: 7, count: 20))
        XCTAssertEqual(decodes.value, 1)
        XCTAssertEqual(cache.stats.decodes, 1)
    }

    func testAFailedDecodeIsNotRememberedSoItCanBeRetried() async {
        let cache = DecodedImageCache<Int>(countLimit: 8, totalCostLimit: 1 << 20) { _ in 1 }

        let failed = await cache.value(for: "k") { nil }
        let retried = await cache.value(for: "k") { 3 }

        XCTAssertNil(failed)
        XCTAssertEqual(retried, 3)
        XCTAssertEqual(cache.stats.decodes, 2)
    }

    func testRemoveAllForgetsWhatWasDecoded() async {
        let cache = DecodedImageCache<Int>(countLimit: 8, totalCostLimit: 1 << 20) { _ in 1 }

        _ = await cache.value(for: "k") { 1 }
        XCTAssertEqual(cache.cached("k"), 1)
        cache.removeAll()
        XCTAssertNil(cache.cached("k"))
        let again = await cache.value(for: "k") { 2 }

        XCTAssertEqual(again, 2)
        XCTAssertEqual(cache.stats.decodes, 2)
    }

    #if DEBUG
    /// The process-wide counter the measuring build reads: a hundred asks for
    /// one avatar through the cache are one ImageIO decode, not a hundred.
    func testTheDebugCounterSeesOneDecodeForAHundredAsks() async {
        let photo = encode(width: 400, height: 300, as: .jpeg)
        let cache = DecodedImageCache<DecodedImage>(countLimit: 8, totalCostLimit: 8 << 20) { $0.byteCount }
        let before = ImageDownsampler.decodeCount

        for _ in 0..<100 {
            _ = await cache.value(for: "counted|\(photo.count)|52") {
                ImageDownsampler.decode(photo, fillingSquare: 52)
            }
        }

        XCTAssertEqual(ImageDownsampler.decodeCount - before, 1)
    }
    #endif

    // MARK: - fixture

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
        func increment() { lock.lock(); count += 1; lock.unlock() }
    }

    private func encode(width: Int, height: Int, as type: UTType, orientation: Int? = nil) -> Data {
        let data = NSMutableData()
        guard let image = gradient(width: width, height: height),
              let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else {
            XCTFail("could not build a \(width)x\(height) fixture")
            return Data()
        }
        var properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.8]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func gradient(width: Int, height: Int) -> CGImage? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else { return nil }
        let colors = [CGColor(red: 1, green: 0.4, blue: 0, alpha: 1), CGColor(red: 0, green: 0.3, blue: 1, alpha: 1)]
        guard let fill = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: nil) else {
            return nil
        }
        context.drawLinearGradient(fill, start: .zero, end: CGPoint(x: width, y: height), options: [])
        return context.makeImage()
    }
}
