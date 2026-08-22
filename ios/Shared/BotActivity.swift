// The Live Activity's contract — compiled into both the app and the widget
// extension, so the two agree on what a bot's island says.
//
// One activity per bot that is doing something: needs you, or working.
// Quiet bots have no activity, the same rule as the Updates pill.
import ActivityKit
import AppIntents
import Foundation

struct BotActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// `MausState.rawValue` — the face to wear.
        var face: String
        /// "needsYou" | "working" | "toReview"
        var kind: String
        /// "Scout needs you", "Forge is working"
        var headline: String
        /// The question, or what it is doing.
        var line: String
        /// A pending card to answer, when kind == needsYou.
        var requestId: String?
        var options: [String]
        /// A permission card answers allow/deny; a question answers with text.
        var isPermission: Bool
        /// When this kind began — the island's timer and ring count from it.
        var since: Date
    }

    var botId: String
    var threadId: String
    var name: String
    /// MausPalette colour name.
    var color: String
}

/// Answer from the island or the lock screen. A `LiveActivityIntent` runs in
/// the app's own process, so the app wires `handler` at launch and the
/// widget copy of this type never performs anything itself.
struct AnswerApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Answer"
    static var isDiscoverable = false

    @Parameter(title: "Thread") var threadId: String
    @Parameter(title: "Request") var requestId: String
    @Parameter(title: "Choice") var choice: String
    @Parameter(title: "Permission") var isPermission: Bool

    init() {}
    init(threadId: String, requestId: String, choice: String, isPermission: Bool) {
        self.threadId = threadId
        self.requestId = requestId
        self.choice = choice
        self.isPermission = isPermission
    }

    /// Set by the app at launch. Nil in the widget extension.
    nonisolated(unsafe) static var handler: ((_ threadId: String, _ requestId: String, _ choice: String, _ isPermission: Bool) async -> Void)?

    func perform() async throws -> some IntentResult {
        await Self.handler?(threadId, requestId, choice, isPermission)
        return .result()
    }
}
