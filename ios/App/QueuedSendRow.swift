// A message the computer is holding, drawn where its bubble will land.
//
// A mid-turn send to a bot that cannot take words into a running turn does
// not reach the transcript: the harness holds it, because appending it now
// would make it the active leaf and the rest of the turn would hang off a
// line the model never saw. Correct — but with nothing on screen it reads
// as the phone having eaten the message, which is the bug this row fixes.
//
// Dashed rather than filled, in the place the real bubble will take, so the
// difference between "waiting" and "said" is visible at a glance.
import SwiftUI
import CompanionCore

struct QueuedSendRow: View {
    let send: QueuedSend
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: 4) {
                Text(send.text)
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 11)
                    .background(
                        SpeechBubble(tail: .none)
                            .stroke(style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                            .foregroundStyle(Color.secondary.opacity(0.45))
                    )

                HStack(spacing: 5) {
                    Image(systemName: "clock")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Waiting for this turn to finish")
                        .font(.system(size: 12))
                    Button(action: onCancel) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .frame(width: 20, height: 20)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel this queued message")
                }
                .foregroundStyle(Color.secondary)
                .padding(.trailing, 2)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Queued: \(send.text)")
    }
}
