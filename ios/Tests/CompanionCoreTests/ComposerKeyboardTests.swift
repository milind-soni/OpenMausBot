import XCTest
@testable import CompanionCore

final class ComposerKeyboardTests: XCTestCase {
    func testJapaneseKanaTypingDoesNotSubmitUntilReturn() {
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(previousText: "", proposedText: "あ"))
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(previousText: "あ", proposedText: "あい"))
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(previousText: "あい", proposedText: "あいう"))
        XCTAssertTrue(ComposerKeyboard.shouldSubmit(previousText: "あいう", proposedText: "あいう\n"))
    }

    func testSoftwareReturnAtTheEndSubmits() {
        XCTAssertTrue(ComposerKeyboard.shouldSubmit(
            previousText: "Send this",
            proposedText: "Send this\n"
        ))
    }

    func testSoftwareReturnReplacingASelectionSubmitsTheOriginalDraft() {
        XCTAssertTrue(ComposerKeyboard.shouldSubmit(
            previousText: "Send selected words",
            proposedText: "Send \n words"
        ))
    }

    func testOrdinaryTypingAndDeletionDoNotSubmit() {
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(previousText: "Send", proposedText: "Send!"))
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(previousText: "Send", proposedText: "Sen"))
    }

    func testPastingMultilineTextDoesNotSubmit() {
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(
            previousText: "First",
            proposedText: "First\nSecond"
        ))
        XCTAssertFalse(ComposerKeyboard.shouldSubmit(
            previousText: "",
            proposedText: "First\nSecond"
        ))
    }
}
