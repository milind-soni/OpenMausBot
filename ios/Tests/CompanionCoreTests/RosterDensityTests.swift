// The list density setting, and what a compact home-list row shows,
// without a screen.
//
// Compact is one line per bot: no preview, a "› N" control only where there
// is a list to open, and status as small marks. Comfortable rows keep their
// original logic in the app target; the UI tests cover them.
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

    /// A value this build cannot read — a density a later version adds, or a
    /// damaged store — lands on the default, not on comfortable.
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

    // The current thread speaks with the bot's own activity when its entry
    // carries none: the harness can report a wait on the bot alone.

    func testBotLevelWaitingOnYouShowsTheHandNotTheSpinner() {
        var bot = bot(tasks: [task("a")])
        bot.busy = true
        bot.activity = "waiting-on-you"
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        XCTAssertEqual(row.status, .waitingOnYou)
        XCTAssertTrue(row.showsWaiting)
        XCTAssertFalse(row.showsSpinner)
    }

    func testBotLevelWorkingShowsTheSpinner() {
        var bot = bot(tasks: [task("a")])
        bot.activity = "working"
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: false), .working)
    }

    func testAThreadsOwnActivityOutranksTheBots() {
        var current = task("a")
        current.activity = "idle"
        var bot = bot(tasks: [current])
        bot.activity = "waiting-on-you"
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: false), .idle)
    }

    func testTheBotsActivitySpeaksOnlyForItsCurrentThread() {
        var current = task("a")
        current.activity = "idle"
        var bot = bot(tasks: [current, task("b")])
        bot.activity = "waiting-on-you"
        XCTAssertEqual(bot.rosterStatus(hasPendingCard: false), .idle)
    }

    /// No task list at all: the row reads the one conversation the thread
    /// tree stands in for it, with the bot's own activity.
    func testOlderComputerReadsTheConversationTheThreadTreeSynthesises() {
        var legacy = bot(tasks: [])
        legacy.tasks = nil
        legacy.busy = true
        legacy.activity = "waiting-on-you"
        XCTAssertEqual(legacy.rosterStatus(hasPendingCard: false), .waitingOnYou)
        legacy.activity = nil
        XCTAssertEqual(legacy.rosterStatus(hasPendingCard: false), .working)
        legacy.waitingOnTeammate = true
        XCTAssertEqual(legacy.rosterStatus(hasPendingCard: false), .idle)
    }

    func testOnlyTheCurrentThreadsProjectionCarriesTheBotsActivity() {
        var bot = bot(tasks: [task("a"), task("b")])
        bot.activity = "working"
        XCTAssertEqual(bot.projected(forThread: "a")?.activity, "working")
        XCTAssertNil(bot.projected(forThread: "b")?.activity)
    }

    func testTheBotLevelActivityDecodesFromTheWire() throws {
        let json = #"""
        {"id":"b","threadId":"t","name":"B","title":"","description":"","notifications":true,
         "color":"blue","unread":false,"modelSelection":{"instanceId":"i","model":"m"},
         "createdAt":1,"busy":true,"activity":"waiting-on-you"}
        """#
        let decoded = try JSONDecoder().decode(Bot.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.activity, "waiting-on-you")
        XCTAssertEqual(decoded.rosterStatus(hasPendingCard: false), .waitingOnYou)
    }

    // MARK: - Compact row

    func testSingleThreadBotHasNoThreadControl() {
        let row = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false)
        XCTAssertEqual(row.threadCount, 1)
        XCTAssertFalse(row.showsThreadControl)
        XCTAssertFalse(row.listsThreads(expanded: true, searching: false))
        XCTAssertFalse(row.endsWithNewThread(expanded: true, searching: false))
    }

    func testMultiThreadBotOpensItsListWithNewThreadAtTheEnd() {
        let row = CompactBotRow(bot: bot(tasks: [task("a"), task("b")]), hasPendingCard: false)
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
        let single = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false)
        XCTAssertTrue(single.listsThreads(expanded: false, searching: true))
        XCTAssertFalse(single.endsWithNewThread(expanded: false, searching: true))

        let multi = CompactBotRow(bot: bot(tasks: [task("a"), task("b")]), hasPendingCard: false)
        XCTAssertTrue(multi.listsThreads(expanded: true, searching: true))
        XCTAssertFalse(multi.endsWithNewThread(expanded: true, searching: true))
    }

    func testCompactWorkingRowSwapsTheTimeForASpinner() {
        var working = bot(tasks: [task("a")])
        working.busy = true
        let row = CompactBotRow(bot: working, hasPendingCard: false)
        XCTAssertTrue(row.showsSpinner)
        XCTAssertFalse(row.showsTime)
    }

    func testCompactWaitingRowKeepsItsTimeAndShowsTheHand() {
        var waiting = task("a")
        waiting.activity = "waiting-on-you"
        var bot = bot(tasks: [waiting])
        bot.busy = true
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        XCTAssertTrue(row.showsWaiting)
        XCTAssertFalse(row.showsSpinner)
        XCTAssertTrue(row.showsTime)
    }

    func testCreatingAThreadShowsTheSpinnerInPlaceOfTheTime() {
        let resting = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false)
        XCTAssertFalse(resting.showsSpinner)
        XCTAssertTrue(resting.showsTime)

        let creating = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false, creatingThread: true)
        XCTAssertEqual(creating.status, .idle)
        XCTAssertTrue(creating.showsSpinner)
        XCTAssertFalse(creating.showsTime)
    }

    func testCreatingKeepsTheHandBesideTheSpinner() {
        var bot = bot(tasks: [task("a")])
        bot.busy = true
        bot.activity = "waiting-on-you"
        let row = CompactBotRow(bot: bot, hasPendingCard: false, creatingThread: true)
        XCTAssertTrue(row.showsWaiting)
        XCTAssertTrue(row.showsSpinner)
        XCTAssertFalse(row.showsTime)
    }

    // MARK: - The line beneath the name at the accessibility sizes

    /// The time, then the role, a "·" between them: the Android row's order.
    func testSecondLinePutsTheTimeBeforeTheRole() {
        let row = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false)
        let line = row.secondLine(stamp: "Saturday", role: "Operations lead")
        XCTAssertFalse(line.showsWaiting)
        XCTAssertFalse(line.showsSpinner)
        XCTAssertEqual(line.words, ["Saturday", "Operations lead"])
        XCTAssertEqual(line.text, "Saturday · Operations lead")
        // VoiceOver hears a pause, not the dot.
        XCTAssertEqual(line.spokenText, "Saturday, Operations lead")
    }

    /// A "·" only ever stands between two words.
    func testSecondLineWithOneWordHasNoDot() {
        let row = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false)
        XCTAssertEqual(row.secondLine(stamp: "Saturday", role: "").text, "Saturday")
        XCTAssertEqual(row.secondLine(stamp: "Saturday", role: "  ").text, "Saturday")
        XCTAssertEqual(row.secondLine(stamp: "", role: "Designer").text, "Designer")
        let blank = row.secondLine(stamp: "", role: "")
        XCTAssertEqual(blank.words, [])
        XCTAssertTrue(blank.isEmpty)
    }

    /// The spinner stands where the time was, so the role follows it alone.
    func testWorkingSecondLineSwapsTheTimeForTheSpinner() {
        var working = bot(tasks: [task("a")])
        working.busy = true
        let line = CompactBotRow(bot: working, hasPendingCard: false)
            .secondLine(stamp: "Saturday", role: "Operations lead")
        XCTAssertTrue(line.showsSpinner)
        XCTAssertEqual(line.text, "Operations lead")
        XCTAssertFalse(line.isEmpty)
    }

    func testCreatingSecondLineShowsTheSpinnerBeforeTheRole() {
        let line = CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false, creatingThread: true)
            .secondLine(stamp: "Saturday", role: "Operations lead")
        XCTAssertTrue(line.showsSpinner)
        XCTAssertFalse(line.showsWaiting)
        XCTAssertEqual(line.text, "Operations lead")
    }

    /// The hand leads and the time stays, as on one line. With no time and
    /// no role, the hand alone still makes a line.
    func testWaitingSecondLineLeadsWithTheHandAndKeepsTheTime() {
        var waiting = task("a")
        waiting.activity = "waiting-on-you"
        var bot = bot(tasks: [waiting])
        bot.busy = true
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        let line = row.secondLine(stamp: "Saturday", role: "Operations lead")
        XCTAssertTrue(line.showsWaiting)
        XCTAssertFalse(line.showsSpinner)
        XCTAssertEqual(line.text, "Saturday · Operations lead")
        XCTAssertFalse(row.secondLine(stamp: "", role: "").isEmpty)
    }

    // MARK: - The thread list

    func testUnfiledThreadsBelowAFolderGetALabel() {
        var filed = task("a")
        filed.projectId = "email"
        let bot = bot(tasks: [filed, task("b")], projects: [BotProject(id: "email", name: "Email")])
        XCTAssertTrue(bot.threadGroups().labelsUnfiledThreads)
    }

    func testNoLabelWithoutBothAFolderAndUnfiledThreads() {
        var filed = task("a")
        filed.projectId = "email"
        let email = BotProject(id: "email", name: "Email")
        XCTAssertFalse(bot(tasks: [task("a"), task("b")]).threadGroups().labelsUnfiledThreads)
        XCTAssertFalse(bot(tasks: [filed], projects: [email]).threadGroups().labelsUnfiledThreads)
        XCTAssertFalse([BotThreadGroup]().labelsUnfiledThreads)
    }

    /// A search that matches only unfiled threads shows no folder, so no label.
    func testSearchWithoutAFolderMatchDropsTheLabel() {
        var filed = task("a")
        filed.projectId = "email"
        var plan = task("plan")
        plan.title = "Plan weekend"
        let bot = bot(tasks: [filed, plan], projects: [BotProject(id: "email", name: "Email")])
        XCTAssertFalse(bot.threadGroups(matching: "Plan").labelsUnfiledThreads)
        XCTAssertTrue(bot.threadGroups(matching: "").labelsUnfiledThreads)
    }

    func testOnlyTheChiefOfStaffWearsTheCrown() {
        var chief = bot(tasks: [task("a")])
        chief.chiefOfStaff = true
        XCTAssertTrue(CompactBotRow(bot: chief, hasPendingCard: false).showsChiefBadge)
        XCTAssertFalse(CompactBotRow(bot: bot(tasks: [task("a")]), hasPendingCard: false).showsChiefBadge)
    }

    // The unread dot follows the comfortable row's rule exactly: the bot's
    // own unread flag, hidden while the bot's own conversation is busy.

    func testUnreadDotHidesWhileTheBotIsBusy() {
        var unread = bot(tasks: [task("a")])
        unread.unread = true
        XCTAssertTrue(CompactBotRow(bot: unread, hasPendingCard: false).showsUnreadDot)
        unread.busy = true
        XCTAssertFalse(CompactBotRow(bot: unread, hasPendingCard: false).showsUnreadDot)
    }

    /// The harness marks a bot that waits on the person busy, so the dot
    /// steps aside for the hand, as on a comfortable row.
    func testUnreadDotHidesWhileWaitingOnYou() {
        var waiting = task("a")
        waiting.activity = "waiting-on-you"
        var bot = bot(tasks: [waiting])
        bot.unread = true
        bot.busy = true
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        XCTAssertTrue(row.showsWaiting)
        XCTAssertFalse(row.showsUnreadDot)
    }

    /// A teammate wait is painted busy too: no dot, and no spinner either.
    func testUnreadDotHidesDuringATeammateWait() {
        var bot = bot(tasks: [task("a")])
        bot.unread = true
        bot.busy = true
        bot.waitingOnTeammate = true
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        XCTAssertFalse(row.showsSpinner)
        XCTAssertFalse(row.showsUnreadDot)
    }

    /// Only the bot's own flag hides the dot: work in a sibling thread shows
    /// its spinner and leaves the dot where the comfortable row keeps it.
    func testUnreadDotStaysWhileOnlyASiblingThreadWorks() {
        var sibling = task("b")
        sibling.activity = "working"
        var bot = bot(tasks: [task("a"), sibling])
        bot.unread = true
        let row = CompactBotRow(bot: bot, hasPendingCard: false)
        XCTAssertTrue(row.showsSpinner)
        XCTAssertTrue(row.showsUnreadDot)
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
        let pepper = try XCTUnwrap(state.bot("roster-pepper"))
        XCTAssertEqual(pepper.rosterThreadCount(queuedThreadIds: queued), 3)
        XCTAssertTrue(pepper.threadGroups(queuedThreadIds: queued).labelsUnfiledThreads)
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

    private func bot(tasks: [BotTask], projects: [BotProject]? = nil) -> Bot {
        Bot(
            id: "bot", threadId: tasks.first?.threadId ?? "bot-thread", name: "Bot", title: "Helper",
            description: "", notifications: true, color: "blue", unread: false,
            modelSelection: ModelSelection(instanceId: "i", model: "m"), createdAt: 1,
            tasks: tasks, projects: projects
        )
    }
}
