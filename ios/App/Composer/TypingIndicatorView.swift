import SwiftUI

public struct TypingIndicatorView: View {
    public let tintColor: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    
    public init(tintColor: Color = .purple) {
        self.tintColor = tintColor
    }
    
    public var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            HStack(spacing: 5) {
                ForEach(0..<3) { index in
                    Circle()
                        .fill(tintColor.opacity(0.85))
                        .frame(width: 6.5, height: 6.5)
                        .scaleEffect(reduceMotion ? 1 : dotScale(index, at: context.date))
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.12))
        .clipShape(Capsule())
    }

    private func dotScale(_ index: Int, at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate - Double(index) * 0.16
        let wave = (sin(elapsed * .pi * 2) + 1) / 2
        return 0.35 + CGFloat(wave) * 0.65
    }
}
