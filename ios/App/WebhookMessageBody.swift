import SwiftUI
import CompanionCore

struct WebhookMessageBody: View {
    let content: WebhookMessageContent
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Webhook task", systemImage: "bolt.horizontal.circle")
                .font(.caption.weight(.semibold))
            Text(content.task)
                .font(.system(size: 17))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let payload = content.payload {
                DisclosureGroup("Event payload", isExpanded: $expanded) {
                    ScrollView {
                        Text(payload)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("webhook-payload")
                    }
                    .frame(maxHeight: 180)
                }
                .font(.caption)
                .tint(BubbleColor.mineText)
            }
        }
        .foregroundStyle(BubbleColor.mineText)
    }
}
