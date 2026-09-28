// The roster's one-line preview, at each activity level.
//
// Reported from the beta: with Activity set to Hidden, a roster row still
// read `auto-approved shell: export PATH="/opt/h...`. The transcript was
// folding correctly and the roster was not, because the preview came off
// the raw last message and never saw the setting.
import XCTest
@testable import CompanionCore

final class RosterPreviewTests: XCTestCase {
    private func text(_ id: String, _ body: String, at: Double = 1) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = body
        return message
    }

    private func activity(_ id: String, _ name: String, at: Double = 1, ok: Bool? = true) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, ok: ok)
        return message
    }

    /// What the harness appends after every settled turn: a work receipt,
    /// decoded from the wire exactly as it arrives.
    private func digest(_ id: String, at: Double = 1) -> Message {
        let json = """
        {"id":"\(id)","role":"bot","kind":"digest","at":\(at),"text":"[digest] · tools: /bin/bash -lc 'composio search' ×1 · reply: Done."}
        """
        return try! JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    /// `pending` needs a requestId — that is what makes a card answerable
    /// rather than transcript, and it decides subtitle vs title.
    private func card(_ id: String, title: String, subtitle: String, at: Double = 1, pending: Bool = true) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: at)
        var card = OptionCard(title: title, subtitle: subtitle, options: ["Allow", "Deny"])
        if pending { card.requestId = "req-\(id)" }
        message.card = card
        return message
    }

    // MARK: - Full keeps what shipped

    func testFullShowsTheToolNameWhenActivityLanded() {
        let messages = [text("a", "hello"), activity("b", "auto-approved shell: export PATH=…")]
        XCTAssertEqual(rosterPreview(messages, detail: .full), "auto-approved shell: export PATH=…")
    }

    // MARK: - Hidden — the reported bug

    func testHiddenFallsBackToTheLastRealMessage() {
        // The bug: this returned the tool name.
        let messages = [text("a", "Deployed to staging"), activity("b", "auto-approved shell: export PATH=…")]
        XCTAssertEqual(rosterPreview(messages, detail: .hidden), "Deployed to staging")
    }

    func testHiddenSkipsAWholeTrailOfActivity() {
        let messages = [
            text("a", "Deployed to staging"),
            activity("b", "shell"), activity("c", "read"), activity("d", "write"),
        ]
        XCTAssertEqual(rosterPreview(messages, detail: .hidden), "Deployed to staging")
    }

    func testHiddenShowsNothingWhenTheThreadIsOnlyActivity() {
        let messages = [activity("a", "shell"), activity("b", "read")]
        XCTAssertEqual(rosterPreview(messages, detail: .hidden), "")
    }

    func testHiddenStillShowsAPendingCard() {
        // Hiding activity must not hide the thing that needs an answer.
        let messages = [activity("a", "shell"), card("b", title: "Run this?", subtitle: "rm -rf build")]
        XCTAssertEqual(rosterPreview(messages, detail: .hidden), "rm -rf build")
    }

    func testAnAnsweredCardPreviewsAsItsTitle() {
        // Historical rather than answerable: the question, not the command.
        let messages = [card("a", title: "Run this?", subtitle: "rm -rf build", pending: false)]
        XCTAssertEqual(rosterPreview(messages, detail: .hidden), "Run this?")
    }

    // MARK: - Reduced summarises rather than hides

    func testReducedSummarisesATrailingRun() {
        let messages = [text("a", "hi"), activity("b", "shell"), activity("c", "read"), activity("d", "write")]
        XCTAssertEqual(rosterPreview(messages, detail: .reduced), "Ran 3 steps")
    }

    func testReducedSaysRunningWhileAStepIsUnfinished() {
        let messages = [activity("a", "shell"), activity("b", "read", ok: nil)]
        XCTAssertEqual(rosterPreview(messages, detail: .reduced), "Running 2 steps")
    }

    func testReducedLeavesALoneActivityAsItsToolName() {
        let messages = [text("a", "hi"), activity("b", "shell")]
        XCTAssertEqual(rosterPreview(messages, detail: .reduced), "shell")
    }

    func testReducedStillShowsAFailureRatherThanFoldingIt() {
        let messages = [activity("a", "shell"), activity("b", "deploy", ok: false)]
        XCTAssertEqual(rosterPreview(messages, detail: .reduced), "deploy")
    }

    // MARK: - Everything else is untouched by the setting

    func testTextAndScreenReadTheSameAtEveryLevel() {
        var screen = Message(id: "s", role: .bot, kind: .screen, at: 2)
        screen.text = nil
        for detail in ActivityDetail.allCases {
            XCTAssertEqual(rosterPreview([text("a", "plain words")], detail: detail), "plain words")
            XCTAssertEqual(rosterPreview([screen], detail: detail), "Screenshot")
        }
    }

    func testEmptyThreadPreviewsAsEmptyAtEveryLevel() {
        for detail in ActivityDetail.allCases {
            XCTAssertEqual(rosterPreview([], detail: detail), "")
        }
    }

    // MARK: - Digests

    func testPreviewReadsTheReplyNotTheDigestAfterIt() {
        let messages = [text("a", "Your PR is #212"), digest("b")]
        for detail in [ActivityDetail.full, .reduced, .hidden] {
            XCTAssertEqual(rosterPreview(messages, detail: detail), "Your PR is #212")
        }
    }
}
