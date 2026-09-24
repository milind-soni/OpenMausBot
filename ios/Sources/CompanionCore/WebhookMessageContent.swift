import Foundation

/// A display projection only: the stored prompt retains its trust wrappers.
/// Matches the desktop's webhook-message parser.
public struct WebhookMessageContent: Hashable, Sendable {
    public let task: String
    public let payload: String?

    public static func parse(_ text: String) -> Self? {
        guard let eventStart = text.range(of: "[UNTRUSTED WEBHOOK EVENT DATA]\n") else { return nil }
        let trustedPrefix = String(text[..<eventStart.lowerBound])
        func block(_ marker: String, in source: String) -> String? {
            guard let start = source.range(of: "[\(marker)]\n"),
                  let end = source.range(of: "\n[/\(marker)]", range: start.upperBound..<source.endIndex) else { return nil }
            return String(source[start.upperBound..<end.lowerBound])
        }
        let markers = ["AUTHENTICATED WEBHOOK TASK", "USER-CONFIGURED WEBHOOK INSTRUCTIONS", "DEFAULT WEBHOOK INSTRUCTIONS"]
        guard let task = markers.compactMap({ block($0, in: trustedPrefix)?.trimmingCharacters(in: .whitespacesAndNewlines) })
            .first(where: { !$0.isEmpty }),
              let event = block("UNTRUSTED WEBHOOK EVENT DATA", in: text), !event.isEmpty else { return nil }
        let payload = event.range(of: "\n\n").map {
            String(event[$0.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return Self(task: task, payload: payload?.isEmpty == false ? payload : nil)
    }
}

public extension Message {
    var webhookContent: WebhookMessageContent? {
        guard role == .user, kind == .text, let text else { return nil }
        return WebhookMessageContent.parse(text)
    }
}
