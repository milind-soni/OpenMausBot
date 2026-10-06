import Foundation

/// How an image sits in the transcript: the whole picture at its own shape,
/// fitted to the bubble, never cropped.
///
/// The card used to be a fixed 168-point strip filled edge to edge. A wide
/// screenshot filled it by growing sideways, and since nothing held the card
/// to the bubble the growth carried the bubble, the transcript and the whole
/// chat screen past the phone's edges with it. The card's size now comes only
/// from the width it is offered and the shape below; the pixels are drawn
/// inside that box and never measured.
///
/// Android draws the same card from `AttachmentImageRules` — keep the numbers
/// in step.
public enum TranscriptImageFit {
    /// Tallest an inline image is drawn, in points.
    public static let maximumHeight: Double = 300
    /// Widest an inline image is drawn, in points — an iPad's chat column.
    public static let maximumWidth: Double = 360
    /// The card's height while the thumbnail loads and its shape is unknown.
    public static let placeholderHeight: Double = 168
    /// The card's width ÷ height stays between 3:4 portrait and 4:1
    /// panorama. A taller image (a phone screenshot) sits whole on a neutral
    /// backing in a 3:4 card rather than as a thin sliver; a wider one gets
    /// a strip tall enough to tap.
    public static let aspectRange: ClosedRange<Double> = 0.75...4
    /// Long edge of the decoded thumbnail, in pixels: the widest card at 3x,
    /// so a screenshot's text stays legible without decoding the original.
    public static let thumbnailPixelSize = 1_080

    /// The card's width ÷ height for an image of this size, or nil when the
    /// size says nothing about the shape.
    public static func cardAspect(width: Double, height: Double) -> Double? {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
        return min(max(width / height, aspectRange.lowerBound), aspectRange.upperBound)
    }

    /// The widest the card may be at this shape: `maximumWidth`, or less
    /// when that would make a tall card taller than `maximumHeight`.
    public static func maximumCardWidth(aspect: Double) -> Double {
        min(maximumWidth, maximumHeight * aspect)
    }

    /// The card for a bubble that offers `available` points of width.
    public static func cardSize(aspect: Double, available: Double) -> (width: Double, height: Double) {
        let width = max(0, min(available, maximumCardWidth(aspect: aspect)))
        return (width, width / aspect)
    }
}
