import XCTest
@testable import CompanionCore

final class ThreadNavigationTests: XCTestCase {
    func testProjectsDecodeWithOptionalEmojiAndLegacyAbsence() throws {
        let legacy = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"bot","threadId":"current","name":"Scout","title":"Researcher",
         "description":"","notifications":true,"color":"green","unread":false,
         "modelSelection":{"instanceId":"engine","model":"default"},"createdAt":1}
        """.utf8))
        XCTAssertNil(legacy.projects)
        XCTAssertNil(legacy.tasks)

        var modern = legacy
        modern.projects = try JSONDecoder().decode([BotProject].self, from: Data("""
        [{"id":"research","name":"Research","emoji":"🔬"},
         {"id":"writing","name":"Writing"}]
        """.utf8))
        let decoded = try JSONDecoder().decode(Bot.self, from: JSONEncoder().encode(modern))
        XCTAssertEqual(decoded.projects?.map(\.id), ["research", "writing"])
        XCTAssertEqual(decoded.projects?.first?.emoji, "🔬")
        XCTAssertNil(decoded.projects?.last?.emoji)
    }

    func testFoldersFollowSavedOrderAndThreadsKeepServerOrder() {
        var bot = makeBot(tasks: [
            task("b-2", project: "b"), task("loose"), task("a-2", project: "a"),
            task("a-1", project: "a"), task("b-1", project: "b"),
        ])
        bot.projects = [project("a"), project("b")]

        let groups = bot.threadGroups()
        XCTAssertEqual(groups.map(\.id), ["project:a", "project:b", "unfiled"])
        XCTAssertEqual(groups.map { $0.tasks.map(\.threadId) }, [["a-2", "a-1"], ["b-2", "b-1"], ["loose"]])
        XCTAssertEqual(groups.first?.project, bot.projects?.first)
        XCTAssertNil(groups.last?.project)
    }

    func testOrphansStayUnfiledAndEmptyOrDuplicateFoldersDoNotDuplicateRows() {
        var bot = makeBot(tasks: [task("orphan", project: "deleted"), task("filed", project: "a"), task("loose")])
        bot.projects = [project("empty"), project("a"), project("a")]

        XCTAssertEqual(bot.threadGroups().map(\.id), ["project:a", "unfiled"])
        XCTAssertEqual(bot.threadGroups().last?.tasks.map(\.threadId), ["orphan", "loose"])
        bot.projects = nil
        XCTAssertEqual(bot.threadGroups().map(\.id), ["unfiled"])
        XCTAssertEqual(bot.threadGroups().first?.tasks.map(\.threadId), ["orphan", "filed", "loose"])
    }

    func testRoutineExecutionsNeverAppearInFoldersOrSearch() {
        var execution = task("run", title: "Hidden result", project: "runs")
        execution.routineRunId = "routine-run"
        var bot = makeBot(tasks: [execution, task("result", title: "Daily result")])
        bot.projects = [project("runs", name: "Hidden results")]

        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId), ["result"])
        XCTAssertTrue(bot.threadGroups(matching: "Hidden").isEmpty)
        bot.tasks = [execution]
        XCTAssertTrue(bot.threadGroups().isEmpty)
    }

    func testLegacyFallbackKeepsCurrentConversationAndRuntimeSettings() throws {
        var bot = makeBot()
        bot.busy = true
        bot.unread = true
        bot.approvalMode = "custom"
        bot.autoApprove = false
        bot.alwaysAllow = ["Bash:git"]

        let fallback = try XCTUnwrap(bot.threadGroups().first?.tasks.first)
        XCTAssertEqual(fallback.threadId, bot.threadId)
        XCTAssertEqual(fallback.displayTitle, "Untitled thread")
        XCTAssertEqual(fallback.createdAt, bot.createdAt)
        XCTAssertEqual(fallback.modelSelection, bot.modelSelection)
        XCTAssertEqual(fallback.busy, true)
        XCTAssertEqual(fallback.unread, true)
        XCTAssertEqual(fallback.approvalMode, "custom")
        XCTAssertEqual(fallback.autoApprove, false)
        XCTAssertEqual(fallback.alwaysAllow, ["Bash:git"])
        XCTAssertEqual(bot.threadGroups(matching: "untitled").first?.tasks.first?.threadId, bot.threadId)
        bot.tasks = []
        XCTAssertTrue(bot.threadGroups().isEmpty)
    }

    func testBlankTitlesHaveAnExplicitFallback() {
        XCTAssertEqual(task("blank", title: " \n\t ").displayTitle, "Untitled thread")
        XCTAssertEqual(task("empty", title: "").displayTitle, "Untitled thread")
        XCTAssertEqual(task("named", title: "  Release notes\n").displayTitle, "Release notes")
    }

    func testSearchMatchesTitlesAndFolderNamesWithoutCaseOrAccentSensitivity() {
        var bot = makeBot(tasks: [
            task("plan", title: "Release plan", project: "research"),
            task("budget", title: "Budget", project: "research"),
            task("draft", title: "Release draft"), task("unrelated", title: "Shopping"),
        ])
        bot.projects = [project("research", name: "Café research")]

        XCTAssertEqual(bot.threadGroups(matching: "  CAFE \n").flatMap(\.tasks).map(\.threadId), ["plan", "budget"])
        XCTAssertEqual(bot.threadGroups(matching: "RELEASE").flatMap(\.tasks).map(\.threadId), ["plan", "draft"])
        XCTAssertEqual(bot.threadGroups(matching: "budget").map(\.id), ["project:research"])
        XCTAssertEqual(bot.threadGroups(matching: " \n"), bot.threadGroups())
        XCTAssertTrue(bot.threadGroups(matching: "missing").isEmpty)
    }

    func testGroupingPreservesRuntimeMetadataAndDoesNotChangeSelection() {
        var working = task("sibling", project: "work")
        working.busy = true
        working.activity = "waiting"
        working.unread = true
        working.openedBy = ThreadOpener(botId: "other", name: "Teammate", at: 9)
        var bot = makeBot(tasks: [task("current"), working])
        bot.projects = [project("work")]

        XCTAssertEqual(bot.threadGroups().first?.tasks, [working])
        XCTAssertEqual(bot.threadGroups(matching: "sibling").first?.tasks, [working])
        XCTAssertEqual(bot.threadId, "current")
        XCTAssertEqual(bot.tasks?.last, working)
    }

    func testClosedThreadsFoldOutOfTheTreeButStayReachable() {
        // Three helper threads a PM bot opened on itself and closed sit on top
        // of the person's own threads, newest first, one of them filed.
        let closer = ThreadCloser(botId: "pm", name: "Parker", at: 9)
        var helpers = (0..<3).map { task("helper-\($0)", title: "Helper \($0)", project: $0 == 0 ? "work" : nil) }
        for index in helpers.indices {
            helpers[index].openedBy = ThreadOpener(botId: "pm", name: "Parker", at: 5)
            helpers[index].closedBy = closer
        }
        var bot = makeBot(tasks: helpers + [task("current"), task("plan", title: "Plan the launch")])
        bot.projects = [project("work")]

        // the default tree shows only open threads; the empty folder disappears with its closed thread
        XCTAssertEqual(bot.threadGroups().map(\.id), ["unfiled"])
        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId), ["current", "plan"])
        // the manage sheet and a search still list them — closing is never a deletion
        XCTAssertEqual(bot.threadGroups(includingClosed: true).map(\.id), ["project:work", "unfiled"])
        XCTAssertEqual(bot.threadGroups(includingClosed: true).flatMap(\.tasks).count, 5)
        XCTAssertEqual(bot.threadGroups(matching: "helper 1").flatMap(\.tasks).map(\.threadId), ["helper-1"])

        // a closed thread that is running, unread, or the one open here stays in the tree
        helpers[1].busy = true
        helpers[2].unread = true
        bot.tasks = helpers + [task("current")]
        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId), ["helper-1", "helper-2", "current"])
        var closedCurrent = task("current")
        closedCurrent.closedBy = closer
        bot.tasks = [closedCurrent, task("plan")]
        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId), ["current", "plan"])
    }

    func testSiblingNavigationProjectionsKeepTheirOwnThreadAndRuntime() throws {
        var selected = task("current", title: "Current")
        selected.unread = false
        selected.busy = false
        var sibling = task("sibling", title: "Sibling")
        sibling.unread = true
        sibling.busy = true
        sibling.modelSelection = ModelSelection(instanceId: "other-engine", model: "other-model")
        let bot = makeBot(tasks: [selected, sibling])

        let first = try XCTUnwrap(bot.projected(forThread: selected.threadId))
        let second = try XCTUnwrap(bot.projected(forThread: sibling.threadId))
        XCTAssertEqual(first.id, second.id, "The profile API still addresses the bot owner.")
        XCTAssertNotEqual(first.threadId, second.threadId)
        XCTAssertEqual(second.currentTaskModelSelection, sibling.modelSelection)
        XCTAssertEqual(first.unread, false)
        XCTAssertEqual(second.unread, true)
        XCTAssertEqual(second.currentTaskBusy, true)
        XCTAssertEqual(bot.threadId, "current", "Navigation must not select the sibling on the shared profile.")
        XCTAssertNil(bot.projected(forThread: "missing"))
    }

    func testUnreadBadgeCountsVisibleSiblingThreadsOnceEachAndKeepsRoomCount() {
        var first = task("current")
        first.unread = true
        var second = task("second")
        second.unread = true
        var execution = task("run")
        execution.unread = true
        execution.routineRunId = "run-1"
        var bot = makeBot(tasks: [first, second, execution])
        bot.unread = true
        var hidden = bot
        hidden.id = "hidden"
        hidden.hidden = true
        var state = CompanionState()
        state.bots = [bot, hidden]
        state.rooms = [Room(
            id: "room", threadId: "room-thread", name: "Channel", memberIds: [],
            defaultResponder: GroupResponder(kind: "all"), bulletin: "", unread: true, createdAt: 1
        )]

        XCTAssertEqual(state.unreadCount, 3)
        state.rooms = []
        XCTAssertEqual(state.unreadCount, 2)
        state.bots[0].tasks = [execution]
        XCTAssertEqual(state.unreadCount, 0)
    }

    func testUnreadBadgeFallsBackOnceForLegacyMetadata() {
        var bot = makeBot()
        bot.unread = true
        var state = CompanionState()
        state.bots = [bot]
        XCTAssertEqual(state.unreadCount, 1)
        state.bots[0].tasks = [task("current"), task("older")]
        XCTAssertEqual(state.unreadCount, 1)
        state.bots[0].unread = false
        XCTAssertEqual(state.unreadCount, 0)
        state.bots[0].unread = true
        state.bots[0].tasks = []
        XCTAssertEqual(state.unreadCount, 0)
        var execution = task("run")
        execution.routineRunId = "run-1"
        state.bots[0].tasks = [execution]
        XCTAssertEqual(state.unreadCount, 0)
    }

    func testMixedUnreadMetadataDoesNotApplyAggregateToUnknownThreads() {
        var known = task("current")
        known.unread = true
        var bot = makeBot(tasks: [known, task("unknown")])
        bot.unread = true
        var state = CompanionState()
        state.bots = [bot]
        XCTAssertEqual(state.unreadCount, 1)
        state.bots[0].tasks?[0].unread = false
        XCTAssertEqual(state.unreadCount, 0)
        state.bots[0].tasks?[0].unread = true
        state.bots[0].tasks?[0].routineRunId = "run-1"
        XCTAssertEqual(state.unreadCount, 0, "An unread internal run cannot mark an unknown visible thread unread.")
    }

    private func makeBot(tasks: [BotTask]? = nil) -> Bot {
        Bot(
            id: "bot", threadId: "current", name: "Scout", title: "Researcher",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1,
            tasks: tasks
        )
    }

    private func task(_ id: String, title: String? = nil, project: String? = nil) -> BotTask {
        BotTask(threadId: id, title: title ?? id, createdAt: 1, projectId: project)
    }

    private func project(_ id: String, name: String? = nil) -> BotProject {
        BotProject(id: id, name: name ?? id)
    }
}
