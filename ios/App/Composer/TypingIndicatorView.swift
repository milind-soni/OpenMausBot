import SwiftUI

/// The bot is typing: three dots bouncing in the bot's own received-message
/// bubble, the way Messages shows someone typing.
///
/// Drawn in the same bubble, padding and tail as `StreamingBubble` and a
/// settled reply, so the reply that replaces it arrives as text in a bubble
/// that was already there rather than as a new shape. One line high, so the
/// handover does not jump the transcript by much either.
///
/// Reduce Motion holds the dots still and a little fainter: still three dots,
/// because a reader who asked for less motion did not ask to be told less.
struct TypingIndicatorView: View {
    /// Whose bubble this is, for VoiceOver: "Pepper is typing".
    let name: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let dotSize: CGFloat = 8
    static let dotSpacing: CGFloat = 5
    /// How far a dot rises at the top of its bounce.
    static let bounceHeight: CGFloat = 3
    /// One full pass of the wave across the three dots.
    static let period: Double = 1.2
    /// How far behind its neighbour each dot starts.
    static let stagger: Double = 0.15
    /// The part of a dot's cycle spent in the air; it rests for the remainder.
    static let airborne: Double = 0.5

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                HStack(spacing: Self.dotSpacing) {
                    ForEach(0..<3, id: \.self) { index in
                        let lift = reduceMotion ? 0 : Self.lift(index, at: context.date.timeIntervalSinceReferenceDate)
                        Circle()
                            .fill(Color.secondary)
                            .frame(width: Self.dotSize, height: Self.dotSize)
                            .opacity(reduceMotion ? 0.45 : 0.55 + 0.4 * lift)
                            .offset(y: -Self.bounceHeight * lift)
                    }
                }
                // A line of body text tall, so the bubble matches a one-line
                // reply and the bounce has room inside it.
                .frame(height: 22)
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .background(SpeechBubble(tail: .leading).fill(BubbleColor.theirs))
            .padding(.bottom, SpeechBubble.tailDrop())
            Spacer(minLength: 44)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(name) is typing"))
        .accessibilityIdentifier("typing-indicator")
    }

    /// How high dot `index` is at time `seconds`, from 0 (resting) to 1 (top).
    /// A half sine while airborne, then still: each dot hops and lands in turn.
    static func lift(_ index: Int, at seconds: TimeInterval) -> CGFloat {
        let shifted = seconds - Double(index) * stagger
        let cycle = (shifted.truncatingRemainder(dividingBy: period) + period).truncatingRemainder(dividingBy: period) / period
        guard cycle < airborne else { return 0 }
        return CGFloat(sin(cycle / airborne * .pi))
    }
}
