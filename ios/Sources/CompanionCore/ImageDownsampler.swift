// Decoding an image once, at the size it is drawn.
//
// `UIImage(data:)` inside a SwiftUI `body` decodes again on every render: a
// new `UIImage` is a new image to SwiftUI, so the bytes are decoded and
// uploaded again even when nothing about the picture changed. While a fleet
// streams that is a dozen or more renders a second, and a composer chip
// drawing a 12 MP photo into 34 points held a 48 MB bitmap to do it.
//
// The views decode here instead, once per new input (a new frame, a new
// attachment, a new avatar), off the main actor, and keep the result. When
// the drawn size is smaller than the source, ImageIO produces a thumbnail
// at that size directly (a JPEG is decoded at a reduced scale), so the
// full-resolution bitmap is never what is kept.
//
// It lives in CompanionCore rather than the app because ImageIO is on macOS
// too, so `swift test` covers the size budgets and the cache without a
// simulator — the same reason `AnimatedImageDecoder` lives here.
import CoreGraphics
import Foundation
import ImageIO

/// A decoded bitmap that can be handed across actors. `CGImage` is immutable
/// and safe to share between threads; the wrapper only says so to the
/// compiler, as `Task.detached` requires a `Sendable` result.
public struct DecodedImage: @unchecked Sendable {
    public let cgImage: CGImage

    public init(_ cgImage: CGImage) {
        self.cgImage = cgImage
    }

    public var pixelWidth: Int { cgImage.width }
    public var pixelHeight: Int { cgImage.height }

    /// What the bitmap costs in memory once decoded.
    public var byteCount: Int { cgImage.bytesPerRow * cgImage.height }
}

public enum ImageDownsampler {
    /// Decode `data` with its longer side at most `maxPixelSize`, or at its
    /// own size when that is nil. The pixels are decoded now, on the calling
    /// thread, rather than lazily when Core Animation first draws them on the
    /// main thread. EXIF orientation is applied, as `UIImage(data:)` would.
    public static func decode(_ data: Data, maxPixelSize: Int? = nil) -> DecodedImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else { return nil }
        let budget: Int
        if let maxPixelSize {
            budget = max(1, maxPixelSize)
        } else if let size = pixelSize(of: source) {
            budget = max(size.width, size.height)
        } else {
            return count(fullSize(source))
        }
        return count(thumbnail(source, maxPixelSize: budget))
    }

    /// Decode `data` for a square drawn aspect-fill (`scaledToFill`) at
    /// `side` pixels: the shorter side covers the square, so the crop is as
    /// sharp as a full-resolution decode would draw it.
    public static func decode(_ data: Data, fillingSquare side: Int) -> DecodedImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else { return nil }
        guard let size = pixelSize(of: source) else { return count(fullSize(source)) }
        let budget = fillBudget(side: side, width: size.width, height: size.height)
        return count(thumbnail(source, maxPixelSize: budget))
    }

    /// Decode `data` for a column `width` pixels wide, drawn aspect-fit
    /// (`scaledToFit`): the image comes out `width` across, or at its own
    /// size when it is narrower. An EXIF quarter turn is counted, since it
    /// swaps which side is drawn across.
    public static func decode(_ data: Data, fittingWidth width: Int) -> DecodedImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0 else { return nil }
        guard let size = pixelSize(of: source) else { return count(fullSize(source)) }
        let across = turnsQuarter(source) ? size.height : size.width
        let budget = fitBudget(width: width, across: across, longer: max(size.width, size.height))
        return count(thumbnail(source, maxPixelSize: budget))
    }

    /// Base64 as it arrives on the wire (screen and browser frames), decoded
    /// at full size. Nil when the base64 or the image is not valid, which is
    /// exactly when `Data(base64Encoded:).flatMap(UIImage.init(data:))` was.
    public static func decode(base64: String) -> DecodedImage? {
        guard let data = Data(base64Encoded: base64) else { return nil }
        return decode(data)
    }

    /// The longer-side budget that lets a `width` × `height` image cover a
    /// `side` square without being scaled up, and never more than the image
    /// itself has: ImageIO does not upscale, and asking it to would only
    /// cost a full-size decode.
    static func fillBudget(side: Int, width: Int, height: Int) -> Int {
        let side = max(1, side)
        let longer = max(width, height), shorter = min(width, height)
        guard shorter > 0 else { return side }
        let needed = (Double(side) * Double(longer) / Double(shorter)).rounded(.up)
        return min(longer, max(side, Int(needed)))
    }

    /// The longer-side budget that draws an image `across` pixels wide at
    /// `width`, and never more than the image itself has.
    static func fitBudget(width: Int, across: Int, longer: Int) -> Int {
        let width = max(1, width)
        guard across > 0, longer > 0 else { return width }
        let needed = (Double(width) * Double(longer) / Double(across)).rounded(.up)
        return min(longer, max(1, Int(needed)))
    }

    /// EXIF orientations 5–8 turn the image a quarter, so its stored width
    /// is drawn as its height.
    private static func turnsQuarter(_ source: CGImageSource) -> Bool {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return (5...8).contains(orientation)
    }

    private static func pixelSize(of source: CGImageSource) -> (width: Int, height: Int)? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0 else { return nil }
        return (width, height)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private static func fullSize(_ source: CGImageSource) -> CGImage? {
        let options: [CFString: Any] = [kCGImageSourceShouldCacheImmediately: true]
        return CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    }

    private static func count(_ image: CGImage?) -> DecodedImage? {
        #if DEBUG
        decodes.increment()
        #endif
        return image.map(DecodedImage.init)
    }

    #if DEBUG
    /// Every decode this process has run, successful or not. Debug builds
    /// only: it is how a test or a measuring build tells "decoded once per
    /// new image" from "decoded on every render".
    public static var decodeCount: Int { decodes.value }

    private static let decodes = DecodeCounter()

    private final class DecodeCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }

        func increment() {
            lock.lock()
            count += 1
            lock.unlock()
        }
    }
    #endif
}

/// Decoded images shared by every view that draws the same input at the same
/// size: a bot's face appears in its Home row, the chat header, a room and
/// the Walkie sheet at once, and each used to decode its own copy.
///
/// Bounded by count and by decoded bytes (an `NSCache`, so it also empties
/// under memory pressure). Callers asking for the same key at the same time
/// share one decode rather than racing to make two.
public final class DecodedImageCache<Value>: @unchecked Sendable {
    public struct Stats: Equatable, Sendable {
        /// Requests answered from the cache, or by joining a decode in flight.
        public var hits = 0
        /// Decodes this cache started.
        public var decodes = 0
    }

    private final class Entry: @unchecked Sendable {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    private let storage = NSCache<NSString, Entry>()
    private let cost: (Value) -> Int
    private let lock = NSLock()
    private var inFlight: [String: Task<Entry?, Never>] = [:]
    private var counts = Stats()
    /// Bumped by `removeAll`, so a decode that was already running when the
    /// cache was emptied does not put its result back.
    private var generation = 0

    /// - Parameter cost: the bytes one value holds, counted against
    ///   `totalCostLimit`.
    public init(countLimit: Int, totalCostLimit: Int, cost: @escaping (Value) -> Int) {
        storage.countLimit = countLimit
        storage.totalCostLimit = totalCostLimit
        self.cost = cost
    }

    public var stats: Stats {
        withLock { counts }
    }

    /// The value already decoded for `key`, without starting a decode.
    public func cached(_ key: String) -> Value? {
        storage.object(forKey: key as NSString)?.value
    }

    /// The value for `key`, decoding it off the calling actor the first time
    /// and at most once however many callers ask together. `key` must name
    /// the input and the size it is decoded at, never anything that changes
    /// per render. A nil decode is not cached, so a failed fetch can retry.
    public func value(for key: String, decode: @escaping @Sendable () -> Value?) async -> Value? {
        // One locked step: `finish` stores a result and leaves `inFlight`
        // under the same lock, so a request can never fall between the two
        // and start a second decode of something just decoded.
        let lookup: Lookup = withLock {
            if let hit = storage.object(forKey: key as NSString) {
                counts.hits += 1
                return .stored(hit)
            }
            if let pending = inFlight[key] {
                counts.hits += 1
                return .decoding(pending)
            }
            counts.decodes += 1
            let generation = self.generation
            // Registered before the lock is released, and the task needs the
            // lock to finish, so it can never finish before it is in flight.
            let started = Task<Entry?, Never>.detached(priority: .userInitiated) {
                let entry = decode().map(Entry.init)
                self.finish(key, entry, generation: generation)
                return entry
            }
            inFlight[key] = started
            return .decoding(started)
        }
        switch lookup {
        case let .stored(entry): return entry.value
        case let .decoding(task): return await task.value?.value
        }
    }

    private enum Lookup {
        case stored(Entry)
        case decoding(Task<Entry?, Never>)
    }

    public func removeAll() {
        withLock {
            generation += 1
            inFlight.removeAll()
        }
        storage.removeAllObjects()
    }

    private func finish(_ key: String, _ entry: Entry?, generation: Int) {
        withLock {
            guard generation == self.generation else { return }
            inFlight[key] = nil
            if let entry {
                storage.setObject(entry, forKey: key as NSString, cost: cost(entry.value))
            }
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}
