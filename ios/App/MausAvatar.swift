// The bot's face — the same silhouette the desktop draws.
//
// The desktop renders Blob Studio's "cursor" mascot from an SVG path
// (`src/components/CursorAvatar.tsx`, `SHAPE.body`). The phone used to draw a
// rounded blob instead, which meant a bot you know by its shape looked like a
// different bot on the two screens. This is that path, verbatim.
//
// Verbatim is the point: the alternative is redrawing it by eye, which starts
// close and drifts every time either side is touched. Copied here rather than
// generated at build time because the phone app has no build step that could
// read the web source, and a 4KB string is a cheap thing to keep in sync by
// hand — it has changed once in the life of this project.
//
// What is NOT copied: the desktop's 25 expressions, blinking, gaze tracking
// and motion. A 28-point avatar in a list is a silhouette and two eyes; the
// animation engine is 1,600 lines and would show up as nothing at this size.
import SwiftUI

enum MausPalette {
    /// src/lib/mascot.ts — MAUS_COLORS
    private static let hex: [String: String] = [
        "green": "#009957",
        "blue": "#377FE6",
        "red": "#D94B52",
        "orange": "#E78531",
        "purple": "#8057C8",
        "cyan": "#0EA5C6",
        "pink": "#D84F8B",
        "yellow": "#D8A729",
        "teal": "#01A492",
        "coral": "#E5634E",
    ]

    static func color(_ name: String) -> Color {
        Color(hex: hex[name] ?? "#8E8E93")
    }

}

/// The mascot silhouette, as an SVG path. Absolute `M`, `C` and `Z` only —
/// which is what makes the parser below twenty lines rather than a library.
enum MausSilhouette {
    static let path =
        """
        M0 0 C1.12815992 0.94880479 2.25705591 1.89673511 3.38671875 2.84375 C5.57657936 4.68528228
        7.75793952 6.53624249 9.93359375 8.39453125 C13.5602214 11.48647103 17.25022962 14.49819427
        20.9453125 17.5078125 C25.41301487 21.15281776 29.86103386 24.8215994 34.31054688 28.48876953
        C38.00933931 31.5370903 41.70951059 34.58367973 45.4140625 37.625 C52.50037463 43.44570076
        59.55669812 49.29508834 66.54003906 55.23901367 C70.43289872 58.54377434 74.40406577 61.73568847
        78.40625 64.90625 C82.05401433 67.85083084 85.6145398 70.89451533 89.18359375 73.93359375
        C92.41424312 76.67774533 95.67698054 79.36747809 99 82 C103.47931906 85.54855146 107.83340036
        89.22936876 112.18359375 92.93359375 C115.41424312 95.67774533 118.67698054 98.36747809 122 101
        C125.9014198 104.09073517 129.71091352 107.27378506 133.5 110.5 C137.99002543 114.32092614
        142.53350963 118.0537239 147.15234375 121.71875 C156.74255328 129.40144186 166.1812645
        137.27326897 175.53833008 145.23754883 C179.4317456 148.54281661 183.40347641 151.73522157
        187.40625 154.90625 C191.05401433 157.85083084 194.6145398 160.89451533 198.18359375
        163.93359375 C201.41424312 166.67774533 204.67698054 169.36747809 208 172 C236.43637507
        194.63776677 236.43637507 194.63776677 238.27050781 209.13867188 C239.19944445 221.27193361
        237.57124038 231.13444436 230 241 C223.66050278 247.82715086 215.75482398 254.47140646
        206.04764748 255.13307858 C205.3615811 255.13693349 204.67551472 255.1407884 203.96865845
        255.14476013 C203.17563324 255.15165863 202.38260803 255.15855713 201.56555176 255.16566467
        C200.27360901 255.16958473 200.27360901 255.16958473 198.95556641 255.17358398 C198.04112762
        255.180271 197.12668884 255.18695801 196.18453979 255.19384766 C194.19843498 255.20789156
        192.21231409 255.21978771 190.22618484 255.22979546 C187.07149762 255.24625057 183.91692738
        255.26949556 180.76229858 255.29469299 C171.79227585 255.36530712 162.82220292 255.42526708
        153.85205078 255.47680664 C148.36195434 255.5088283 142.87198905 255.55017011 137.38199997
        255.59700203 C135.30028042 255.61289593 133.21853066 255.62527474 131.13676834 255.63390923
        C104.46972494 255.74602279 80.75351522 259.19455182 60.52978516 278.41845703 C55.75259196
        283.35727885 51.81217213 289.04473423 47.77441406 294.5859375 C44.62107661 298.87600364
        41.36381878 303.08685058 38.125 307.3125 C32.82026548 314.26649347 27.55386673 321.24815866
        22.3125 328.25 C21.07690581 329.89589556 19.84122979 331.5417297 18.60546875 333.1875
        C16.22002164 336.36552908 13.84996009 339.55428087 11.48828125 342.75 C3.0450311 354.10095576
        -5.25712203 365.22607871 -20 368 C-33.42903027 368.85957067 -44.2929604 367.90032788 -55
        358.9140625 C-63.51513963 350.76480778 -67.79688328 340.99527428 -68.37686157 329.29350281
        C-68.43541887 328.1487851 -68.49397617 327.00406738 -68.55430794 325.82466125 C-68.61453573
        324.57243271 -68.67476353 323.32020416 -68.73681641 322.0300293 C-68.80423726 320.68369989
        -68.87198477 319.33738681 -68.94003105 317.99108887 C-69.12569162 314.29881586 -69.30666938
        310.60632592 -69.48688698 306.91378379 C-69.68142908 302.94481208 -69.88036562 298.97606035
        -70.07873535 295.00727844 C-70.55465828 285.46711948 -71.02377004 275.92663022 -71.49235249
        266.3861084 C-71.71278092 261.90166682 -71.93398876 257.41726373 -72.1552124 252.93286133
        C-72.22122149 251.59460763 -72.22122149 251.59460763 -72.28856409 250.2293185 C-72.37783973
        248.41936974 -72.46711776 246.6094211 -72.55639815 244.79947257 C-72.7821203 240.22326204
        -73.00777832 235.64704836 -73.23336792 231.0708313 C-73.2783997 230.15734865 -73.32343148
        229.24386601 -73.36982787 228.30270207 C-73.64581049 222.70253299 -73.92113412 217.10233189
        -74.19602597 211.50210917 C-75.35713101 187.85146938 -76.54638525 164.20245932 -77.76320994
        140.55462319 C-78.3174362 129.77404232 -78.86176258 118.9929594 -79.40472984 108.2118063
        C-79.83986282 99.58021501 -80.28322749 90.94912395 -80.73695588 82.31848997 C-81.04621068
        76.42094211 -81.34513355 70.52292566 -81.63612723 64.62444884 C-81.8031421 61.24551841
        -81.97612174 57.86718776 -82.15861511 54.48903847 C-84.29931862 14.73242483 -84.29931862
        14.73242483 -72.03125 -1.625 C-50.89854752 -24.96559677 -21.34867451 -18.24899383 0 0 Z
        """

    /// The parsed silhouette, in its own coordinate space. Parsed once.
    ///
    /// This is a four-kilobyte string and a character-at-a-time parser, and
    /// the shape it produces never changes — but a chat list is hundreds of
    /// avatars, each redrawn on scroll, and running the parser inside `Canvas`
    /// ran it for every one of them on every frame. `static let` is lazy and
    /// evaluated exactly once, so what is left per draw is the affine
    /// transform below, which is the only part that depends on the rect.
    private static let parsed: Path = parse()

    /// Its bounding box, cached alongside — `boundingRect` walks the path.
    private static let parsedBounds: CGRect = parsed.boundingRect

    /// The silhouette in the desktop's face box: artwork → `translate(210,80)`
    /// → `scale(0.593899)` → `translate(-56.5564,-37.6751)`, exactly the
    /// transforms the desktop's SVG applies. Every face coordinate — the eye
    /// anchor, the mouth — is expressed in this box, so this has to be the
    /// same box or the face lands in the wrong place.
    static let inFaceBox: Path = parsed.applying(
        CGAffineTransform(translationX: 210, y: 80)
            .concatenating(CGAffineTransform(scaleX: 0.593899, y: 0.593899))
            .concatenating(CGAffineTransform(translationX: -56.5564, y: -37.6751))
    )

    /// Its bounds in the face box, for the gradient.
    static let faceBoxBounds: CGRect = inFaceBox.boundingRect

    /// The face box with the desktop's 15-unit margin around it (its viewBox
    /// is `-15 -15 258.541 258.541`) — room for the body to bob and sway.
    static let margin: CGFloat = 15

    /// The transform that puts the margined face box into `rect`.
    static func fit(_ rect: CGRect) -> CGAffineTransform {
        let side = MausFaceData.faceBox + margin * 2
        let k = min(rect.width, rect.height) / side
        return CGAffineTransform(translationX: margin, y: margin)
            .concatenating(CGAffineTransform(scaleX: k, y: k))
            .concatenating(CGAffineTransform(
                translationX: rect.minX + (rect.width - side * k) / 2,
                y: rect.minY + (rect.height - side * k) / 2
            ))
    }

    /// The silhouette normalised into `rect`, the same framing as the desktop.
    static func path(in rect: CGRect) -> Path {
        inFaceBox.applying(fit(rect))
    }

    /// The SVG path data, once, into a `Path`. Only `M`, `C` and `Z` appear in
    /// the artwork, so only those are understood.
    private static func parse() -> Path {
        var raw = Path()
        var numbers: [CGFloat] = []
        var command: Character?
        var current = CGPoint.zero

        func flush() {
            guard let command else { return }
            switch command {
            case "M":
                guard numbers.count >= 2 else { break }
                current = CGPoint(x: numbers[0], y: numbers[1])
                raw.move(to: current)
            case "C":
                // several curves may follow one C, six numbers each
                var i = 0
                while i + 5 < numbers.count {
                    let to = CGPoint(x: numbers[i + 4], y: numbers[i + 5])
                    raw.addCurve(
                        to: to,
                        control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                        control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3])
                    )
                    current = to
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

        for character in path {
            if character.isNumber || character == "." || character == "e" {
                token.append(character)
            } else if character == "-" {
                // a minus starts a new number unless it is an exponent sign
                if token.hasSuffix("e") { token.append(character) } else { takeNumber(); token = "-" }
            } else if character == " " || character == "," || character == "\n" {
                takeNumber()
            } else if character == "Z" || character == "z" {
                takeNumber(); flush(); raw.closeSubpath(); command = nil
            } else {
                takeNumber(); flush(); command = character
            }
        }
        takeNumber()
        flush()
        return raw
    }
}

/// A bot, at whatever size the row needs — and alive, exactly the way it is
/// on the desktop. `MausFaceEngine` is a port of the frame loop in
/// `MausMascotios/MausAvatar.tsx`: a state picks a pool of expressions and
/// drifts through them on its cadence, a spring morphs the eyes and mouth
/// between them, it blinks on its own rhythm, and the body bobs, sways,
/// breathes or jitters per state. Same data, same numbers, same face.
struct MausAvatar: View {
    let color: String
    var size: CGFloat = 52
    var state: MausState = .idle
    /// Animation is OPT-IN: a mounted face costs a 30fps Canvas redraw, and a
    /// roster of them once pegged the app (and SimRenderServer) all night.
    /// Pass true only where motion carries meaning — a busy bot, an open
    /// profile, the needs-you island's opening beat.
    var animated: Bool = false
    /// Comets orbiting the body — the island's "something is happening".
    var comets: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var engine = MausFaceEngine()

    var body: some View {
        // Even an opted-in face stops when the app is not active: nothing is
        // watching, and in the background the redraws only cost battery.
        let live = animated && !reduceMotion && scenePhase == .active
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !live)) { timeline in
            Canvas { context, canvasSize in
                engine.setState(state, now: timeline.date)
                if live { engine.step(now: timeline.date) }
                engine.draw(in: &context, size: canvasSize, color: color, bodyMotion: live, comets: comets, at: timeline.date)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The resting face for a state, drawn once and still. For places the
/// engine cannot run — a widget, a Live Activity — where the system renders
/// a snapshot and the face can only change between updates.
struct MausFaceStill: View {
    let color: String
    var state: MausState = .idle
    var size: CGFloat = 52
    var comets: Bool = false
    /// The clock for the comets' phase; a different date is a different frame.
    var at: Date = Date()

    var body: some View {
        Canvas { context, canvasSize in
            let engine = MausFaceEngine()
            engine.setState(state, now: Date(timeIntervalSinceReferenceDate: 0))
            engine.draw(in: &context, size: canvasSize, color: color, bodyMotion: false, comets: comets, at: at)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The face, frame by frame. One per drawn mascot; holds the morph in
/// progress, the blink, and when the next expression or blink is due.
final class MausFaceEngine {
    private(set) var state: MausState = .idle
    private var expression = 0
    private var currentRings: [[CGPoint]] = [MausFaceData.ring(0, eye: 0), MausFaceData.ring(0, eye: 1)]
    private var targetRings: [[CGPoint]] = [MausFaceData.ring(0, eye: 0), MausFaceData.ring(0, eye: 1)]
    private var currentMouth = MausFaceData.mouth(0)
    private var targetMouth = MausFaceData.mouth(0)
    private var currentGaze = MausFaceData.gaze(0)
    private var targetGaze = MausFaceData.gaze(0)
    private var morph: CGFloat = 1
    private var velocity: CGFloat = 0
    private var blinkStart: Date?
    private var nextExpressionAt: Date?
    private var nextBlinkAt: Date?
    private var stateStart = Date()
    private var last: Date?
    private var started = false

    /// The desktop's `lookAround` default: how much of an expression's own
    /// look-direction to keep.
    private let lookAround: CGFloat = 0.35
    /// Spring stiffness for the morph, the desktop's default.
    private let spring: CGFloat = 7

    func setState(_ new: MausState, now: Date) {
        guard !started || new != state else { return }
        started = true
        state = new
        stateStart = now
        select(MausFaceData.pools[new]?.first ?? 0)
        if last == nil { morph = 1; velocity = 0 } // first frame: rest on it, no morph in
        nextExpressionAt = schedule(MausFaceData.expressionCadence[new], from: now)
        nextBlinkAt = schedule(MausFaceData.blink[new], from: now)
    }

    private func schedule(_ range: (CGFloat, CGFloat)?, from now: Date) -> Date? {
        guard let range else { return nil }
        let ms = range.0 + CGFloat.random(in: 0...1) * (range.1 - range.0)
        return now.addingTimeInterval(TimeInterval(ms / 1000))
    }

    private func select(_ index: Int) {
        let i = ((index % MausFaceData.expressionCount) + MausFaceData.expressionCount) % MausFaceData.expressionCount
        if i == expression && morph >= 1 { return }
        currentRings = displayedRings()
        currentMouth = displayedMouth()
        currentGaze = displayedGaze()
        targetRings = [MausFaceData.ring(i, eye: 0), MausFaceData.ring(i, eye: 1)]
        targetMouth = MausFaceData.mouth(i)
        targetGaze = MausFaceData.gaze(i)
        expression = i
        morph = 0
        velocity = 0
    }

    func step(now: Date) {
        let dt = CGFloat(min(now.timeIntervalSince(last ?? now), 0.1))
        last = now
        // the spring towards morph == 1
        let f = spring
        velocity += (-2 * f * velocity - f * f * (morph - 1)) * dt
        morph += velocity * dt
        if !morph.isFinite { morph = 1; velocity = 0 }

        if let due = nextExpressionAt, now >= due {
            let pool = MausFaceData.pools[state] ?? [0]
            let alternatives = pool.filter { $0 != expression }
            select(alternatives.randomElement() ?? pool[0])
            nextExpressionAt = schedule(MausFaceData.expressionCadence[state], from: now)
        }
        if let due = nextBlinkAt, now >= due {
            blinkStart = now
            nextBlinkAt = schedule(MausFaceData.blink[state], from: now)
        }
    }

    // MARK: - Drawing

    // MARK: - Comets

    /// Comets orbiting the body on tilted rings — the desktop's `trails`.
    struct CometSpec {
        let count: Int
        /// ms for one orbit
        let period: CGFloat
        /// face units
        let radius: CGFloat
        /// half-width at the head
        let width: CGFloat
        /// how much of the orbit one comet covers, radians
        let span: CGFloat
        /// the body's resting scale while the rings are out, so they clear it
        let bodyScale: CGFloat
    }

    static let cometTrails: [MausState: CometSpec] = [
        .orbit: CometSpec(count: 6, period: 3000, radius: 105, width: 5, span: 2.5, bodyScale: 0.72),
        .radar: CometSpec(count: 4, period: 2400, radius: 106, width: 4.5, span: 2.1, bodyScale: 0.72),
        .progress: CometSpec(count: 5, period: 2000, radius: 104, width: 4.8, span: 2.3, bodyScale: 0.74),
        .loading: CometSpec(count: 5, period: 2400, radius: 105, width: 5, span: 2.6, bodyScale: 0.72),
        .uploading: CometSpec(count: 4, period: 1800, radius: 104, width: 4.8, span: 2.2, bodyScale: 0.74),
    ]

    /// One palette per comet: three neighbouring hues along its length. A flat
    /// colour reads as wire; a hue that travels reads as something lit.
    static let cometColors: [[Color]] = [
        ["#A855F7", "#6366F1", "#38BDF8"], ["#22D3EE", "#34D399", "#A3E635"], ["#FB923C", "#F43F5E", "#D946EF"],
        ["#818CF8", "#C084FC", "#F472B6"], ["#FACC15", "#FB923C", "#EC4899"], ["#34D399", "#22D3EE", "#60A5FA"],
    ].map { $0.map { Color(hex: $0) } }

    private struct CometSample { var x: CGFloat; var y: CGFloat; var h: CGFloat }
    private struct CometPiece { let path: Path; let shading: GraphicsContext.Shading; let front: Bool }

    private static func hash01(_ n: CGFloat) -> CGFloat {
        let x = sin(n * 127.1 + 311.7) * 43758.5453
        return x - floor(x)
    }

    /// The comets for this frame, each split at the horizon into pieces that
    /// go behind the body or in front of it.
    private func comets(_ spec: CometSpec, elapsed: CGFloat, centre: CGPoint, strength: CGFloat) -> [CometPiece] {
        var out: [CometPiece] = []
        let samples = 22
        let span = min(spec.span, .pi - 0.05)
        let near: CGFloat = 1.1 // swell at the near point of the ring — perspective, cheaply

        for i in 0..<spec.count {
            let seedA = Self.hash01(CGFloat(i + 3)), seedB = Self.hash01(CGFloat(i + 29)), seedC = Self.hash01(CGFloat(i + 71))
            // every ring its own tip, roll and speed, or they stack into one hoop
            let tilt = 0.3 + seedA * 0.66
            let roll = seedB * 2 * .pi
            let period = spec.period * (0.78 + seedC * 0.55)
            let direction: CGFloat = i % 2 == 0 ? 1 : -1
            let radius = spec.radius * strength * (0.94 + seedB * 0.12)
            let head = direction * (elapsed / period) * 2 * .pi + seedA * 2 * .pi
            let cosT = cos(tilt), sinT = sin(tilt), cosR = cos(roll), sinR = sin(roll)

            var runs: [(samples: [CometSample], front: Bool)] = []
            var run: [CometSample] = []
            var side: CGFloat = 0
            func keep(_ r: [CometSample]) -> Bool {
                guard r.count >= 3 else { return false }
                var length: CGFloat = 0
                for k in 1..<r.count { length += hypot(r[k].x - r[k - 1].x, r[k].y - r[k - 1].y) }
                return length > spec.width * 3.5
            }
            for sIndex in 0..<samples {
                let k = CGFloat(sIndex) / CGFloat(samples - 1)
                let angle = head - direction * span * k
                let ox = cos(angle) * radius, oy = sin(angle) * radius
                let ty = oy * cosT, z = oy * sinT
                let n = 1 + (z / radius) * (near - 1)
                let x = centre.x + (ox * cosR - ty * sinR) * n
                let y = centre.y + (ox * sinR + ty * cosR) * n
                // full at the head, a third by the tail — keeps it a comet, not a brush stroke
                let h = spec.width * n * (1 - 0.68 * pow(k, 1.5)) * strength
                let nowSide: CGFloat = z >= 0 ? 1 : -1
                if nowSide != side {
                    if keep(run) { runs.append((run, side > 0)) }
                    run = run.isEmpty ? [] : [run[run.count - 1]]
                    side = nowSide
                }
                run.append(CometSample(x: x, y: y, h: h))
            }
            if keep(run) { runs.append((run, side > 0)) }
            guard let firstRun = runs.first, let lastRun = runs.last else { continue }

            // one gradient across the whole comet, so a hue runs head to tail across a cut
            let colors = Self.cometColors[i % Self.cometColors.count]
            let shading = GraphicsContext.Shading.linearGradient(
                Gradient(stops: [
                    .init(color: colors[0], location: 0),
                    .init(color: colors[1], location: 0.52),
                    .init(color: colors[2].opacity(0.35), location: 1),
                ]),
                startPoint: CGPoint(x: firstRun.samples[0].x, y: firstRun.samples[0].y),
                endPoint: CGPoint(x: lastRun.samples[lastRun.samples.count - 1].x, y: lastRun.samples[lastRun.samples.count - 1].y)
            )
            for (r, piece) in runs.enumerated() {
                out.append(CometPiece(
                    path: Self.cometPath(piece.samples, capHead: r == 0, capTail: r == runs.count - 1),
                    shading: shading,
                    front: piece.front
                ))
            }
        }
        return out
    }

    /// Head→tail samples to one filled, tapered outline with half-round caps
    /// on the true ends — a comet is an outline, not a stroke.
    private static func cometPath(_ s: [CometSample], capHead: Bool, capTail: Bool) -> Path {
        let n = s.count
        var path = Path()
        guard n >= 2 else { return path }
        var nx: [CGFloat] = [], ny: [CGFloat] = []
        for i in 0..<n {
            let a = s[max(i - 1, 0)], b = s[min(i + 1, n - 1)]
            let tx = b.x - a.x, ty = b.y - a.y
            let len = max(hypot(tx, ty), 0.0001)
            nx.append(-ty / len); ny.append(tx / len)
        }
        func cap(_ i: Int, _ out: CGFloat) -> [CGPoint] {
            let steps = 6
            let x = s[i].x, y = s[i].y, h = s[i].h
            let tx = ny[i], ty = -nx[i]
            return (1..<steps).map { k in
                let a = CGFloat(k) / CGFloat(steps) * .pi
                let dn = out * cos(a), dt = out * sin(a)
                return CGPoint(x: x + (nx[i] * dn + tx * dt) * h, y: y + (ny[i] * dn + ty * dt) * h)
            }
        }
        var outline: [CGPoint] = [CGPoint(x: s[0].x - nx[0] * s[0].h, y: s[0].y - ny[0] * s[0].h)]
        if capHead { outline += cap(0, -1) }
        for i in 0..<n { outline.append(CGPoint(x: s[i].x + nx[i] * s[i].h, y: s[i].y + ny[i] * s[i].h)) }
        if capTail { outline += cap(n - 1, 1) }
        for i in stride(from: n - 1, to: 0, by: -1) { outline.append(CGPoint(x: s[i].x - nx[i] * s[i].h, y: s[i].y - ny[i] * s[i].h)) }
        path.move(to: outline[0])
        for p in outline.dropFirst() { path.addLine(to: p) }
        path.closeSubpath()
        return path
    }

    // MARK: - Drawing

    /// `comets`: orbit the body with the `orbit` state's rings whatever the
    /// face is doing — the island's "something is happening" — in addition to
    /// the states that carry their own. `at` is the clock; pass a fixed date
    /// for a still frame.
    func draw(in context: inout GraphicsContext, size: CGSize, color: String, bodyMotion: Bool, comets: Bool = false, at now: Date = Date()) {
        let rect = CGRect(origin: .zero, size: size)
        context.concatenate(MausSilhouette.fit(rect))
        let elapsed = CGFloat(now.timeIntervalSince(stateStart) * 1000)
        let spec = Self.cometTrails[state] ?? (comets ? Self.cometTrails[.orbit] : nil)
        let centre = CGPoint(x: MausFaceData.faceBox / 2, y: MausFaceData.faceBox / 2)

        let pieces = spec.map { self.comets($0, elapsed: elapsed, centre: centre, strength: 1) } ?? []
        for piece in pieces where !piece.front { context.fill(piece.path, with: piece.shading) }

        // The body, in its own pushed context so the rings are not under its
        // transform. Comet states sit back a little, so the rings clear them.
        var bodyContext = context
        if let spec {
            bodyContext.translateBy(x: centre.x, y: centre.y)
            bodyContext.scaleBy(x: spec.bodyScale, y: spec.bodyScale)
            bodyContext.translateBy(x: -centre.x, y: -centre.y)
        }
        if bodyMotion {
            bodyContext.concatenate(bodyTransform(MausFaceData.motion[state] ?? MausBodyMotion(), elapsed: elapsed))
        }
        drawBody(in: &bodyContext, color: color, now: now)

        for piece in pieces where piece.front { context.fill(piece.path, with: piece.shading) }
    }

    private func drawBody(in context: inout GraphicsContext, color: String, now: Date) {
        let body = MausSilhouette.inFaceBox
        let bounds = MausSilhouette.faceBoxBounds
        context.fill(body, with: .linearGradient(
            Gradient(stops: MausPalette.gradientStops(color)),
            startPoint: CGPoint(x: bounds.maxX, y: bounds.minY),
            endPoint: CGPoint(x: bounds.minX, y: bounds.maxY)
        ))

        // The face is painted on the body: clipped to it, anchored in it.
        context.clip(to: body)
        let a = MausFaceData.anchor
        context.translateBy(x: a.x, y: a.y)
        context.scaleBy(x: a.scale, y: a.scale)
        context.translateBy(x: -MausFaceData.faceCentre.x, y: -MausFaceData.faceCentre.y)

        let gaze = displayedGaze()
        let ox = gaze.x * lookAround, oy = gaze.y * lookAround
        let rings = displayedRings().map { $0.map { CGPoint(x: $0.x + ox, y: $0.y + oy) } }
        let blink = blinkScale(now: now)

        for ring in rings {
            let c = Self.centre(ring)
            var path = Path()
            for (i, p) in ring.enumerated() {
                // blink squashes the eye towards its own centre line
                let q = CGPoint(x: p.x, y: c.y + (p.y - c.y) * blink)
                if i == 0 { path.move(to: q) } else { path.addLine(to: q) }
            }
            path.closeSubpath()
            context.fill(path, with: .color(.white))
        }

        let spec = displayedMouth()
        let frame = Self.mouthFrame(rings, spec)
        context.stroke(
            Self.mouthPath(frame, spec),
            with: .color(.white),
            style: StrokeStyle(lineWidth: MausFaceData.mouthStroke, lineCap: .round)
        )
    }

    /// The desktop's `bodyTransform`, in face-box units, elapsed in ms.
    private func bodyTransform(_ m: MausBodyMotion, elapsed: CGFloat) -> CGAffineTransform {
        let centre = MausFaceData.faceBox / 2
        let ground = MausFaceData.faceBox
        func wave(_ period: CGFloat, _ phase: CGFloat = 0) -> CGFloat { sin(elapsed / period * .pi * 2 + phase) }
        var dx: CGFloat = 0, dy: CGFloat = 0
        var rotation = m.tilt ?? 0
        var scale: CGFloat = 1, sx: CGFloat = 1, sy: CGFloat = 1
        if let (amplitude, period) = m.bob {
            let p = wave(period)
            dy -= amplitude * p
            if let squash = m.squash {
                let amount = squash * max(0, -p)
                sy = 1 - amount * 0.5
                sx = 1 + amount * 0.5
            }
        }
        if let (radius, period) = m.circle {
            dx += radius * wave(period)
            dy += radius * wave(period, .pi / 2)
        }
        if let (degrees, period) = m.sway { rotation += degrees * wave(period) }
        if let (fraction, period) = m.pulse { scale *= 1 + fraction * wave(period) }
        if let (amplitude, period) = m.jitter {
            dx += amplitude * wave(period)
            dy += amplitude * wave(period * 0.63, 1.1)
        }
        if let (from, duration) = m.enter {
            let t = elapsed / duration
            scale *= t >= 1 ? 1 : from + (1 - from) * Self.easeOutBack(max(t, 0))
        }
        if let settle = m.settle {
            let t = min(max(elapsed / 1400, 0), 1)
            scale *= 1 + (settle - 1) * Self.easeInOut(t)
        }
        // SVG applies the list right-to-left: squash, then scale, then rotate,
        // then translate. Build it in that order.
        var t = CGAffineTransform.identity
        if sx != 1 || sy != 1 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -ground))
                .concatenating(CGAffineTransform(scaleX: sx, y: sy))
                .concatenating(CGAffineTransform(translationX: centre, y: ground))
        }
        if scale != 1 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -centre))
                .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                .concatenating(CGAffineTransform(translationX: centre, y: centre))
        }
        if rotation != 0 {
            t = t.concatenating(CGAffineTransform(translationX: -centre, y: -centre))
                .concatenating(CGAffineTransform(rotationAngle: rotation * .pi / 180))
                .concatenating(CGAffineTransform(translationX: centre, y: centre))
        }
        if dx != 0 || dy != 0 { t = t.concatenating(CGAffineTransform(translationX: dx, y: dy)) }
        return t
    }

    private func blinkScale(now: Date) -> CGFloat {
        guard let start = blinkStart else { return 1 }
        let t = CGFloat(now.timeIntervalSince(start)) / 0.320
        if t >= 1 { blinkStart = nil; return 1 }
        // fast close, slower open
        return max(t < 0.42 ? 1 - t / 0.42 : (t - 0.42) / 0.58, 0.04)
    }

    private func displayedRings() -> [[CGPoint]] {
        let m = min(max(morph, 0), 1)
        return currentRings.enumerated().map { eye, ring in
            ring.enumerated().map { i, p in
                let q = targetRings[eye][i]
                return CGPoint(x: p.x + (q.x - p.x) * m, y: p.y + (q.y - p.y) * m)
            }
        }
    }
    private func displayedMouth() -> [CGFloat] {
        let m = min(max(morph, 0), 1)
        return currentMouth.enumerated().map { i, v in v + (targetMouth[i] - v) * m }
    }
    private func displayedGaze() -> CGPoint {
        let m = min(max(morph, 0), 1)
        return CGPoint(x: currentGaze.x + (targetGaze.x - currentGaze.x) * m, y: currentGaze.y + (targetGaze.y - currentGaze.y) * m)
    }

    private static func centre(_ ring: [CGPoint]) -> CGPoint {
        var x: CGFloat = 0, y: CGFloat = 0
        for p in ring { x += p.x; y += p.y }
        return CGPoint(x: x / CGFloat(ring.count), y: y / CGFloat(ring.count))
    }

    /// The mouth hangs off the eyes: centred under the pair, tilted with
    /// them, pushed clear of whichever eye is tallest.
    private static func mouthFrame(_ rings: [[CGPoint]], _ spec: [CGFloat]) -> (x: CGFloat, y: CGFloat, angle: CGFloat) {
        let c0 = centre(rings[0]), c1 = centre(rings[1])
        let theta = atan2(c1.y - c0.y, c1.x - c0.x)
        var halfHeight: CGFloat = 0
        for ring in rings {
            var lo = CGFloat.infinity, hi = -CGFloat.infinity
            for p in ring { lo = min(lo, p.y); hi = max(hi, p.y) }
            halfHeight = max(halfHeight, (hi - lo) / 2)
        }
        let drop = halfHeight + spec[2]
        return (
            x: (c0.x + c1.x) / 2 - sin(theta) * drop,
            y: (c0.y + c1.y) / 2 + cos(theta) * drop,
            angle: theta + spec[3] * .pi / 180
        )
    }

    private static func mouthPath(_ frame: (x: CGFloat, y: CGFloat, angle: CGFloat), _ spec: [CGFloat]) -> Path {
        let ca = cos(frame.angle), sa = sin(frame.angle)
        func at(_ lx: CGFloat, _ ly: CGFloat) -> CGPoint {
            CGPoint(x: frame.x + lx * ca - ly * sa, y: frame.y + lx * sa + ly * ca)
        }
        var path = Path()
        path.move(to: at(-spec[0], 0))
        path.addQuadCurve(to: at(spec[0], 0), control: at(0, spec[1]))
        return path
    }

    private static func easeOutBack(_ t: CGFloat) -> CGFloat {
        let c: CGFloat = 1.7, u = t - 1
        return 1 + (c + 1) * u * u * u + c * u * u
    }
    private static func easeInOut(_ t: CGFloat) -> CGFloat { t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t) }
}

/// The person, not a bot — the roster header and the settings row. A letter
/// rather than a mascot, deliberately: the mascots mean "this is a bot", and
/// giving the human one too would blur the only distinction the roster makes.
struct ProfileAvatar: View {
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Circle()
            .fill(MausPalette.color("green"))
            .frame(width: size, height: size)
            .overlay {
                Text(initial)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private var initial: String {
        String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    }
}

extension MausPalette {
    /// The gradient as raw stops, for `Canvas`, which cannot take a
    /// `LinearGradient` directly.
    static func gradientStops(_ name: String) -> [Gradient.Stop] {
        let base = color(name)
        return [
            .init(color: base.mixed(with: .white, amount: 0.55), location: 0),
            .init(color: base, location: 0.55),
            .init(color: base.mixed(with: .black, amount: 0.42), location: 1),
        ]
    }
}

extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }

    /// Linear mix in sRGB, matching the `mix()` the desktop uses to build its
    /// gradient stops. Not perceptually correct, and deliberately so: the
    /// point is to land on the same colours as the other screen.
    func mixed(with other: Color, amount: Double) -> Color {
        #if canImport(UIKit)
        let a = UIColor(self), b = UIColor(other)
        var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        a.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
        b.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        let t = CGFloat(amount)
        return Color(
            .sRGB,
            red: Double(ar + (br - ar) * t),
            green: Double(ag + (bg - ag) * t),
            blue: Double(ab + (bb - ab) * t),
            opacity: 1
        )
        #else
        return self
        #endif
    }
}
