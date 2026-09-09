// The Live Activity's contract — compiled into both the app and the widget
// extension, so the two agree on what a bot's island says.
//
// One activity per bot that is doing something: needs you, or working.
// Quiet bots have no activity, the same rule as the Updates pill.
import ActivityKit
import AppIntents
import Foundation
import CompanionCore

struct BotActivityAttributes: ActivityAttributes {
    public typealias ContentState = BotActivityContent

    var botId: String
    /// Retained to decode existing activities. Routing uses ContentState.
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
