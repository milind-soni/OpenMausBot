import SwiftUI
import CompanionCore

/// The same reversible narration fold as desktop. Activity preferences apply
/// to tool receipts independently, so Hidden still offers this compact row.
struct AssistantTurnChip: View {
    let turn: AssistantTurnFold
    let chat: Chat
    let openLink: (URL, Message) -> OpenURLAction.Result
    var openThread: ((ThreadRef) -> Void)? = nil
    var revealedMessageId: String? = nil
    var scrollToMessage: ((String) -> Void)? = nil
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
                        chat: chat, message: message, endsRun: index == turn.messages.count - 1,
                        openLink: openLink, openThread: openThread
                    )
                    .id(message.id)
                    .onAppear {
                        if revealedMessageId == message.id { scrollToMessage?(message.id) }
                    }
                }
            }
        }
        .onChange(of: revealedMessageId, initial: true) { _, id in
            if turn.messages.contains(where: { $0.id == id }) { expanded = true }
        }
    }
}
