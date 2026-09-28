import XCTest
@testable import CompanionCore

final class AttentionInboxTests: XCTestCase {
    func testCollectsOnlyAttentionThreadsWaitingFirstAcrossBots() {
        let alpha = bot("a", "Alpha", "a0", tasks: [
            task("a0", "Idle chat"),
            task("a1", "Waiting approval", activity: "waiting-on-you"),
            task("a2", "Unread reply", unread: true),
        ])
        let beta = bot("b", "Beta", "b0", tasks: [
            task("b0", "Building site", busy: true, activity: "working"),
            task("b1", "Wrapped long ago"),
        ])

        let entries = crossBotAttentionThreads([alpha, beta], exceptBotId: "current")
        XCTAssertEqual(entries.map(\.task.threadId), ["a1", "b0", "a2"])
        XCTAssertEqual(entries.map(\.botName), ["Alpha", "Beta", "Alpha"])
    }

    func testExcludesTheExceptedBotAndKeepsQueuedThreads() {
        let alpha = bot("a", "Alpha", "a0", tasks: [
            task("a0", "Waiting approval", activity: "waiting-on-you"),
        ])
        let beta = bot("b", "Beta", "b0", tasks: [
            task("b0", "Queued job", activity: "queued"),
        ])

        let entries = crossBotAttentionThreads([alpha, beta], exceptBotId: "a")
        XCTAssertEqual(entries.map(\.task.threadId), ["b0"])
    }

    func testFallsBackToTheBotsOwnLineWhenItHasNoTaskListYet() {
        let solo = bot("s", "Solo", "s0", unread: true)
        XCTAssertEqual(crossBotAttentionThreads([solo]).map(\.task.threadId), ["s0"])

        var quiet = solo
        quiet.unread = false
        XCTAssertTrue(crossBotAttentionThreads([quiet]).isEmpty)
    }

    func testNeverOffersAHiddenBotOrARoutineRun() {
        let hidden = bot("h", "Hidden", "h0", tasks: [
            task("h0", "Waiting", activity: "waiting-on-you"),
        ])
        var hiddenBot = hidden
        hiddenBot.hidden = true
        let runner = bot("r", "Runner", "r0", tasks: [
            task("r0", "Routine step", busy: true, routineRunId: "run-1"),
        ])
        let plain = bot("p", "Plain", "p0", tasks: [
            task("p0", "Unread note", unread: true),
        ])

        XCTAssertEqual(crossBotAttentionThreads([hiddenBot, runner, plain]).map(\.task.threadId), ["p0"])
    }

    func testOrdersWaitingAheadOfUnreadAcrossBotsNotJustInsideOne() {
        let alpha = bot("a", "Alpha", "a0", tasks: [task("a0", "Unread reply", unread: true)])
        let beta = bot("b", "Beta", "b0", tasks: [task("b0", "Waiting approval", activity: "waiting-on-you")])

        XCTAssertEqual(crossBotAttentionThreads([alpha, beta]).map(\.task.threadId), ["b0", "a0"])
    }

    func testEqualRanksKeepStoredOrderAcrossBots() {
        let alpha = bot("a", "Alpha", "a0", tasks: [task("a0", "First unread", unread: true)])
        let beta = bot("b", "Beta", "b0", tasks: [task("b0", "Second unread", unread: true)])

        XCTAssertEqual(crossBotAttentionThreads([alpha, beta]).map(\.task.threadId), ["a0", "b0"])
    }

    func testAttentionRowTapResolvesTheChatDestinationBot() {
        let alpha = bot("a", "Alpha", "a0", tasks: [
            task("a0", "Idle chat"),
            task("a1", "Waiting approval", activity: "waiting-on-you"),
        ])
        var state = CompanionState()
        state.bots = [alpha]

        let entry = crossBotAttentionThreads([alpha]).first { $0.task.threadId == "a1" }
        let destination = entry?.destinationBot(in: state)

        XCTAssertEqual(destination?.id, "a")
        XCTAssertEqual(destination?.threadId, "a1")
    }

    func testAttentionRowTapIsASafeNoOpWhenTheBotIsMissing() {
        let gone = bot("g", "Gone", "g0", tasks: [task("g0", "Waiting", activity: "waiting-on-you")])
        guard let entry = crossBotAttentionThreads([gone]).first else {
            return XCTFail("the waiting thread should appear in the attention list")
        }
        var state = CompanionState()
        state.bots = []

        XCTAssertNil(entry.destinationBot(in: state))
    }

    private func task(
        _ id: String, _ title: String,
        busy: Bool? = false, activity: String? = nil,
        unread: Bool? = false, routineRunId: String? = nil
    ) -> BotTask {
        var task = BotTask(threadId: id, title: title, createdAt: 0)
        task.busy = busy
        task.activity = activity
        task.unread = unread
        task.routineRunId = routineRunId
        return task
    }

    private func bot(
        _ id: String, _ name: String, _ threadId: String,
        tasks: [BotTask]? = nil, unread: Bool = false
    ) -> Bot {
        var bot = Bot(
            id: id, threadId: threadId, name: name, title: name,
            description: "", notifications: true, color: "green", unread: unread,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"),
            createdAt: 0, tasks: tasks
        )
        return bot
    }
}
