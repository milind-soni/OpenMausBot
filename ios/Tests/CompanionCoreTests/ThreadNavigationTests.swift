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

    func testFoldersRiseWithTheirNewestThreadAndUnfiledStaysLast() {
        var bot = makeBot(tasks: [
            task("b-2", project: "b"), task("loose"), task("a-2", project: "a"),
            task("a-1", project: "a"), task("b-1", project: "b"),
        ])
        bot.projects = [project("a"), project("b")]

        // Equal stamps keep stored order, so b's first thread outranks a's.
        // Unfiled still follows every folder, as on the desktop.
        var groups = bot.threadGroups()
        XCTAssertEqual(groups.map(\.id), ["project:b", "project:a", "unfiled"])
        XCTAssertEqual(groups.map { $0.tasks.map(\.threadId) }, [["b-2", "b-1"], ["a-2", "a-1"], ["loose"]])
        XCTAssertNil(groups.last?.project)

        bot.tasks?[2].updatedAt = 50
        groups = bot.threadGroups()
        XCTAssertEqual(groups.map(\.id), ["project:a", "project:b", "unfiled"])
        XCTAssertEqual(groups[0].tasks.map(\.threadId), ["a-2", "a-1"])
    }

    func testThreadListKeepsStoredOrderWhenStampsMatchAndAttentionOrderStaysSeparate() {
        var unread = task("unread")
        unread.unread = true
        var working = task("working")
        working.busy = true
        let bot = makeBot(tasks: [task("idle-a"), unread, task("idle-b"), working, task("idle-c")])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["idle-a", "unread", "idle-b", "working", "idle-c"]
        )
        XCTAssertEqual(
            bot.attentionOrderedTasks().map(\.threadId),
            ["working", "unread", "idle-a", "idle-b", "idle-c"]
        )
    }

    func testAttentionOrderStillRanksWaitingAboveWorkingForUpdates() {
        var unread = task("unread")
        unread.unread = true
        var queued = task("queued")
        queued.activity = "queued"
        var working = task("working")
        working.activity = "working"
        working.busy = false
        var waiting = task("waiting")
        waiting.activity = "waiting-on-you"
        let bot = makeBot(tasks: [unread, queued, working, waiting])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["unread", "queued", "working", "waiting"]
        )
        XCTAssertEqual(
            bot.attentionOrderedTasks().map(\.threadId),
            ["waiting", "working", "queued", "unread"]
        )
    }

    func testTheOpenThreadDoesNotJumpTheUpdateOrderedList() {
        var waiting = task("waiting")
        waiting.activity = "waiting-on-you"
        let bot = makeBot(tasks: [task("idle"), task("current"), waiting])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["idle", "current", "waiting"]
        )
        XCTAssertEqual(
            bot.attentionOrderedTasks().map(\.threadId),
            ["waiting", "current", "idle"]
        )
    }

    func testAHeldSendRanksInTheQueuedTierAboveTheThreadOpenHere() {
        // A send held behind a running turn is client state, so it floats the
        // thread the way a wire-queued one does, and a closed thread holding
        // one stays surfaced — ordering, never filtering.
        let closer = ThreadCloser(botId: "pm", name: "Parker", at: 9)
        var helper = task("helper", title: "Helper")
        helper.closedBy = closer
        let bot = makeBot(tasks: [helper, task("current"), task("plan")])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["current", "plan"]
        )
        XCTAssertEqual(
            bot.threadGroups(queuedThreadIds: ["helper", "plan"]).flatMap(\.tasks).map(\.threadId),
            ["helper", "current", "plan"]
        )
        XCTAssertEqual(
            bot.attentionOrderedTasks(queuedThreadIds: ["helper", "plan"]).map(\.threadId),
            ["helper", "plan", "current"]
        )
    }

    func testPinsLeadAndNewerUpdatesRise() {
        var pinnedOld = task("pinned-old")
        pinnedOld.pinned = true
        pinnedOld.updatedAt = 5
        var pinnedNew = task("pinned-new")
        pinnedNew.pinned = true
        pinnedNew.updatedAt = 20
        var fresh = task("fresh")
        fresh.updatedAt = 30
        var stale = task("stale")
        stale.updatedAt = 10
        stale.activity = "waiting-on-you"
        let bot = makeBot(tasks: [stale, pinnedOld, fresh, pinnedNew])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["pinned-new", "pinned-old", "fresh", "stale"]
        )
    }

    func testAttentionOrderingIsStableWithinATier() {
        var unreadB = task("unread-b")
        unreadB.unread = true
        var unreadA = task("unread-a")
        unreadA.unread = true
        let bot = makeBot(tasks: [unreadB, unreadA])

        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId), ["unread-b", "unread-a"])
    }

    func testEqualAttentionRanksKeepStoredOrderAndSearchKeepsRelevanceOrder() {
        var busy = task("busy")
        busy.busy = true
        var bot = makeBot(tasks: [
            task("idle-b"), busy, task("idle-a"),
            task("current"), task("in-folder", project: "plans"),
        ])
        bot.projects = [project("plans")]

        XCTAssertEqual(
            bot.threadGroups().first { $0.id == "unfiled" }?.tasks.map(\.threadId),
            ["idle-b", "busy", "idle-a", "current"]
        )
        XCTAssertEqual(bot.threadGroups(matching: "idle").map(\.id), ["unfiled"])
        XCTAssertEqual(
            bot.threadGroups(matching: "idle").flatMap(\.tasks).map(\.threadId),
            ["idle-b", "idle-a"]
        )
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

    func testSnoozedThreadsFoldUntilTheyWakeOrNeedAttention() {
        let nowMs = Date().timeIntervalSince1970 * 1_000
        var sentinel = task("sentinel")
        sentinel.snoozedUntil = 0
        var timed = task("timed")
        timed.snoozedUntil = nowMs + 3_600_000
        var expired = task("expired")
        expired.snoozedUntil = nowMs - 1
        var unreadSleep = task("unread-sleep")
        unreadSleep.snoozedUntil = 0
        unreadSleep.unread = true
        var openHere = task("current")
        openHere.snoozedUntil = 0
        var bot = makeBot(tasks: [sentinel, timed, expired, unreadSleep, openHere])

        // The sentinel and a still-running clock fold away; an expired
        // timestamp, something unread, and the thread open here do not, and
        // equal update stamps retain stored order. Attention controls
        // visibility here, not position in the thread list.
        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["expired", "unread-sleep", "current"]
        )
        // Nothing is gone: the manage sheet and search still list sleepers.
        XCTAssertEqual(
            Set(bot.threadGroups(includingClosed: true).flatMap(\.tasks).map(\.threadId)),
            ["sentinel", "timed", "expired", "unread-sleep", "current"]
        )
        XCTAssertEqual(bot.threadGroups(matching: "timed").first?.tasks.map(\.threadId), ["timed"])

        // Snoozing must not undo the main list's pin-then-newest order.
        bot.tasks?[0].pinned = true
        bot.tasks?[3].updatedAt = 100
        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).map(\.threadId),
                       ["sentinel", "unread-sleep", "expired", "current"])
    }

    func testSnoozedThreadsSaySoInTheBylineOnlyWhileAsleep() {
        var sentinel = task("sentinel")
        sentinel.snoozedUntil = 0
        XCTAssertEqual(sentinel.bylineLabel, "Snoozed")

        var timed = task("timed")
        timed.snoozedUntil = Date().timeIntervalSince1970 * 1_000 + 3_600_000
        XCTAssertEqual(timed.bylineLabel, "Snoozed")

        // The server heals expired snoozes on read, but a live snapshot may
        // still carry one; the byline must not call it snoozed.
        var expired = task("expired")
        expired.snoozedUntil = 1
        XCTAssertNil(expired.bylineLabel)

        var closed = task("closed")
        closed.snoozedUntil = 0
        closed.closedBy = ThreadCloser(botId: "bot", name: "Scout", at: 1)
        XCTAssertEqual(closed.bylineLabel, "closed by Scout")
    }

    func testNextSnoozeExpiryIgnoresSentinelsAndThePast() {
        let now = Date()
        let nowMs = now.timeIntervalSince1970 * 1_000
        func asleep(_ id: String, _ until: Double?) -> BotTask {
            var sleeping = task(id)
            sleeping.snoozedUntil = until
            return sleeping
        }

        let mixed = [
            asleep("sentinel", 0), asleep("past", nowMs - 1),
            asleep("soon", nowMs + 60_000), asleep("later", nowMs + 3_600_000),
            asleep("awake", nil),
        ]
        XCTAssertEqual(mixed.nextSnoozeExpiry(now: now), nowMs + 60_000)
        XCTAssertNil([asleep("sentinel", 0), asleep("past", nowMs - 1)].nextSnoozeExpiry(now: now))
    }

    func testSnoozePresetsFollowThePersonsLocalClock() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Toronto")!
        func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int) -> Date {
            calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
        }
        func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1_000 }

        // 5 PM today → "tonight" is 6 PM today; 7 PM rolls to tomorrow evening.
        XCTAssertEqual(ThreadSnoozePreset.tonight(now: at(2026, 9, 14, 17), calendar: calendar), ms(at(2026, 9, 14, 18)))
        XCTAssertEqual(ThreadSnoozePreset.tonight(now: at(2026, 9, 14, 19), calendar: calendar), ms(at(2026, 9, 15, 18)))
        // Tomorrow morning is 9 AM the next day whenever "now" is.
        XCTAssertEqual(ThreadSnoozePreset.tomorrowMorning(now: at(2026, 9, 14, 17), calendar: calendar), ms(at(2026, 9, 15, 9)))
        XCTAssertEqual(ThreadSnoozePreset.tomorrowMorning(now: at(2026, 9, 14, 23), calendar: calendar), ms(at(2026, 9, 15, 9)))
    }

    func testLegacyFallbackKeepsCurrentConversationAndRuntimeSettings() throws {
        var bot = makeBot()
        bot.busy = true
        bot.unread = true
        bot.waitingOnTeammate = true
        bot.approvalMode = "custom"
        bot.autoApprove = false
        bot.alwaysAllow = ["Bash:git"]

        let fallback = try XCTUnwrap(bot.threadGroups().first?.tasks.first)
        XCTAssertEqual(fallback.threadId, bot.threadId)
        XCTAssertEqual(fallback.displayTitle, "Untitled thread")
        XCTAssertEqual(fallback.createdAt, bot.createdAt)
        XCTAssertEqual(fallback.modelSelection, bot.modelSelection)
        XCTAssertEqual(fallback.busy, true)
        XCTAssertEqual(fallback.waitingOnTeammate, true)
        XCTAssertTrue(fallback.isWaitingOnTeammate, "a legacy bot's wait must reach the thread row")
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

    func testArchivedThreadsDecodeByPresenceIncludingZeroStamp() throws {
        let decoded = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"bot","threadId":"current","name":"Scout","title":"Researcher",
         "description":"","notifications":true,"color":"green","unread":false,
         "modelSelection":{"instanceId":"engine","model":"default"},"createdAt":1,
         "tasks":[
           {"threadId":"put-away","title":"Put away","createdAt":1,"archivedAt":5},
           {"threadId":"zero","title":"Zero stamp","createdAt":1,"archivedAt":0},
           {"threadId":"live","title":"Live","createdAt":1},
           {"threadId":"cleared","title":"Cleared","createdAt":1,"archivedAt":null}
         ]}
        """.utf8))
        let tasks = try XCTUnwrap(decoded.tasks)
        XCTAssertEqual(tasks.map(\.isArchived), [true, true, false, false], "Zero is a valid timestamp at the API boundary.")
        XCTAssertEqual(tasks[0].archivedAt, 5)
        XCTAssertEqual(tasks[1].archivedAt, 0)
    }

    func testArchivedBylineYieldsToCloserAndBeatsOpener() {
        var putAway = task("put-away")
        putAway.archivedAt = 5
        XCTAssertEqual(putAway.bylineLabel, "Archived")

        var opened = putAway
        opened.openedBy = ThreadOpener(botId: "scout", name: "Scout", at: 1)
        XCTAssertEqual(opened.bylineLabel, "Archived")

        var closed = opened
        closed.closedBy = ThreadCloser(botId: "pm", name: "Parker", at: 2)
        XCTAssertEqual(closed.bylineLabel, "closed by Parker")
    }

    func testArchivedThreadsFoldOutOfTheTreeButResurfaceOnAttention() {
        var putAway = task("put-away", title: "Put away")
        putAway.archivedAt = 5
        var zero = task("zero", title: "Zero stamp")
        zero.archivedAt = 0
        var waiting = task("waiting", title: "Waiting")
        waiting.archivedAt = 5
        waiting.activity = "waiting-on-you"
        var running = task("running", title: "Still running")
        running.archivedAt = 5
        running.activity = "running"
        XCTAssertTrue(running.isWorking, "a running thread is work, exactly as its row labels it")
        var held = task("held", title: "Plain waiting")
        held.archivedAt = 5
        held.activity = "waiting"
        XCTAssertFalse(held.isWorking)
        XCTAssertTrue(held.demandsAttention(), "a plain waiting thread still needs the person")
        var active = task("current")
        active.archivedAt = 7
        var bot = makeBot(tasks: [putAway, zero, waiting, running, held, active, task("plan")])

        XCTAssertEqual(
            bot.threadGroups().flatMap(\.tasks).map(\.threadId),
            ["waiting", "running", "held", "current", "plan"]
        )
        XCTAssertEqual(bot.threadGroups(includingClosed: true).flatMap(\.tasks).count, 7)
        XCTAssertEqual(bot.threadGroups(matching: "put away").flatMap(\.tasks).map(\.threadId), ["put-away"])

        // Unarchiving clears the stamp; the thread returns to the default tree.
        bot.tasks?[0].archivedAt = nil
        XCTAssertFalse(bot.tasks?[0].isArchived ?? true)
        XCTAssertEqual(bot.threadGroups().flatMap(\.tasks).count, 6)
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
