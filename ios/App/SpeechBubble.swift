// The message bubble, tail included.
//
// The tail is not an approximation: its four Bézier segments are the ones
// from the reference vector (`docs/ios/bubble-tail-reference.svg`), scaled
// so the reference's cap radius becomes this bubble's corner radius. That is why it curls in, drops, and ends soft rather than in a
// point — the shape is the drawing, not a guess at it.
import SwiftUI

struct SpeechBubble: Shape {
    enum Tail { case none, leading, trailing }

    var tail: Tail = .none
    var cornerRadius: CGFloat = 22

    /// How far below the bubble's bottom edge the tail reaches, so callers can
    /// leave room for it. Depends on the corner radius the same way the tail
    /// does.
    static func tailDrop(cornerRadius: CGFloat = 22) -> CGFloat {
        cornerRadius / referenceCapRadius * referenceTailDrop
    }

    // The reference: a 772×428 pill whose right cap has this radius, whose
    // right edge is at x=766.342 and bottom edge at y=361.317, and whose tail
    // hangs 68 below the bottom edge.
    private static let referenceCapRadius: CGFloat = 179
    private static let referenceTailDrop: CGFloat = 68
    private static let referenceOrigin = CGPoint(x: 766.342, y: 361.317)
    private static let referenceTail: [(CGPoint, CGPoint, CGPoint)] = [
        (CGPoint(x: 766.342, y: 249.767), CGPoint(x: 727.342, y: 299.817), CGPoint(x: 699.842, y: 323.317)),
        (CGPoint(x: 699.842, y: 323.317), CGPoint(x: 677.085, y: 338.817), CGPoint(x: 674.342, y: 354.817)),
        (CGPoint(x: 668.342, y: 389.817), CGPoint(x: 700.829, y: 410.817), CGPoint(x: 691.829, y: 421.317)),
        (CGPoint(x: 684.629, y: 429.717), CGPoint(x: 615.056, y: 378.235), CGPoint(x: 580.342, y: 361.317)),
    ]

    func path(in rect: CGRect) -> Path {
        let r = min(cornerRadius, rect.height / 2, rect.width / 2)
        guard tail != .none else {
            return RoundedRectangle(cornerRadius: r, style: .continuous).path(in: rect)
        }
        var path = trailingTailPath(in: rect, radius: r)
        if tail == .leading {
            // Mirror the trailing shape about the rect's vertical centre line.
            let flip = CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0).scaledBy(x: -1, y: 1)
            path = path.applying(flip)
        }
        return path
    }

    /// The bubble with the tail at bottom-right, drawn clockwise from the top
    /// edge. The three plain corners are circular arcs; the fourth is the
    /// reference's cap-and-tail, scaled.
    private func trailingTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        let s = r / Self.referenceCapRadius
        let origin = CGPoint(x: rect.maxX, y: rect.maxY)
        func map(_ p: CGPoint) -> CGPoint {
            CGPoint(x: origin.x + (p.x - Self.referenceOrigin.x) * s, y: origin.y + (p.y - Self.referenceOrigin.y) * s)
        }

        var path = Path()
        path.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addArc(
            center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
            startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false
        )
        // Down the right edge to where the reference cap begins — exactly one
        // radius above the bottom, which is where the first segment starts.
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        for (c1, c2, end) in Self.referenceTail {
            path.addCurve(to: map(end), control1: map(c1), control2: map(c2))
        }
        // The last segment lands back on the bottom edge, left of the corner.
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addArc(
            center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r,
            startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addArc(
            center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r,
            startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false
        )
        path.closeSubpath()
        return path
    }
}

/// The two bubble fills. Solid rather than translucent on purpose: the tail
/// is part of the same fill, and a see-through bubble shows the seam.
enum BubbleColor {
    /// What you said. The mascot palette's blue, not the system's.
    static let mine = MausPalette.color("blue")
    static let mineText = Color.white

    /// What a bot said. Near-black on dark, a soft grey on light.
    static let theirs = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.149, green: 0.149, blue: 0.161, alpha: 1)   // #262629
            : UIColor(red: 0.914, green: 0.914, blue: 0.922, alpha: 1)   // #E9E9EB
    })
}
