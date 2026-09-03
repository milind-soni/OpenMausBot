// A message the computer is holding, sitting just above the chat bar.
//
// A mid-turn send to a bot that cannot take words into a running turn does
// not reach the transcript: the harness holds it, because appending it now
// would make it the active leaf and the rest of the turn would hang off a
// line the model never saw. Correct — but with nothing on screen it reads
// as the phone having eaten the message, which is the bug this row fixes.
//
// It lives above the composer rather than in the transcript because that is
// where a thing you have not said yet belongs — still in your hands, next
// to the field you typed it in. Both actions are words, not glyphs: Steer
// stops the turn so these words run now (the harness deliberately keeps its
// queue across an interrupt, which is what makes stopping a send), and the
// bin drops them.
import SwiftUI
import CompanionCore

struct QueuedSendRow: View {
    let send: QueuedSend
    /// Stop the turn so this runs now. Absent where the phone cannot
    /// interrupt — a room — so the button is not offered rather than broken.
    let onSteer: (() -> Void)?
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.secondary)

            Text(send.text)
                .font(.system(size: 15))
                .foregroundStyle(Color.primary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let onSteer {
                Button(action: onSteer) {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.system(size: 11, weight: .bold))
                        Text("Steer")
                            .font(.system(size: 14, weight: .medium))
                    }
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.secondary.opacity(0.22)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Steer")
                .accessibilityHint("Stops the current turn so this message runs now")
            }

            Button(action: onCancel) {
                Image(systemName: "trash")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Delete this queued message")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.secondary.opacity(0.14))
        )
    }
}
