// How many faces move at once in comfortable Home, and which.
import XCTest
@testable import CompanionCore

final class MotionTurnsTests: XCTestCase {
    func testTheFirstToAskMoveAndTheRestWait() {
        var turns = MotionTurns<String>(limit: 2)
        for id in ["a", "b", "c", "d"] { turns.ask(id) }

        XCTAssertEqual(["a", "b", "c", "d"].map(turns.moves), [true, true, false, false])
        XCTAssertFalse(turns.moves("never-asked"))
    }

    func testLeavingHandsTheTurnToTheNextInTheOrderAsked() {
        var turns = MotionTurns<String>(limit: 2)
        for id in ["a", "b", "c", "d"] { turns.ask(id) }

        turns.leave("a")
        XCTAssertEqual(["b", "c", "d"].map(turns.moves), [true, true, false])
        XCTAssertFalse(turns.moves("a"))
        // Leaving twice, or without having asked, changes nothing.
        turns.leave("a")
        turns.leave("zzz")
        XCTAssertEqual(turns.queue, ["b", "c", "d"])
    }

    func testAskingAgainKeepsThePlaceAndComingBackJoinsTheEnd() {
        var turns = MotionTurns<String>(limit: 1)
        turns.ask("a")
        turns.ask("b")
        turns.ask("a")
        XCTAssertEqual(turns.queue, ["a", "b"])

        turns.leave("a")
        turns.ask("a")
        XCTAssertEqual(turns.queue, ["b", "a"])
        XCTAssertTrue(turns.moves("b"))
        XCTAssertFalse(turns.moves("a"))
    }

    func testANonPositiveLimitMovesNobody() {
        var none = MotionTurns<Int>(limit: 0)
        none.ask(1)
        XCTAssertFalse(none.moves(1))

        var negative = MotionTurns<Int>(limit: -3)
        negative.ask(1)
        XCTAssertEqual(negative.limit, 0)
        XCTAssertFalse(negative.moves(1))
    }
}
