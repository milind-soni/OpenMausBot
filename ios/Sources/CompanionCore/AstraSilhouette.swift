// The mascot's body, as geometry: the SVG path parser and the per-body cache
// that turns `AstraBodies` into something a canvas can fill.
//
// This lives in `CompanionCore` rather than beside the view that draws it for
// one reason: `swift test` builds `Sources/CompanionCore` and nothing else, so
// anything in `ios/App/` is unreachable by an automated test. The parser used
// to sit in `ios/App/AstraAvatar.swift` with a single hardcoded path to get
// right; it now has ten generated ones, and a hand-rolled character scanner
// with that much riding on it should not be the untested part of the app.
//
// `CGPath`, not SwiftUI's `Path`, because `CompanionCore` is everything the
// phone knows that is *not* a view (see `ios/Package.swift`). `AstraAvatar`
// wraps the result in `Path(cgPath)`, which is a retain, not a copy.
import CoreGraphics
import Foundation

/// The mascot silhouette, per body, as an SVG path. Absolute `M`, `C` and `Z`
/// only — which is what makes the parser below twenty lines rather than a
/// library, and what `scripts/gen-mascot-bodies.ts` is required to emit.
public enum AstraSilhouette {
    /// The desktop's face box: the square every body's `fit` is solved into
    /// and every face coordinate — the eye anchor, the mouth — is expressed
    /// in. Mirrors `AstraFaceData.faceBox`, which is the same box seen from
    /// the artwork's side.
    public static let faceBox: CGFloat = 228.541

    /// The shipped mascot, and what anything unrecognised falls back to.
    /// `AstraBodies` itself is generated and stays internal to this module;
    /// the app reaches the catalog through this type.
    public static let defaultBody: String = AstraBodies.defaultID

    /// One body, parsed and placed, with its bounds measured alongside —
    /// `boundingBoxOfPath` walks the path, so it is not a per-draw question
    /// either.
    private struct Placed {
        let path: CGPath
        let bounds: CGRect
    }

    private static var cache: [String: Placed] = [:]
    private static let lock = NSLock()

    /// The chosen body in the desktop's face box, parsed once per body.
    ///
    /// The caching is the point. These are multi-kilobyte strings and a
    /// character-at-a-time parser, and the shape each one produces never
    /// changes — but a chat list is hundreds of avatars, each redrawn on
    /// scroll, and parsing inside `Canvas` ran the scanner for every one of
    /// them on every frame. What is left per draw is the affine transform
    /// that fits the box into the rect, which is the only part that depends
    /// on where the avatar is.
    public static func inFaceBox(_ id: String?) -> CGPath {
        placed(id).path
    }

    /// The body's bounds in the face box, for the gradient's corners.
    public static func faceBoxBounds(_ id: String?) -> CGRect {
        placed(id).bounds
    }

    /// Where the face sits on this body, solved by the generator against the
    /// real expression geometry. One catalog feeds both renderers, which is
    /// what stops the desktop's placement and the phone's drifting apart.
    public static func anchor(_ id: String?) -> (x: CGFloat, y: CGFloat, scale: CGFloat) {
        AstraBodies.body(id).anchor
    }

    private static func placed(_ id: String?) -> Placed {
        let body = AstraBodies.body(id)
        lock.lock()
        defer { lock.unlock() }
        if let cached = cache[body.id] { return cached }
        // The fit is numbers rather than an SVG transform string: iOS has no
        // SVG transform parser, so the generator emits scale/tx/ty and this
        // builds the matrix directly. Scale first, then translate.
        var transform = CGAffineTransform(scaleX: body.fit.scale, y: body.fit.scale)
            .concatenating(CGAffineTransform(translationX: body.fit.tx, y: body.fit.ty))
        let parsed = parse(body.path)
        let path = parsed.copy(using: &transform) ?? parsed
        let result = Placed(path: path, bounds: path.boundingBoxOfPath)
        cache[body.id] = result
        return result
    }

    /// SVG path data, once, into a `CGPath`. Only `M`, `C` and `Z` appear in
    /// the catalog, so only those are understood; newlines are separators.
    static func parse(_ data: String) -> CGPath {
        let raw = CGMutablePath()
        var numbers: [CGFloat] = []
        var command: Character?

        func flush() {
            guard let command else { return }
            switch command {
            case "M":
                guard numbers.count >= 2 else { break }
                raw.move(to: CGPoint(x: numbers[0], y: numbers[1]))
            case "C":
                // several curves may follow one C, six numbers each
                var i = 0
                while i + 5 < numbers.count {
                    raw.addCurve(
                        to: CGPoint(x: numbers[i + 4], y: numbers[i + 5]),
                        control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                        control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3])
                    )
                    i += 6
                }
            default:
                break
            }
            numbers.removeAll()
        }

        var token = ""
        func takeNumber() {
            if !token.isEmpty, let value = Double(token) { numbers.append(CGFloat(value)) }
            token = ""
        }

        for character in data {
            if character.isNumber || character == "." || character == "e" {
                token.append(character)
            } else if character == "-" {
                // a minus starts a new number unless it is an exponent sign
                if token.hasSuffix("e") { token.append(character) } else { takeNumber(); token = "-" }
            } else if character == " " || character == "," || character == "\n" {
                takeNumber()
            } else if character == "Z" || character == "z" {
                takeNumber()
                flush()
                if !raw.isEmpty { raw.closeSubpath() }
                command = nil
            } else {
                takeNumber()
                flush()
                command = character
            }
        }
        takeNumber()
        flush()
        return raw
    }
}
