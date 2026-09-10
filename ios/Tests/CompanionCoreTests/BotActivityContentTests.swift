import XCTest
@testable import CompanionCore

final class BotActivityContentTests: XCTestCase {
    private func card(_ requestId: String = "request") -> OptionCard {
        OptionCard(title: "Run shell?", subtitle: "echo hello", options: ["Allow", "Deny"], requestId: requestId, tool: "shell")
    }

    private func content(threadId: String = "thread-a", card: OptionCard? = nil, kind: String = "needsYou") -> BotActivityContent {
        BotActivityContent(
            face: "waiting", kind: kind, headline: "Pepper needs you", line: "echo hello",
            threadId: threadId, card: card ?? self.card(), since: Date(timeIntervalSince1970: 0)
        )
    }

    func testReusedActivityTargetsCurrentSiblingThreadEvenWhenRequestIdIsTheSame() throws {
        // The per-bot activity began on A. Updating its content to B must
        // move the button too; immutable activity attributes cannot do this.
        let original = content(threadId: "thread-a")
        let sibling = content(threadId: "thread-b")
        let rendered = try JSONDecoder().decode(BotActivityContent.self, from: JSONEncoder().encode(sibling))
        XCTAssertNotEqual(original, sibling, "A thread change must send an activity update")
        XCTAssertEqual(rendered.approvalThreadId, "thread-b")
        XCTAssertTrue(rendered.canAnswer(threadId: "thread-b", requestId: "request", choice: "Allow", isPermission: true))
        XCTAssertFalse(rendered.canAnswer(threadId: "thread-a", requestId: "request", choice: "Allow", isPermission: true))
    }

    func testLegacyActivityDecodesButCannotAnswerUsingOriginalAttributes() throws {
        let legacy = """
        {"face":"waiting","kind":"needsYou","headline":"Pepper needs you","line":"echo hello",
        "requestId":"request","options":["Allow","Deny"],"isPermission":true,"since":0}
        """
        let rendered = try JSONDecoder().decode(BotActivityContent.self, from: Data(legacy.utf8))
        XCTAssertEqual(rendered.headline, "Pepper needs you")
        XCTAssertNil(rendered.threadId)
        XCTAssertNil(rendered.approvalThreadId)
        XCTAssertFalse(rendered.canAnswer(threadId: "original-thread", requestId: "request", choice: "Allow", isPermission: true))
    }

    func testStaleOrChangedIntentCannotAnswer() {
        let current = content(card: card("new-request"))
        XCTAssertFalse(current.canAnswer(threadId: "thread-a", requestId: "old-request", choice: "Allow", isPermission: true))
        XCTAssertFalse(current.canAnswer(threadId: "thread-a", requestId: "new-request", choice: "Always allow", isPermission: true))
        XCTAssertFalse(current.canAnswer(threadId: "thread-a", requestId: "new-request", choice: "Allow", isPermission: false))
        XCTAssertTrue(current.canAnswer(threadId: "thread-a", requestId: "new-request", choice: "Deny", isPermission: true))
    }

    func testQuestionKeepsItsExactChoicesAndResponseKind() {
        let question = OptionCard(title: "Which?", subtitle: "", options: ["First", "Second"], requestId: "question")
        let current = content(card: question)
        XCTAssertTrue(current.canAnswer(threadId: "thread-a", requestId: "question", choice: "Second", isPermission: false))
        XCTAssertFalse(current.canAnswer(threadId: "thread-a", requestId: "question", choice: "Allow", isPermission: true))
    }

    func testAnsweredDismissedAndWorkingStatesOfferNoAction() {
        var answered = card()
        answered.answered = "Allow"
        var dismissed = card()
        dismissed.dismissed = true
        for current in [content(card: answered), content(card: dismissed), content(kind: "working")] {
            XCTAssertNil(current.approvalThreadId)
            XCTAssertFalse(current.canAnswer(threadId: "thread-a", requestId: "request", choice: "Allow", isPermission: true))
        }
    }

    func testSkillApprovalStillRequiresOpeningTheChat() throws {
        let payload = """
        {"title":"Enable skill?","subtitle":"Review this skill","options":["Enable","Deny"],
        "requestId":"skill","tool":"stage_skill","skillRequest":{
        "version":1,"requestId":"skill","botId":"pepper","threadId":"thread-b","stagedId":"staged",
        "action":"create","name":"verify","gist":"Verify the app","warnings":[],"createdAt":0}}
        """
        let skill = try JSONDecoder().decode(OptionCard.self, from: Data(payload.utf8))
        let current = content(threadId: "thread-b", card: skill)
        XCTAssertEqual(current.threadId, "thread-b")
        XCTAssertEqual(current.requestId, "skill", "Keep the alert visible")
        XCTAssertTrue(current.options.isEmpty)
        XCTAssertNil(current.approvalThreadId)
    }

    func testEmptyTargetOrRequestCannotOfferButtons() {
        XCTAssertNil(content(threadId: "").approvalThreadId)
        XCTAssertNil(content(card: card("")).approvalThreadId)
    }
}
