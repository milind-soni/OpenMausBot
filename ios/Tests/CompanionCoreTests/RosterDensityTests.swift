// What a home-list row shows at each density, without a screen.
//
// Compact is one line per bot: no preview, a "› N" control only where there
// is a list to open, and status as small marks. Comfortable is the original
// two-line row with its "Threads" disclosure beneath every bot. Both read
// the same facts, so switching density never changes what a bot is doing.
import XCTest
@testable import CompanionCore

final class RosterDensityTests: XCTestCase {
    // MARK: - The setting

    func testCompactIsTheDefault() {
        XCTAssertEqual(RosterDensity.default, .compact)
        XCTAssertEqual(RosterDensity(stored: nil), .compact)
    }

    func testStoredChoicesRoundTrip() {
        for density in RosterDensity.allCases {
            XCTAssertEqual(RosterDensity(stored: density.rawValue), density)
        }
        XCTAssertEqual(RosterDensity.allCases, [.comfortable, .compact])
    }

    /// The desktop also stores "icons"; a phone has no avatars-only mode, and
    /// a value it cannot read must land on the default, not on comfortable.
    func testUnreadableStoredValuesFallBackToCompact() {
        XCTAssertEqual(RosterDensity(stored: "icons"), .compact)
        XCTAssertEqual(RosterDensity(stored: ""), .compact)
        XCTAssertEqual(RosterDensity(stored: "Compact"), .compact)
    }

    // MARK: - Thread count behind "› N"

    func testThreadCountMatchesTheTreeAndSkipsRoutineRuns() {
        let bot = bot(tasks: [task("a"), task("b"), task("run", routine: true)])
        XCTAssertEqual(bot.rosterThreadCount(), 2)
    }

    func testThreadCountLeavesOutFoldedThreadsLikeTheTree() {
        var closed = task("closed")
        closed.closedBy = ThreadCloser(botId: "pm", name: "PM", at: 1)
        var archived = task("archived")
        archived.archivedAt = 1
        let bot = bot(tasks: [task("a"), closed, archived])
        XCTAssertEqual(bot.rosterThreadCount(), 1)
    }

    /// A closed thread holding a queued send stays in the tree, so it counts.
    func testThreadCountKeepsAFoldedThreadWithAHeldSend() {
        var closed = task("closed")
        closed.closedBy = ThreadCloser(botId: "pm", name: "PM", at: 1)
        let bot = bot(tasks: [task("a"), closed])
        XCTAssertEqual(bot.rosterThreadCount(queuedThreadIds: ["closed"]), 2)
    }

    /// Older computers send no task list: that is one conversation.
    func testLegacyBotWithoutTasksHasOneThread() {
        var legacy = bot(tasks: [])
        legacy.tasks = nil
        XCTAssertEqual(legacy.rosterThreadCount(), 1)
    }

    // MARK: - Status

    func testIdleBotHasNoStatus() {
        XCTAssertEqual(bot(tasks: [task("a")]).rosterStatus(hasPendingCard: false), .idle)
    }

    func testAnyWorkingThreadMakesTheBotWork() {
        var background = task("b")
        background.activity = "working"
        XCTAssertEqual(bot(tasks: [task("a"), background]).rosterStatus(hasPendingCard: false), .working)

        var busy = bot(tasks: [task("a")])
        busy.busy = true
        XCTAssertEqual(busy.rosterStatus(hasPendingCard: false), .working)
    }

    /// The harness counts waiting-on-you as busy. The person comes first.
    func testWaitingOnYouOutranksWorking() {
        var waiting = task("a")
        waiting.activity = "waiting-on-you"
        waiting.busy = true
        var bot = bot(tasks: [waiting])
        bot.busy = true
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: false), .waitingOnYou)
    }

    func testAnUnansweredCardMeansWaitingOnYou() {
        var bot = bot(tasks: [task("a")])
        bot.busy = true
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: true), .waitingOnYou)
    }

    /// A teammate wait is a quiet wait, never the work spinner.
    func testTeammateWaitIsNotWork() {
        var waiting = task("a")
        waiting.busy = true
        waiting.activity = "working"
        waiting.waitingOnTeammate = true
        var bot = bot(tasks: [waiting])
        bot.busy = true
        bot.waitingOnTeammate = true
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: false), .idle)
    }

    func testRoutineRunsDoNotMakeTheRowWork() {
        var run = task("run", routine: true)
        run.busy = true
        XCTAssertEqual(bot(tasks: [task("a"), run]).rosterStatus(hasPendingCard: false), .idle)
    }

    // MARK: - Compact row

    func testCompactRowIsOneLineWithoutAPreview() {
        let row = RosterBotRow(bot: bot(tasks: [task("a")]), density: .compact, hasPendingCard: false)
        XCTAssertFalse(row.showsPreview)
        XCTAssertFalse(row.showsThreadsRow)
    }

    func testSingleThreadBotHasNoThreadControl() {
        let row = RosterBotRow(bot: bot(tasks: [task("a")]), density: .compact, hasPendingCard: false)
        XCTAssertEqual(row.threadCount, 1)
        XCTAssertFalse(row.showsThreadControl)
        XCTAssertFalse(row.listsThreads(expanded: true, searching: false))
        XCTAssertFalse(row.endsWithNewThread(expanded: true, searching: false))
    }

    func testMultiThreadBotOpensItsListWithNewThreadAtTheEnd() {
        let row = RosterBotRow(bot: bot(tasks: [task("a"), task("b")]), density: .compact, hasPendingCard: false)
        XCTAssertTrue(row.showsThreadControl)
        XCTAssertEqual(row.threadCount, 2)
        XCTAssertFalse(row.listsThreads(expanded: false, searching: false))
        XCTAssertTrue(row.listsThreads(expanded: true, searching: false))
        XCTAssertTrue(row.endsWithNewThread(expanded: true, searching: false))
        XCTAssertFalse(row.endsWithNewThread(expanded: false, searching: false))
    }

    /// Search lists what matched under every bot, as the desktop does;
    /// results are not a place to create a thread.
    func testSearchListsMatchesWithoutNewThread() {
        let single = RosterBotRow(bot: bot(tasks: [task("a")]), density: .compact, hasPendingCard: false)
        XCTAssertTrue(single.listsThreads(expanded: false, searching: true))
        XCTAssertFalse(single.endsWithNewThread(expanded: false, searching: true))

        let multi = RosterBotRow(bot: bot(tasks: [task("a"), task("b")]), density: .compact, hasPendingCard: false)
        XCTAssertTrue(multi.listsThreads(expanded: true, searching: true))
        XCTAssertFalse(multi.endsWithNewThread(expanded: true, searching: true))
    }

    func testCompactWorkingRowSwapsTheTimeForASpinner() {
        var working = bot(tasks: [task("a")])
        working.busy = true
        let row = RosterBotRow(bot: working, density: .compact, hasPendingCard: false)
        XCTAssertTrue(row.showsSpinner)
        XCTAssertFalse(row.showsTime)
    }

    func testCompactWaitingRowKeepsItsTimeAndShowsTheHand() {
        var waiting = task("a")
        waiting.activity = "waiting-on-you"
        var bot = bot(tasks: [waiting])
        bot.busy = true
        let row = RosterBotRow(bot: bot, density: .compact, hasPendingCard: false)
        XCTAssertTrue(row.showsWaiting)
        XCTAssertFalse(row.showsSpinner)
        XCTAssertTrue(row.showsTime)
    }

    func testChiefOfStaffIsMarkedInCompactOnly() {
        var chief = bot(tasks: [task("a")])
        chief.chiefOfStaff = true
        XCTAssertTrue(RosterBotRow(bot: chief, density: .compact, hasPendingCard: false).showsChiefBadge)
        XCTAssertFalse(RosterBotRow(bot: chief, density: .comfortable, hasPendingCard: false).showsChiefBadge)
        XCTAssertFalse(RosterBotRow(bot: bot(tasks: [task("a")]), density: .compact, hasPendingCard: false).showsChiefBadge)
    }

    /// The dot stays as it was: hidden while the bot works.
    func testUnreadDotHidesWhileWorking() {
        var unread = bot(tasks: [task("a")])
        unread.unread = true
        XCTAssertTrue(RosterBotRow(bot: unread, density: .compact, hasPendingCard: false).showsUnreadDot)
        unread.busy = true
        XCTAssertFalse(RosterBotRow(bot: unread, density: .compact, hasPendingCard: false).showsUnreadDot)
    }

    // MARK: - Comfortable row keeps what shipped

    func testComfortableKeepsPreviewTimeAndThreadsRow() {
        var working = bot(tasks: [task("a")])
        working.busy = true
        let row = RosterBotRow(bot: working, density: .comfortable, hasPendingCard: false)
        XCTAssertTrue(row.showsPreview)
        XCTAssertTrue(row.showsThreadsRow)
        XCTAssertTrue(row.showsTime)
        XCTAssertTrue(row.showsSpinner)
        XCTAssertFalse(row.showsThreadControl)
        XCTAssertFalse(row.endsWithNewThread(expanded: true, searching: false))
    }

    // MARK: - The preview fixture the UI tests and screenshots use

    func testRosterPreviewCoversEveryCompactState() throws {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let data = try Data(contentsOf: iosDirectory.appendingPathComponent("App/RosterPreview.json"))
        var state = CompanionState()
        state.hydrate(try JSONDecoder().decode(Fleet.self, from: data))
        let queued = state.queuedThreadIds

        XCTAssertEqual(state.unsectionedChief?.id, "roster-atlas")
        XCTAssertEqual(try XCTUnwrap(state.bot("roster-atlas")).rosterThreadCount(queuedThreadIds: queued), 1)
        XCTAssertEqual(try XCTUnwrap(state.bot("roster-pepper")).rosterThreadCount(queuedThreadIds: queued), 3)
        XCTAssertEqual(try XCTUnwrap(state.bot("roster-quill")).rosterThreadCount(queuedThreadIds: queued), 2)
        XCTAssertEqual(try XCTUnwrap(state.bot("roster-scout")).rosterStatus(hasPendingCard: false), .waitingOnYou)
        XCTAssertEqual(try XCTUnwrap(state.bot("roster-forge")).rosterStatus(hasPendingCard: false), .working)
        XCTAssertFalse(state.pinnedBots.isEmpty)
        XCTAssertFalse(state.unsectionedChannels.isEmpty)
        XCTAssertFalse(state.botChats.isEmpty)
        XCTAssertTrue(state.sidebarSections.contains { !$0.chiefs.isEmpty && !$0.channels.isEmpty })
        // No pending card: the needs-you island would cover the roster in
        // screenshots and swallow the UI tests' first taps.
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }

    // MARK: - Helpers

    private func task(_ id: String, routine: Bool = false) -> BotTask {
        var task = BotTask(threadId: id, title: id, createdAt: 1)
        if routine { task.routineRunId = "run-\(id)" }
        return task
    }

    private func bot(tasks: [BotTask]) -> Bot {
        Bot(
            id: "bot", threadId: tasks.first?.threadId ?? "bot-thread", name: "Bot", title: "Helper",
            description: "", notifications: true, color: "blue", unread: false,
            modelSelection: ModelSelection(instanceId: "i", model: "m"), createdAt: 1,
            tasks: tasks
        )
    }
}
