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

    /// What the harness appends after every settled turn: a work receipt,
    /// decoded from the wire exactly as it arrives.
    private func digest(_ id: String, at: Double = 0) -> Message {
        let json = """
        {"id":"\(id)","role":"bot","kind":"digest","at":\(at),"text":"[digest] · tools: /bin/bash -lc 'composio search' ×1 · reply: Done."}
        """
        return try! JSONDecoder().decode(Message.self, from: Data(json.utf8))
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

    func testSpeaksTableRowsAndSkipsTheDelimiter() {
        let spoken = Walkie.speakable("""
        | Name | Status |
        | --- | --- |
        | Ada | ok |
        | x | stays |

        - [x] shipped
        - [ ] waiting
        - [X] closed
        """)
        XCTAssertEqual(spoken, "Name, Status. Ada, ok. x, stays. shipped. waiting. closed.")
    }

    func testSpeaksAWeldedTableAndDropsDelimiterParagraphs() {
        let spoken = Walkie.speakable("""
        | A | B | |---|---| | 1 | 2 |

        | :--- | ---: |

        | - | - |

        --- | ---

        * [x] star
        + [X] plus
        1. [ ] first
          - [x] nested
        The separator |---|---| is what GFM calls a delimiter row.
        """)
        XCTAssertEqual(
            spoken,
            "A, B. 1, 2. star. plus. first. nested. The separator, ---, ---, is what GFM calls a delimiter row."
        )
    }

    func testSkipsCodeBlocksButKeepsInlineCode() {
        let spoken = Walkie.speakable("Run `pnpm test` first.\n```sh\npnpm test\n```\nThen ship.")
        XCTAssertEqual(spoken, "Run pnpm test first. Code omitted. Then ship.")
    }

    // MARK: - utterances

    func testShortTextIsOneUtterance() {
        XCTAssertEqual(Walkie.utterances("Done. Shipping now."), ["Done. Shipping now."])
    }

    func testSplitsAtSentencesWithinTheLimit() {
        let parts = Walkie.utterances("One two three. Four five six. Seven eight nine.", limit: 30)
        XCTAssertEqual(parts, ["One two three. Four five six.", "Seven eight nine."])
        XCTAssertTrue(parts.allSatisfy { $0.count <= 30 })
    }

    func testARunOnSentenceSplitsAtWords() {
        let parts = Walkie.utterances("alpha beta gamma delta epsilon zeta eta theta", limit: 20)
        XCTAssertTrue(parts.allSatisfy { $0.count <= 20 }, "\(parts)")
        XCTAssertEqual(parts.joined(separator: " "), "alpha beta gamma delta epsilon zeta eta theta")
    }

    func testEmptyTextHasNothingToSay() {
        XCTAssertEqual(Walkie.utterances("   "), [])
    }

    func testLongRepliesStopAtASentenceAndPointToTheChat() {
        let long = Array(repeating: "This sentence is here to make the reply long.", count: 30).joined(separator: " ")
        let spoken = Walkie.speakable(long, limit: 120)
        XCTAssertTrue(spoken.hasSuffix("The rest is in the chat."), spoken)
        XCTAssertLessThanOrEqual(spoken.count, 120 + " The rest is in the chat.".count)
        XCTAssertTrue(spoken.hasPrefix("This sentence is here to make the reply long."))
    }

    // MARK: - Digests

    func testADigestIsNeverReadAloud() {
        let transcript = [text("a", "Old"), text("b", "Canvas one passed."), digest("c")]
        XCTAssertEqual(
            Walkie.settledReply(transcript: transcript, baseline: ["a"], busy: false),
            "Canvas one passed."
        )
    }
}
