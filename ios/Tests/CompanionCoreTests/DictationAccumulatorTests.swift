// How partial results become one transcript across recognizer restarts.
import XCTest
@testable import CompanionCore

final class DictationAccumulatorTests: XCTestCase {
    func testPartialsOfOneUtteranceReplaceEachOther() {
        var acc = DictationAccumulator()
        XCTAssertEqual(acc.accept(text: "send the", start: 0.4), "send the")
        XCTAssertEqual(acc.accept(text: "send the report", start: 0.4), "send the report")
        XCTAssertEqual(acc.accept(text: "Send the report.", start: 0.42), "Send the report.")
    }

    func testRestartAfterAPauseKeepsTheFirstUtterance() {
        var acc = DictationAccumulator()
        acc.accept(text: "Send the report", start: 0.4)
        acc.accept(text: "Send the report to Sam.", start: 0.4)
        // the recognizer starts over: a later first segment, new text
        XCTAssertEqual(acc.accept(text: "and", start: 4.1), "Send the report to Sam. and")
        XCTAssertEqual(acc.accept(text: "and copy Lee", start: 4.1), "Send the report to Sam. and copy Lee")
        XCTAssertEqual(acc.accept(text: "then", start: 9.0), "Send the report to Sam. and copy Lee then")
    }

    func testSmallDriftInStartIsARevisionNotARestart() {
        var acc = DictationAccumulator()
        acc.accept(text: "hello there", start: 1.0)
        XCTAssertEqual(acc.accept(text: "hello their friend", start: 1.3), "hello their friend")
    }

    func testMissingTimestampsAreARevision() {
        var acc = DictationAccumulator()
        acc.accept(text: "one", start: nil)
        XCTAssertEqual(acc.accept(text: "one two", start: nil), "one two")
        acc.accept(text: "one two three", start: 2.0)
        XCTAssertEqual(acc.transcript, "one two three")
    }

    func testEmptyPiecesAreDropped() {
        var acc = DictationAccumulator()
        acc.accept(text: "", start: 0.1)
        XCTAssertEqual(acc.transcript, "")
        acc.accept(text: "first", start: 0.1)
        acc.accept(text: "", start: 5.0)
        XCTAssertEqual(acc.transcript, "first")
        XCTAssertEqual(acc.accept(text: "second", start: 5.0), "first second")
    }
}
