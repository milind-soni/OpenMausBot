import XCTest
@testable import CompanionCore

/// The phone's short form of an approval card: headline, summary line,
/// Details, and the settled verdict in words.
final class ApprovalCardTests: XCTestCase {
    /// The subtitle the computer writes for two held Linear comments
    /// (`server/index.ts`, outbound hold): heading, then raw arguments.
    private let linearSubtitle = """
    Linear · Create linear comment
    {"issueId":"2f04bc73","body":"**In flight** — open PR"}… [arguments truncated]

    Linear · Create linear comment
    {"issueId":"1c2755f","body":"Adjacent request from Discord"}… [arguments truncated]
    """

    private func decode(_ json: String) throws -> OptionCard {
        try JSONDecoder().decode(OptionCard.self, from: Data(json.utf8))
    }

    private func outbound(calls: [OutboundCall]?, subtitle: String? = nil, answered: String? = nil) -> OptionCard {
        var card = OptionCard(title: "Send on your behalf?", subtitle: subtitle ?? linearSubtitle, options: ["Allow", "Deny"])
        card.requestId = "req"
        card.tool = "LINEAR_CREATE_LINEAR_COMMENT"
        card.held = "This sends something on your behalf, so it always asks first."
        card.heldCode = "approval.held.outbound"
        card.outboundRequest = OutboundRequest(tool: "LINEAR_CREATE_LINEAR_COMMENT", app: "Linear", calls: calls)
        card.answered = answered
        return card
    }

    // MARK: - Decoding

    func testDecodesOutboundCallsAndTheMarkersThatPickALayout() throws {
        let card = try decode("""
        {"title":"Send on your behalf?","subtitle":"Linear · Create linear comment","options":["Allow","Deny"],
         "requestId":"r","tool":"LINEAR_CREATE_LINEAR_COMMENT","held":"x","heldCode":"approval.held.outbound",
         "outboundRequest":{"tool":"LINEAR_CREATE_LINEAR_COMMENT","app":"Linear","calls":[{"app":"Linear","label":"Create linear comment"}]}}
        """)
        XCTAssertEqual(card.outboundRequest?.calls, [OutboundCall(app: "Linear", label: "Create linear comment")])
        XCTAssertEqual(card.heldCode, "approval.held.outbound")
        XCTAssertEqual(card.presentation, .outbound)

        let memory = try decode("""
        {"title":"Remember this for the team?","subtitle":"Person: Ana — designer","options":["Remember","Skip"],
         "requestId":"m","tool":"propose_team_memory","teamMemoryRequest":{"section":"s","entryId":"m","kind":"person"}}
        """)
        XCTAssertNotNil(memory.teamMemoryRequest)
        XCTAssertEqual(memory.presentation, .standard)

        let permission = try decode("""
        {"title":"Approval needed","subtitle":"git push","options":["Allow","Deny"],"requestId":"p","requestType":"permission","tool":"Bash"}
        """)
        XCTAssertEqual(permission.presentation, .approval)
    }

    func testAnOlderCardWithoutCallsStillDecodes() throws {
        let card = try decode("""
        {"title":"Send on your behalf?","subtitle":"Gmail · Send email","options":["Allow","Deny"],
         "requestId":"r","outboundRequest":{"tool":"GMAIL_SEND_EMAIL","app":"Gmail"}}
        """)
        XCTAssertNil(card.outboundRequest?.calls)
        XCTAssertEqual(card.outboundCalls, [OutboundCall(app: "Gmail", label: "Send email")])
    }

    // MARK: - Outbound

    func testTwoCallsToOneAppCollapseWithACount() {
        let call = OutboundCall(app: "Linear", label: "Create linear comment")
        let card = outbound(calls: [call, call])
        XCTAssertEqual(card.presentation, .outbound)
        XCTAssertEqual(card.outboundApp, "Linear")
        XCTAssertEqual(card.headline, "Send to Linear?")
        XCTAssertEqual(card.summaryLine, "Create linear comment ×2")
        XCTAssertEqual(card.previewLine, "Linear · Create linear comment ×2")
        XCTAssertEqual(card.spokenLine, "Send to Linear? Create linear comment ×2")
        XCTAssertTrue(card.hasDetails, "the raw request stays one tap away")
        XCTAssertFalse(card.previewLine.contains("{"))
    }

    func testWithoutCallsTheSubtitleHeadingsAreReadBack() {
        let card = outbound(calls: nil)
        XCTAssertEqual(card.outboundCalls.count, 2)
        XCTAssertEqual(card.headline, "Send to Linear?")
        XCTAssertEqual(card.summaryLine, "Create linear comment ×2")
    }

    func testSeveralAppsUseTheGenericHeadlineAndNameEachApp() {
        let card = outbound(calls: [
            OutboundCall(app: "Gmail", label: "Send email"),
            OutboundCall(app: "Stripe", label: "Create refund"),
            OutboundCall(app: "Gmail", label: "Send email"),
        ])
        XCTAssertNil(card.outboundApp)
        XCTAssertEqual(card.headline, "Send on your behalf?")
        XCTAssertEqual(card.summaryLine, "Gmail · Send email ×2, Stripe · Create refund")
        XCTAssertEqual(card.previewLine, "Gmail · Send email ×2, Stripe · Create refund")
    }

    func testManyDistinctActionsNameThreeAndCountTheRest() {
        let calls = (1...5).map { OutboundCall(app: "Linear", label: "Action \($0)") }
        XCTAssertEqual(outbound(calls: calls).summaryLine, "Action 1, Action 2, Action 3, +2 more")
    }

    func testAnUnreadableSubtitleFallsBackToTheGenericHeadlineAndKeepsDetails() {
        let card = outbound(calls: nil, subtitle: "\n\nsomething odd")
        XCTAssertTrue(card.outboundCalls.isEmpty)
        XCTAssertEqual(card.headline, "Send on your behalf?")
        XCTAssertEqual(card.summaryLine, "")
        XCTAssertEqual(card.previewLine, "Send on your behalf?")
        XCTAssertTrue(card.hasDetails)
    }

    func testAToolWithNoAppIsNamedByItsLabel() {
        let card = outbound(calls: nil, subtitle: "Send a message\n{\"to\":\"x\"}")
        XCTAssertEqual(card.outboundCalls, [OutboundCall(app: nil, label: "Send a message")])
        XCTAssertEqual(card.headline, "Send on your behalf?")
        XCTAssertEqual(card.summaryLine, "Send a message")
    }

    func testTheHeldNoteNeverShowsOnAnOutboundCard() {
        XCTAssertFalse(outbound(calls: nil).showsHeldNote)
        XCTAssertFalse(outbound(calls: nil, answered: "allow").showsHeldNote)
    }

    // MARK: - Provider and teammate approvals

    func testAPermissionCardLeadsWithItsFirstLine() {
        var card = OptionCard(title: "Approval needed", subtitle: "git commit -m 'x' \\\n  && git push origin main", options: ["Allow", "Deny"])
        card.requestId = "p"
        card.requestType = "permission"
        card.tool = "Bash"
        card.held = "The provider requires your approval for this action."
        card.heldCode = "approval.held.native"
        XCTAssertEqual(card.presentation, .approval)
        XCTAssertEqual(card.headline, "Approval needed")
        XCTAssertEqual(card.summaryLine, "git commit -m 'x' \\")
        XCTAssertTrue(card.hasDetails)
        XCTAssertTrue(card.showsHeldNote, "while pending the note explains the stop")
        card.answered = "deny"
        XCTAssertFalse(card.showsHeldNote, "once settled it has done its job")
        XCTAssertEqual(card.outcome, .denied)
    }

    func testAOneLineRequestHasNoDetailsAndALongOneIsCut() {
        var card = OptionCard(title: "Approval needed", subtitle: "Upload build 1 to TestFlight?", options: ["Allow", "Deny"])
        card.tool = "App Store Connect"
        XCTAssertEqual(card.presentation, .approval, "older computers send no requestType")
        XCTAssertFalse(card.hasDetails)
        card.subtitle = String(repeating: "a", count: 300)
        XCTAssertEqual(card.summaryLine.count, OptionCard.summaryLimit)
        XCTAssertTrue(card.summaryLine.hasSuffix("…"))
        XCTAssertTrue(card.hasDetails)
    }

    func testATeammateApprovalIsAnApproval() {
        var card = OptionCard(title: "@Scout wants to contact @Forge", subtitle: "Can you check the build?", options: ["Allow", "Deny", "Always allow"])
        card.tool = "ask_bot"
        card.answered = "allow"
        XCTAssertEqual(card.presentation, .approval)
        XCTAssertEqual(card.outcome, .allowed)
    }

    // MARK: - Standard cards keep their layout

    func testProposalsShowInFullAndReadAsTheirOption() {
        var routine = OptionCard(title: "Create routine?", subtitle: "Every weekday at 9\nSummarise inbox", options: ["Confirm", "Cancel"])
        routine.requestId = "r"
        routine.tool = "create_routine"
        XCTAssertEqual(routine.presentation, .standard)
        XCTAssertEqual(routine.summaryLine, routine.subtitle)
        XCTAssertFalse(routine.hasDetails)
        routine.answered = "allow"
        XCTAssertEqual(routine.outcome, .chose("Confirm", positive: true))
        routine.answered = "deny"
        XCTAssertEqual(routine.outcome, .chose("Cancel", positive: false))
    }

    func testASkillCardStaysStandardEvenThoughItHasATool() {
        var skill = OptionCard(title: "Enable skill?", subtitle: "Release notes", options: ["Enable", "Deny"])
        skill.tool = "propose_skill"
        skill.skillRequest = SkillRequestCardData(
            version: 1, requestId: "s", botId: "b", threadId: "t", stagedId: "x", action: "create",
            name: "notes", gist: "g", warnings: [], createdAt: 0
        )
        XCTAssertEqual(skill.presentation, .standard)
        skill.answered = "deny"
        XCTAssertEqual(skill.outcome, .denied)
    }

    func testAnErrorWrittenAfterAProposalSettledStaysVisible() {
        var setup = OptionCard(title: "Apply setup for 2 bots?", subtitle: "…", options: ["Apply setup", "Cancel"])
        setup.tool = "set_up_team"
        setup.answered = "allow"
        setup.held = "The decision was recorded, but the Chief could not continue: offline"
        XCTAssertTrue(setup.showsHeldNote)
        XCTAssertEqual(setup.outcome, .chose("Apply setup", positive: true))
    }

    func testTeamMemoryReadsAsRememberedOrSkipped() {
        var memory = OptionCard(title: "Remember this for the team?", subtitle: "Person: Ana", options: ["Remember", "Skip"])
        memory.tool = "propose_team_memory"
        memory.teamMemoryRequest = TeamMemoryRequest(section: "s", entryId: "e", kind: "person")
        memory.answered = "allow"
        XCTAssertEqual(memory.outcome, .remembered)
        memory.answered = "deny"
        XCTAssertEqual(memory.outcome, .skipped)
    }

    // MARK: - Outcome words

    func testVerdictsReadAsWords() {
        var card = outbound(calls: nil)
        XCTAssertNil(card.outcome)
        card.answered = "allow"
        XCTAssertEqual(card.outcome, .allowed)
        XCTAssertTrue(card.outcome?.isPositive == true)
        card.answered = "deny"
        XCTAssertEqual(card.outcome, .denied)
        card.answered = "unavailable"
        XCTAssertEqual(card.outcome, .unavailable)
        XCTAssertFalse(card.outcome?.isPositive == true)
        card.answered = "Allow"
        XCTAssertEqual(card.outcome, .allowed, "case does not matter")
        card.answered = "something new"
        XCTAssertEqual(card.outcome, .other("something new"))
    }

    func testALegacyQuestionReadsAsItsAnswer() {
        var question = OptionCard(title: "Your bot has a question", subtitle: "Which branch?", options: ["main", "dev"])
        question.requestType = "question"
        question.answered = "answer"
        question.answeredText = "dev"
        XCTAssertEqual(question.presentation, .standard)
        XCTAssertEqual(question.outcome, .answered("dev"))
    }

    // MARK: - Surfaces

    func testTheRosterPreviewUsesTheShortLine() {
        var message = Message(id: "m", role: .bot, kind: .options, at: 0)
        message.card = outbound(calls: [OutboundCall(app: "Linear", label: "Create linear comment")])
        XCTAssertEqual(previewText(of: message), "Linear · Create linear comment")
        message.card?.answered = "allow"
        XCTAssertEqual(previewText(of: message), "Send to Linear?")
    }

    func testWalkieReadsTheHeadlineNotTheArguments() {
        var message = Message(id: "m", role: .bot, kind: .options, at: 0)
        message.card = outbound(calls: nil)
        let spoken = Walkie.settledReply(transcript: [message], baseline: [], busy: true)
        XCTAssertEqual(spoken, "Send to Linear? Create linear comment ×2")
    }

    // MARK: - Settled cards leave the transcript

    func testAnsweredApprovalsLeaveTheTranscriptBelowFull() {
        func row(_ id: String, _ card: OptionCard) -> Message {
            var message = Message(id: id, role: .bot, kind: .options, at: 0)
            message.card = card
            return message
        }
        var permission = OptionCard(title: "Approval needed", subtitle: "git push origin main", options: ["Allow", "Deny"])
        permission.requestId = "p"
        permission.tool = "Bash"
        permission.requestType = "permission"
        permission.answered = "allow"
        var proposal = OptionCard(title: "Add this routine?", subtitle: "Every morning", options: ["Confirm", "Cancel"])
        proposal.requestId = "r"
        proposal.answered = "Confirm"
        let messages = [
            row("sent", outbound(calls: nil, answered: "allow")),
            row("denied", permission),
            row("waiting", outbound(calls: nil)),
            row("proposal", proposal),
        ]
        for detail in [ActivityDetail.hidden, .reduced] {
            XCTAssertEqual(transcriptRows(messages, detail: detail).map(\.id), ["waiting", "proposal"], "\(detail)")
        }
        XCTAssertEqual(transcriptRows(messages, detail: .full).map(\.id), ["sent", "denied", "waiting", "proposal"])
    }
}
