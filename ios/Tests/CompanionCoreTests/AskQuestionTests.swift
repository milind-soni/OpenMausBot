import XCTest

@testable import CompanionCore

/// A structured ask (Claude's `AskUserQuestion`) as the harness puts it on a
/// card, and the answer text the phone sends back for it.
///
/// The answer format is pinned against `shared/ask-question.ts` rather than
/// invented here: the model receives this text as its tool result, and an
/// answer given on the phone must be indistinguishable from one given on the
/// Mac. If the two ever disagree, this test is the one that says so.
final class AskQuestionTests: XCTestCase {
    private let payload = #"""
    {
      "title": "Your bot has a question",
      "subtitle": "Which model should Hazelnut run on by default?",
      "options": ["Claude Opus 5", "Gemini"],
      "requestId": "req-1",
      "questionRequest": {
        "version": 1,
        "questions": [
          {
            "question": "Which model should Hazelnut run on by default?",
            "header": "Model",
            "multiSelect": false,
            "options": [
              {"label": "Claude Opus 5", "description": "What the bot had before."},
              {"label": "Gemini"}
            ]
          },
          {
            "question": "Which stores may it order from?",
            "header": "Stores",
            "multiSelect": true,
            "options": [{"label": "Instamart"}, {"label": "Blinkit"}]
          }
        ]
      }
    }
    """#

    private func card() throws -> OptionCard {
        try JSONDecoder().decode(OptionCard.self, from: Data(payload.utf8))
    }

    func testDecodesTheModelsQuestionsAndTheirOptions() throws {
        let card = try card()
        XCTAssertEqual(card.questions.count, 2)
        XCTAssertEqual(card.questions.first?.header, "Model")
        XCTAssertEqual(card.questions.first?.options.first?.label, "Claude Opus 5")
        XCTAssertEqual(card.questions.first?.options.first?.detail, "What the bot had before.")
        XCTAssertNil(card.questions.first?.options.last?.detail)
        XCTAssertFalse(card.questions[0].allowsMultiple)
        XCTAssertTrue(card.questions[1].allowsMultiple)
    }

    func testAStructuredAskIsAQuestion() throws {
        let card = try card()
        // `tool` is what tells a permission from a question, and the harness
        // leaves it off a structured ask precisely so no allow/deny is
        // offered for one. The broker rejects any behavior but "answer".
        XCTAssertFalse(card.isPermission)
        XCTAssertEqual(OptionCard.responseBehavior(for: "anything", isPermission: card.isPermission), "answer")
    }

    func testAnOrdinaryCardHasNoQuestions() throws {
        let approval = #"""
        {"title": "Approval needed", "subtitle": "git push", "options": ["Allow", "Deny"],
         "requestId": "req-2", "tool": "Bash"}
        """#
        let card = try JSONDecoder().decode(OptionCard.self, from: Data(approval.utf8))
        XCTAssertTrue(card.questions.isEmpty, "an approval must keep the ordinary card")
        XCTAssertTrue(card.isPermission)
    }

    func testDecodesAQuestionThatOffersNoOptions() throws {
        // Free text still answers it, so a missing list must not fail the
        // whole transcript decode.
        let sparse = #"""
        {"title": "t", "subtitle": "s", "options": [], "requestId": "r",
         "questionRequest": {"questions": [{"question": "Which account?"}]}}
        """#
        let card = try JSONDecoder().decode(OptionCard.self, from: Data(sparse.utf8))
        XCTAssertEqual(card.questions.first?.options, [])
        XCTAssertEqual(card.questions.first?.tabLabel(position: 1), "Question 1")
    }

    func testFormatsTheAnswerTheModelWillRead() throws {
        let card = try card()
        let answer = AskQuestionAnswer.format(
            questions: card.questions,
            answers: [["Claude Opus 5"], ["Instamart", "Blinkit"]]
        )
        XCTAssertEqual(
            answer,
            """
            The user answered your questions.

            Q: Which model should Hazelnut run on by default?
            A: Claude Opus 5

            Q: Which stores may it order from?
            A: Instamart, Blinkit
            """
        )
    }

    func testOmitsAnUnansweredQuestionRatherThanImplyingOne() throws {
        let card = try card()
        let answer = AskQuestionAnswer.format(questions: card.questions, answers: [["Gemini"], ["   "]])
        XCTAssertEqual(answer, "The user answered your questions.\n\nQ: Which model should Hazelnut run on by default?\nA: Gemini")
        XCTAssertEqual(AskQuestionAnswer.format(questions: card.questions, answers: [[], []]), "",
                       "nothing answered means nothing is sent")
    }

    func testSettledCardDropsTheModelFacingLeadIn() throws {
        let card = try card()
        let answer = AskQuestionAnswer.format(questions: card.questions, answers: [["Gemini"], ["Instamart"]])
        XCTAssertFalse(AskQuestionAnswer.withoutPreamble(answer).hasPrefix(AskQuestionAnswer.preamble))
        XCTAssertTrue(AskQuestionAnswer.withoutPreamble(answer).hasPrefix("Q: "))
        XCTAssertEqual(AskQuestionAnswer.withoutPreamble("Tea"), "Tea")
    }

    func testCarriesTheAnsweredTextTheHarnessRecords() throws {
        let settled = #"""
        {"title": "t", "subtitle": "s", "options": [], "requestId": "r", "answered": "answer",
         "answeredText": "The user answered your questions.\n\nQ: Which model?\nA: Gemini",
         "questionRequest": {"version": 1, "questions": [{"question": "Which model?", "options": []}]}}
        """#
        let card = try JSONDecoder().decode(OptionCard.self, from: Data(settled.utf8))
        XCTAssertFalse(card.isPending)
        XCTAssertEqual(AskQuestionAnswer.withoutPreamble(try XCTUnwrap(card.answeredText)),
                       "Q: Which model?\nA: Gemini")
    }
}
