import XCTest
@testable import CompanionCore

/// The thread states one row can render, mirroring the desktop's
/// isWorking / isWaitingOnTeammate split (50398337 and PR #1228).
final class BotTaskStatusTests: XCTestCase {
    func testWorkingIsActivityOrFlagEachAlone() {
        var flagOnly = task()
        flagOnly.busy = true
        var activityOnly = task()
        activityOnly.busy = false
        activityOnly.activity = "working"
        var idle = task()
        idle.busy = false
        idle.activity = "idle"

        XCTAssertTrue(flagOnly.isWorking)
        XCTAssertTrue(activityOnly.isWorking)
        XCTAssertFalse(idle.isWorking)
    }

    func testTeammateWaitIsAWaitNotWork() {
        var wait = task()
        wait.busy = false
        wait.activity = "idle"
        wait.waitingOnTeammate = true
        XCTAssertTrue(wait.isWaitingOnTeammate)
        XCTAssertFalse(wait.isWorking)

        var working = wait
        working.busy = true
        XCTAssertTrue(working.isWaitingOnTeammate, "The live #1228 wire paints busy, working, and the wait flag together during a coordination wait; the flag alone decides.")
        XCTAssertTrue(working.isWorking)
    }

    func testDemandsAttentionCoversEachLiveStateWithoutLumpingThem() {
        var wait = task(); wait.busy = false; wait.activity = "idle"; wait.waitingOnTeammate = true
        var working = task(); working.activity = "working"
        var waitingOnYou = task(); waitingOnYou.activity = "waiting-on-you"
        var queued = task(); queued.activity = "queued"
        var unread = task(); unread.unread = true
        var idle = task(); idle.busy = false; idle.activity = "idle"
        var noSignal = task(); noSignal.activity = "no-signal"

        for live in [wait, working, waitingOnYou, queued, unread] {
            XCTAssertTrue(live.demandsAttention(), "A live thread must stay reachable.")
        }
        XCTAssertFalse(idle.demandsAttention())
        XCTAssertFalse(noSignal.demandsAttention())
    }

    func testWaitingOnTeammateDecodesAdditively() throws {
        let wired = try JSONDecoder().decode(BotTask.self, from: Data("""
        {"threadId":"t","title":"T","createdAt":1,"busy":false,"activity":"idle","waitingOnTeammate":true}
        """.utf8))
        XCTAssertEqual(wired.waitingOnTeammate, true)
        XCTAssertFalse(wired.isWorking)
        XCTAssertTrue(wired.isWaitingOnTeammate)

        let legacy = try JSONDecoder().decode(BotTask.self, from: Data("""
        {"threadId":"t","title":"T","createdAt":1}
        """.utf8))
        XCTAssertNil(legacy.waitingOnTeammate)
    }

    func testProjectionCarriesTheWaitIntoThreadViews() throws {
        var bot = makeBot()
        bot.waitingOnTeammate = true
        var flagged = task("flagged")
        flagged.waitingOnTeammate = true
        bot.tasks = [task("other"), flagged]

        let active = try XCTUnwrap(bot.projected(forThread: "current"))
        XCTAssertEqual(active.waitingOnTeammate, true, "The active thread inherits the bot-level wait.")
        let sibling = try XCTUnwrap(bot.projected(forThread: "other"))
        XCTAssertEqual(sibling.waitingOnTeammate, false, "A sibling without the flag never inherits the bot-level wait.")
        let flaggedView = try XCTUnwrap(bot.projected(forThread: "flagged"))
        XCTAssertEqual(flaggedView.waitingOnTeammate, true, "A task's own flag survives projection.")
    }

    private func makeBot(tasks: [BotTask]? = nil) -> Bot {
        Bot(
            id: "bot", threadId: "current", name: "Scout", title: "Researcher",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1,
            tasks: tasks
        )
    }

    private func task(_ id: String = "t") -> BotTask {
        BotTask(threadId: id, title: id, createdAt: 1)
    }
}
