import XCTest
@testable import CompanionCore

final class WalkieTests: XCTestCase {
    private func text(_ id: String, _ body: String, role: Message.Role = .bot) -> Message {
        var message = Message(id: id, role: role, kind: .text, at: 0)
        message.text = body
        return message
    }

    private func card(_ id: String, title: String, subtitle: String) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: 0)
        message.card = OptionCard(title: title, subtitle: subtitle, options: ["Yes", "No"])
        return message
    }

    // MARK: - settledReply

    func testNothingNewMeansNoReply() {
        let transcript = [text("a", "Earlier answer")]
        XCTAssertNil(Walkie.settledReply(transcript: transcript, baseline: ["a"], busy: false))
    }

    func testWaitsWhileTheBotIsStillWorking() {
        let transcript = [text("a", "Old"), text("b", "Half an answer")]
        XCTAssertNil(Walkie.settledReply(transcript: transcript, baseline: ["a"], busy: true))
    }

    func testReturnsEveryNewBotTextOnceTheTurnSettles() {
        let transcript = [
            text("a", "Old"),
            text("u", "What did Codu find?", role: .user),
            text("b", "Canvas one passed."),
            text("c", "Canvas two is next."),
        ]
        XCTAssertEqual(
            Walkie.settledReply(transcript: transcript, baseline: ["a"], busy: false),
            "Canvas one passed.\n\nCanvas two is next."
        )
    }

    func testIgnoresYourOwnWordsAndToolActivity() {
        var tool = Message(id: "t", role: .bot, kind: .activity, at: 0)
        tool.text = "Ran tests"
        let transcript = [text("u", "Ship it", role: .user), tool]
        XCTAssertNil(Walkie.settledReply(transcript: transcript, baseline: [], busy: false))
    }

    func testAQuestionCardIsSpokenEvenWhileTheTurnIsHeldOpen() {
        let transcript = [card("q", title: "Send the Slack summary?", subtitle: "To #design")]
        XCTAssertEqual(
            Walkie.settledReply(transcript: transcript, baseline: [], busy: true),
            "Send the Slack summary? To #design"
        )
    }

    // MARK: - speakable

    func testStripsMarkdownEmphasisHeadingsAndBullets() {
        let spoken = Walkie.speakable("## Status\n- **Codu** passed _canvas one_\n- Maily is ~~late~~ done")
        XCTAssertEqual(spoken, "Status. Codu passed canvas one. Maily is late done.")
    }

    func testReadsLinkTextNotAddresses() {
        XCTAssertEqual(
            Walkie.speakable("See [the report](https://example.com/r) or https://example.com/raw"),
            "See the report or a link."
        )
    }

    func testSkipsCodeBlocksButKeepsInlineCode() {
        let spoken = Walkie.speakable("Run `pnpm test` first.\n```sh\npnpm test\n```\nThen ship.")
        XCTAssertEqual(spoken, "Run pnpm test first. Code omitted. Then ship.")
    }

    func testLongRepliesStopAtASentenceAndPointToTheChat() {
        let long = Array(repeating: "This sentence is here to make the reply long.", count: 30).joined(separator: " ")
        let spoken = Walkie.speakable(long, limit: 120)
        XCTAssertTrue(spoken.hasSuffix("The rest is in the chat."), spoken)
        XCTAssertLessThanOrEqual(spoken.count, 120 + " The rest is in the chat.".count)
        XCTAssertTrue(spoken.hasPrefix("This sentence is here to make the reply long."))
    }
}
