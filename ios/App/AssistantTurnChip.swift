import SwiftUI
import CompanionCore

/// The same reversible narration fold as desktop. Activity preferences apply
/// to tool receipts independently, so Hidden still offers this compact row.
struct AssistantTurnChip: View {
    let turn: AssistantTurnFold
    let context: TranscriptRowContext
    let actions: TranscriptActions
    /// A search hit inside this fold: open it and bring the reply into view.
    var revealedMessageId: String? = nil
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation { expanded.toggle() }
                Haptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark")
                    Text(turn.label)
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(Color.secondary.opacity(0.08), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(turn.label)
            .accessibilityHint(expanded ? "Hides intermediate replies" : "Shows intermediate replies")
            .accessibilityIdentifier("assistant-turn.\(turn.turnId)")

            if expanded {
                ForEach(Array(turn.messages.enumerated()), id: \.element.id) { index, message in
                    MessageRow(
                        message: message, endsRun: index == turn.messages.count - 1,
                        context: context, actions: actions
                    )
                    .equatable()
                    .id(message.id)
                    .onAppear {
                        if revealedMessageId == message.id { actions.reveal(messageId: message.id) }
                    }
                }
            }
        }
        .onValueChange(of: revealedMessageId, initial: true) { id in
            if turn.messages.contains(where: { $0.id == id }) { expanded = true }
        }
    }
}
