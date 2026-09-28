// Deep links: the openmausbot:// scheme's whole vocabulary.
//
// Pairing was the scheme's only word; home-screen widgets and notifications
// add "open this exact chat". Parsing lives in Core so the app and the
// widget extension agree on what the URLs mean, the same reason the
// activity contract lives here — and so every shape is unit-testable.
import Foundation

public enum CompanionDeepLink: Equatable, Sendable {
    case pairing(PairingInvite)
    case chat(threadId: String)

    /// Parses one openmausbot:// URL, or a server pair link. Anything the
    /// app does not recognize returns nil and is ignored rather than
    /// surfaced as an error: the person holding the phone did not type it.
    public static func parse(_ url: URL) -> CompanionDeepLink? {
        if let invite = PairingInvite.parse(url) { return .pairing(invite) }
        guard url.scheme?.lowercased() == "openmausbot",
              url.host?.lowercased() == "chat",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.path.count > 1
        else { return nil }
        // The path is exactly one segment: the thread id, percent-decoded.
        // More than that is not a link we emitted, and an id smuggling a
        // path separator is not a thread; ignoring either lands the person
        // on the roster, which is always safe.
        guard let threadId = String(components.path.dropFirst()).removingPercentEncoding,
              !threadId.isEmpty,
              !threadId.contains("/")
        else { return nil }
        return .chat(threadId: threadId)
    }
}

