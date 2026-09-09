// A folded run of activity: one line standing in for several chips.
//
// What "Reduced" buys the reader. A bot that ran four tools in a row leaves
// four receipts, and past the second one they stop carrying information —
// so the run becomes a single line that says how many there were, and opens
// back into the real chips on a tap.
//
// Failures never arrive here: `transcriptRows` breaks them out before a run
// is formed, so anything folded is either finished or still going.
import SwiftUI
import CompanionCore

struct ActivityRunChip: View {
    let items: [Message]
    /// Where an "Opened thread" chip inside the run goes once unfolded.
    var openThread: ((ThreadRef) -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var running: Bool { items.contains { $0.tool?.ok == nil } }

    private var summary: String {
        running ? "Running \(items.count) steps" : "Ran \(items.count) steps"
    }

    var body: some View {
        let isDark = colorScheme == .dark

        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) { expanded.toggle() }
                Haptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: running ? "ellipsis.circle" : "checkmark.seal.fill")
                        .font(.system(size: 11))
                        .foregroundColor(running ? Color.secondary : Color(hex: "#22C55E"))

                    Text(summary)
                        .font(.caption2.weight(.bold))
                        .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#334155"))

                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(Color.secondary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 4.5)
                .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.05))
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 0.5)
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(summary)
            .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")

            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(items, id: \.id) { item in
                        ActivityChip(tool: item.tool, threadRef: item.threadRef, openThread: openThread)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.leading, 2)
    }
}
