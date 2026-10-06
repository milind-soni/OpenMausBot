import Foundation

/// What a message's text shows once the wrappers it travels in are off,
/// worked out once per message rather than once per render.
///
/// The transcript used to derive all of this inside its row bodies (the
/// attachment tags twice, the diff test twice, the webhook envelope once),
/// and every row redrew on every publish, so a user message carrying a long
/// paste was scanned line by line twenty times a second while any bot in the
/// fleet streamed. The parsers are the same ones; only where they run moved.
public struct MessagePresentation: Hashable, Sendable {
    /// The text without OpenMausBot's attachment and paste wrappers, and the
    /// attachments those tags named.
    public let attached: AttachedMessageContent
    /// A bot reply that is one whole patch, drawn as a diff card.
    public let patch: GitPatch?
    /// A webhook delivery: its trusted task and the event payload.
    public let webhook: WebhookMessageContent?

    public init(_ message: Message) {
        attached = AttachedMessageContent.parse(message.text ?? "")
        patch = GitPatch(message)
        webhook = message.webhookContent
    }

    /// What Copy and Select Text take: the words, never a transport tag or a
    /// path on the paired computer.
    public var visibleText: String { webhook?.task ?? attached.text }
}

/// A bot reply that is a unified diff and nothing else: fenced as ```diff,
/// or raw `git diff` output.
public struct GitPatch: Hashable, Sendable {
    public let filename: String
    public let diff: String

    public init?(_ message: Message) {
        guard message.role != .user, let source = message.text else { return nil }
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let diff: String
        if text.hasPrefix("```diff"), text.hasSuffix("```") {
            diff = String(text.dropFirst("```diff".count).dropLast(3))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else if text.hasPrefix("diff --git ") {
            diff = text
        } else {
            return nil
        }
        let firstLine = diff.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        self.filename = firstLine.split(separator: " ").last.map(String.init)?
            .replacingOccurrences(of: "b/", with: "") ?? "Git patch"
        self.diff = diff
    }
}
