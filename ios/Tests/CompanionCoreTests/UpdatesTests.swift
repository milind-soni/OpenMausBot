// Characterization of the Updates computation, pinned before home-screen
// widgets consume it. The fixture is a fleet in the shape GET /api/bots
// returns; client-only state (streaming tails, held sends) is layered on in
// code because it never rides the wire. When one of these fails, the pill,
// the sheet, and the island all changed meaning — not just the test.
import XCTest
@testable import CompanionCore

final class UpdatesTests: XCTestCase {
    // MARK: - Fixtures

    private func fixture(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: name, withExtension: "json")
        else {
            XCTFail("missing fixture \(name).json")
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    /// The fleet hydrated exactly as a cold `GET /api/bots` would land.
    private var hydrated: CompanionState {
        get throws {
            let fleet = try JSONDecoder().decode(Fleet.self, from: try fixture("updates-fleet"))
            var state = CompanionState()
            state.hydrate(fleet)
            return state
        }
    }

    // MARK: - Ordering

    func testKindsAppearInCareOrderAndQuietOrHiddenChatsNeverDo() throws {
        let updates = try hydrated.updates(detail: .full)
        XCTAssertEqual(updates.map(\.chat.threadId), [
            "t-ask-new", "t-ask-old", // needs you, newest ask first
            "t-busy", "r-busy", // working, bots before rooms
            "t-review", "r-unread", // to review, bots before rooms
        ])
        // Finch is idle and read, Ghost is hidden: neither is an update.
        XCTAssertFalse(updates.contains { $0.chat.id == "bot-idle" || $0.chat.id == "bot-hidden" })
        XCTAssertFalse(updates.contains { $0.line == "SecretTool" })
    }

    func testUpdatesFromApprovalsTheCallerHoldsAreTheSameUpdates() throws {
        // Home reads the approvals once per render and hands them in.
        var state = try hydrated
        state.streaming["t-busy"] = "half a sentence"
        for detail in [ActivityDetail.full, .hidden] {
            XCTAssertEqual(
                state.updates(detail: detail, pendingApprovals: state.pendingApprovals),
                state.updates(detail: detail)
            )
        }
    }

    func testNewestApprovalHeadsTheListAndEachChatKeepsOneRow() throws {
        let needsYou = try hydrated.updates(detail: .full).filter { $0.kind == .needsYou }
        XCTAssertEqual(needsYou.map(\.chat.name), ["Pesto", "Sage"])
        // The subtitle is the question line; the title is only its fallback.
        XCTAssertEqual(needsYou[0].line, "All gates are green on the fork")
        XCTAssertEqual(needsYou[0].card?.requestId, "req-new")
        // Sage's thread carries two pending cards; only the newest shows.
        XCTAssertEqual(needsYou[1].line, "The newest ask on this thread")
        XCTAssertEqual(needsYou[1].card?.requestId, "req-old-second")
    }

    // MARK: - Working

    func testWorkingLineFallsBackToTheLastToolNameThenWorkingDots() throws {
        let updates = try hydrated.updates(detail: .full)
        XCTAssertEqual(updates.first { $0.chat.threadId == "t-busy" }?.line, "Read")
        XCTAssertEqual(updates.first { $0.chat.threadId == "r-busy" }?.line, "Bash")

        var state = try hydrated
        state.messages["t-busy"] = [Message(id: "busy-plain", role: .bot, kind: .text, at: 7)]
        XCTAssertEqual(state.updates(detail: .full).first { $0.chat.threadId == "t-busy" }?.line, "Working…")
    }

    func testStreamingTailWinsOverToolNamesAndClampsToAFolded120Characters() throws {
        var state = try hydrated
        state.streaming["t-busy"] = String(repeating: "a", count: 100) + "\n" + String(repeating: "b", count: 50)
        let line = state.updates(detail: .full).first { $0.chat.threadId == "t-busy" }?.line
        // The tail is kept, clamped to its last 120 characters, and folded to one line.
        XCTAssertEqual(line, String(repeating: "a", count: 69) + " " + String(repeating: "b", count: 50))
    }

    func testHeldSendsReadAsCapacityWaitingPlainQueuedOrACount() throws {
        // A capacity hold names the wait it is actually in.
        var state = try hydrated
        state.pendingQueued["t-idle"] = [QueuedSend(queueId: "q-cap", text: "run the tests", reason: "capacity")]
        let capacity = try XCTUnwrap(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" })
        XCTAssertEqual(capacity.kind, .working)
        XCTAssertEqual(capacity.line, "Queued — waiting for an available slot")

        // A hold behind the running turn is simply queued.
        state.pendingQueued["t-idle"] = [QueuedSend(queueId: "q-turn", text: "run the tests", reason: "behind-turn")]
        XCTAssertEqual(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" }?.line, "Queued")

        // Two or more count themselves.
        state.pendingQueued["t-idle"] = [
            QueuedSend(queueId: "q-1", text: "first", reason: "capacity"),
            QueuedSend(queueId: "q-2", text: "second", reason: "capacity"),
        ]
        XCTAssertEqual(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" }?.line, "2 messages queued")
    }

    // MARK: - Needs you without a card

    func testWaitingOnYouIsNeedsYouWithoutAnswerPills() throws {
        var state = try hydrated
        let index = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-idle" })
        state.bots[index].tasks?[0].activity = "waiting-on-you"
        let row = try XCTUnwrap(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" })
        XCTAssertEqual(row.kind, .needsYou)
        XCTAssertEqual(row.line, "Waiting on you")
        XCTAssertNil(row.card)
    }

    // MARK: - To review

    func testToReviewLineMapsEachMessageKindAndSkipsDigests() throws {
        var state = try hydrated
        let index = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-idle" })
        state.bots[index].tasks?[0].unread = true

        func reviewLine(endingWith message: Message) throws -> String {
            state.messages["t-idle"] = [Message(id: "review-root", role: .bot, kind: .text, at: 0), message]
            let row = try XCTUnwrap(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" })
            XCTAssertEqual(row.kind, .toReview)
            return row.line
        }

        var text = Message(id: "review-text", role: .bot, kind: .text, at: 1)
        text.text = "Plain answer"
        XCTAssertEqual(try reviewLine(endingWith: text), "Plain answer")

        var options = Message(id: "review-options", role: .bot, kind: .options, at: 2)
        options.card = OptionCard(title: "Pick one", subtitle: "", options: ["A", "B"])
        XCTAssertEqual(try reviewLine(endingWith: options), "Pick one")

        var secret = Message(id: "review-secret", role: .bot, kind: .secret, at: 3)
        secret.secret = SecretRequestCardData(label: "API key")
        XCTAssertEqual(try reviewLine(endingWith: secret), "API key")

        var bare = Message(id: "review-secret-bare", role: .bot, kind: .secret, at: 4)
        bare.secret = SecretRequestCardData()
        XCTAssertEqual(try reviewLine(endingWith: bare), "Credential required")

        var activity = Message(id: "review-activity", role: .bot, kind: .activity, at: 5)
        activity.tool = ToolActivity(name: "WebSearch")
        XCTAssertEqual(try reviewLine(endingWith: activity), "WebSearch")

        let screen = Message(id: "review-screen", role: .bot, kind: .screen, at: 6)
        XCTAssertEqual(try reviewLine(endingWith: screen), "Screenshot")

        var compaction = Message(id: "review-compaction", role: .bot, kind: .compaction, at: 7)
        compaction.compaction = Compaction(summary: "Earlier turns", tokensBefore: 1234)
        let chip = try reviewLine(endingWith: compaction)
        XCTAssertTrue(chip.hasPrefix("Context compacted ·"), chip)
        XCTAssertTrue(chip.hasSuffix("tokens summarised"), chip)

        // A digest is a receipt, not something anyone said: the line is the
        // last thing that was.
        var visible = Message(id: "review-visible", role: .bot, kind: .text, at: 8)
        visible.text = "Visible before the digest"
        var digest = Message(id: "review-digest", role: .bot, kind: .digest, at: 9)
        digest.text = "[digest] · tools: 3 · reply: done"
        state.messages["t-idle"] = [visible, digest]
        let row = try XCTUnwrap(state.updates(detail: .full).first { $0.chat.threadId == "t-idle" })
        XCTAssertEqual(row.line, "Visible before the digest")
    }

    // MARK: - Activity and webhooks (MOCA-204)

    /// The line under a chat in Updates, the island, Live Activities, the
    /// widget and Walkie reads like the roster: a webhook is its task, never
    /// its envelope of delivery ids and headers.
    func testToReviewLineShowsAWebhookAsItsTaskNotItsEnvelope() throws {
        var state = try hydrated
        let index = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-idle" })
        state.bots[index].tasks?[0].unread = true
        var webhook = Message(id: "review-webhook", role: .user, kind: .text, at: 1)
        webhook.text = "[DEFAULT WEBHOOK INSTRUCTIONS]\nTriage the build failure.\n[/DEFAULT WEBHOOK INSTRUCTIONS]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nReceived: now\nDelivery ID: build-418\nEvent: build.failed\n\n{\"service\":\"checkout\"}\n[/UNTRUSTED WEBHOOK EVENT DATA]"
        state.messages["t-idle"] = [webhook]
        for detail in [ActivityDetail.full, .reduced, .hidden] {
            let row = try XCTUnwrap(state.updates(detail: detail).first { $0.chat.threadId == "t-idle" })
            XCTAssertEqual(row.line, "Triage the build failure.", "\(detail)")
        }
    }

    /// A reader who turned activity off has said no tool calls, and a tool
    /// call's name is often a raw shell command. Hidden means hidden on these
    /// surfaces too; a status notice still says what the bot is doing.
    func testHiddenActivityKeepsToolStepsOffTheUpdateLines() throws {
        var state = try hydrated
        XCTAssertEqual(state.updates(detail: .full).first { $0.chat.threadId == "t-busy" }?.line, "Read")
        XCTAssertEqual(state.updates(detail: .hidden).first { $0.chat.threadId == "t-busy" }?.line, "Working…")
        XCTAssertEqual(state.updates(detail: .hidden).first { $0.chat.threadId == "r-busy" }?.line, "Working…")

        var notice = Message(id: "busy-notice", role: .bot, kind: .activity, at: 9)
        notice.tool = ToolActivity(name: "notice: Qwen hit a rate limit and is retrying")
        state.messages["t-busy"] = [notice]
        XCTAssertEqual(
            state.updates(detail: .hidden).first { $0.chat.threadId == "t-busy" }?.line,
            "notice: Qwen hit a rate limit and is retrying"
        )

        let index = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-idle" })
        state.bots[index].tasks?[0].unread = true
        var answer = Message(id: "review-answer", role: .bot, kind: .text, at: 1)
        answer.text = "Deployed to staging"
        var command = Message(id: "review-command", role: .bot, kind: .activity, at: 2)
        command.tool = ToolActivity(name: "/bin/zsh -lc \"kubectl rollout status deploy/web\"", ok: true)
        state.messages["t-idle"] = [answer, command]
        XCTAssertEqual(state.updates(detail: .hidden).first { $0.chat.threadId == "t-idle" }?.line, "Deployed to staging")
        XCTAssertEqual(
            state.updates(detail: .full).first { $0.chat.threadId == "t-idle" }?.line,
            "/bin/zsh -lc \"kubectl rollout status deploy/web\""
        )
    }
}
