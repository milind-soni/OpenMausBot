// The fold. Everything here is a claim about what the user sees after a
// frame lands, so it is written against frames rather than internals.
import XCTest
@testable import CompanionCore

final class StoreTests: XCTestCase {
    func fleet() throws -> Fleet {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try JSONDecoder().decode(Fleet.self, from: try Data(contentsOf: url))
    }

    func message(_ id: String, at: Double = 1, text: String = "hello") -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: at)
        message.text = text
        return message
    }

    func hydrated() throws -> CompanionState {
        var state = CompanionState()
        state.hydrate(try fleet())
        return state
    }

    // MARK: - Hydration

    func testHydrateIndexesEveryThread() throws {
        let state = try hydrated()
        XCTAssertFalse(state.bots.isEmpty)
        for bot in state.bots {
            XCTAssertNotNil(state.messages[bot.threadId])
        }
        for room in state.rooms {
            XCTAssertEqual(state.transcript(forThread: room.threadId).count, room.messages?.count)
            XCTAssertEqual(state.hasMore[room.threadId], room.hasMore)
        }
    }

    func testSidebarSectionsGroupBotsAndChannelsInNaturalOrder() throws {
        let source = try fleet()
        var researchBot = try XCTUnwrap(source.bots.first)
        researchBot.id = "research-1"
        researchBot.section = "Research"

        var personalBot = researchBot
        personalBot.id = "personal-1"
        personalBot.section = "Personal"

        var secondResearchBot = researchBot
        secondResearchBot.id = "research-2"
        secondResearchBot.pinned = true

        var researchChief = researchBot
        researchChief.id = "research-chief"
        researchChief.chiefOfStaff = true
        researchChief.pinned = true

        var unsectionedChief = researchBot
        unsectionedChief.id = "default-chief"
        unsectionedChief.section = nil
        unsectionedChief.chiefOfStaff = true

        var pinnedOnlyBot = researchBot
        pinnedOnlyBot.id = "pinned-only"
        pinnedOnlyBot.section = "Pinned only"
        pinnedOnlyBot.pinned = true

        var hiddenBot = researchBot
        hiddenBot.id = "hidden"
        hiddenBot.section = "Secret"
        hiddenBot.hidden = true

        var researchChannel = try XCTUnwrap(source.groups.first)
        researchChannel.id = "research-channel"
        researchChannel.section = "Research"

        var generalChannel = researchChannel
        generalChannel.id = "general-channel"
        generalChannel.section = "  "

        var directChat = researchChannel
        directChat.id = "direct-chat"
        directChat.dm = true

        var state = CompanionState()
        state.bots = [
            researchChief, researchBot, personalBot, secondResearchBot,
            pinnedOnlyBot, unsectionedChief, hiddenBot,
        ]
        state.rooms = [generalChannel, researchChannel, directChat]

        XCTAssertEqual(state.sidebarSections.map(\.name), ["Research", "Personal"])
        XCTAssertEqual(state.sidebarSections[0].chiefs.map(\.id), ["research-chief"])
        XCTAssertEqual(state.sidebarSections[0].bots.map(\.id), ["research-1"])
        XCTAssertEqual(state.sidebarSections[0].channels.map(\.id), ["research-channel"])
        XCTAssertTrue(state.sidebarSections[1].channels.isEmpty)
        XCTAssertEqual(state.unsectionedChief?.id, "default-chief")
        XCTAssertTrue(state.unsectionedBots.isEmpty)
        XCTAssertEqual(state.pinnedBots.map(\.id), ["research-2", "pinned-only"])
        XCTAssertEqual(state.unsectionedChannels.map(\.id), ["general-channel"])
        XCTAssertEqual(state.botChats.map(\.id), ["direct-chat"])
    }

    // MARK: - Messages

    func testAppendsAndPatchesInPlace() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("new-1")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)

        var patched = message("new-1")
        patched.text = "edited"
        state.apply(.messagePatch(threadId: threadId, message: patched))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1, "a patch must not append")
        XCTAssertEqual(state.transcript(forThread: threadId).last?.text, "edited")
    }

    func testAReplayedMessageDoesNotAppearTwice() throws {
        // resuming redelivers whatever was in flight when the socket died
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("dupe")))
        state.apply(.message(threadId: threadId, message: message("dupe")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)
    }

    func testScrollbackPrependsWithoutDuplicating() throws {
        var state = CompanionState()
        state.messages["t1"] = [message("c"), message("d")]
        state.prepend(ThreadPage(messages: [message("a"), message("b"), message("c")], hasMore: true), toThread: "t1")

        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(state.hasMore["t1"], true)
    }

    func testSearchWindowMergesAndOrdersWithoutDuplicating() {
        var state = CompanionState()
        state.messages["t1"] = [message("d", at: 4), message("e", at: 5)]
        state.merge(
            ThreadPage(messages: [message("b", at: 2), message("c", at: 3), message("d", at: 4)], hasMore: true),
            intoThread: "t1"
        )
        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["b", "c", "d", "e"])
        XCTAssertEqual(state.hasMore["t1"], true)
    }

    // MARK: - Bots

    func testABotFrameMergesRatherThanWipingTheTranscript() throws {
        // bot frames carry no messages; assigning one would empty the chat
        var state = try hydrated()
        var bot = try XCTUnwrap(state.bots.first)
        let threadId = bot.threadId
        state.apply(.message(threadId: threadId, message: message("keep-me")))
        let count = state.transcript(forThread: threadId).count

        bot.messages = nil
        bot.busy = true
        bot.unread = true
        state.apply(.bot(bot))

        XCTAssertEqual(state.bot(bot.id)?.busy, true)
        XCTAssertEqual(state.transcript(forThread: threadId).count, count)
        XCTAssertNotNil(state.bot(bot.id)?.messages, "the merged bot keeps the transcript it had")
    }

    func testATaskSwitchReplacesTheActiveTranscript() throws {
        var state = try hydrated()
        var bot = try XCTUnwrap(state.bots.first)
        let previousThread = bot.threadId
        state.apply(.message(threadId: previousThread, message: message("old-tail")))

        bot.threadId = "another-task"
        bot.messages = [message("new-root", text: "new task")]
        bot.activeLeafId = "new-root"
        state.apply(.bot(bot))

        XCTAssertEqual(state.bot(bot.id)?.threadId, "another-task")
        XCTAssertEqual(state.transcript(forThread: "another-task").map(\.id), ["new-root"])
        XCTAssertFalse(state.transcript(forThread: "another-task").contains { $0.id == "old-tail" })
    }

    func testPinnedTaskKeepsItsModelRunAndBranchWhenAnotherDeviceSwitches() throws {
        var state = CompanionState()
        var bot = try XCTUnwrap(try fleet().bots.first)
        bot.threadId = "thread-a"
        bot.modelSelection = ModelSelection(instanceId: "codex", model: "profile-default")
        bot.tasks = [
            BotTask(threadId: "thread-a", title: "A", createdAt: 1, modelSelection: ModelSelection(instanceId: "codex", model: "model-a"), busy: true, unread: true),
            BotTask(threadId: "thread-b", title: "B", createdAt: 2, modelSelection: ModelSelection(instanceId: "claude", model: "model-b"), busy: false, unread: false),
        ]
        var leafA = message("leaf-a")
        leafA.parentId = "root-a"
        var alternativeA = message("alternative-a")
        alternativeA.parentId = "root-a"
        bot.messages = [message("root-a"), leafA, alternativeA]
        bot.activeLeafId = "leaf-a"
        state.apply(.bot(bot))
        state.apply(.runtime(RuntimeEvent(type: "content.delta", threadId: "thread-a", delta: "still running", streamKind: "assistant_text")))

        // A desktop selection frame is canonical profile state, not phone
        // navigation. Projecting A must never borrow B's model or transcript.
        bot.threadId = "thread-b"
        bot.busy = true // aggregate: A is still working
        bot.messages = [message("root-b")]
        bot.activeLeafId = "root-b"
        state.apply(.bot(bot))
        XCTAssertEqual(state.bot(bot.id)?.threadId, "thread-b")
        XCTAssertEqual(state.bot(bot.id)?.modelSelection.model, "profile-default")
        let pinned = try XCTUnwrap(state.bot(forThread: "thread-a"))
        XCTAssertEqual(pinned.threadId, "thread-a")
        XCTAssertEqual(pinned.modelSelection.model, "model-a")
        XCTAssertEqual(pinned.busy, true)
        XCTAssertEqual(pinned.unread, true)
        XCTAssertEqual(state.bot(forThread: "thread-b")?.busy, false)
        XCTAssertEqual(state.streaming["thread-a"], "still running")
        XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root-a", "leaf-a"])
        state.apply(.thread(threadId: "thread-a", activeLeafId: "alternative-a"))
        XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root-a", "alternative-a"])
        XCTAssertEqual(state.visibleTranscript(forThread: "thread-b").map(\.id), ["root-b"])
        XCTAssertNil(bot.projected(forThread: "not-owned"))
    }

    func testRoutineExecutionsAreHiddenOnlyFromTheThreadPicker() throws {
        var bot = try XCTUnwrap(try fleet().bots.first)
        bot.threadId = "results"
        bot.tasks = [
            BotTask(threadId: "legacy", title: "Routine: old run", createdAt: 1),
            BotTask(threadId: "results", title: "Brief results", createdAt: 2, busy: false),
            BotTask(threadId: "run-thread", title: "Brief", createdAt: 3, busy: true,
                    activity: "waiting-on-you", approvalMode: "ask", routineRunId: "run-1"),
        ]
        var approval = Message(id: "approval", role: .bot, kind: .options, at: 4)
        approval.card = OptionCard(title: "Approve?", subtitle: "Read", options: ["Approve", "Deny"], requestId: "request")
        var state = CompanionState()
        state.apply(.bot(bot))
        state.merge(ThreadPage(messages: [approval], activeLeafId: "approval"), intoThread: "run-thread")

        XCTAssertEqual(bot.visibleTasks.map(\.threadId), ["legacy", "results"])
        XCTAssertEqual(state.bot(bot.id)?.tasks?.count, 3)
        let execution = try XCTUnwrap(state.bot(forThread: "run-thread"))
        XCTAssertEqual(execution.threadId, "run-thread")
        XCTAssertEqual(execution.currentTaskBusy, true)
        XCTAssertEqual(execution.approvalMode, "ask")
        XCTAssertEqual(state.visibleTranscript(forThread: "run-thread").map(\.id), ["approval"])
        XCTAssertEqual(state.pendingApprovals.map(\.threadId), ["run-thread"])

        bot.tasks = nil
        XCTAssertTrue(bot.visibleTasks.isEmpty)
    }

    func testColdBackgroundPageCarriesItsOwnBranchHead() {
        var state = CompanionState()
        var leaf = message("chosen")
        leaf.parentId = "root"
        state.merge(ThreadPage(messages: [message("root"), leaf, message("other")], hasMore: false, activeLeafId: "chosen"), intoThread: "thread-a")
        XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root", "chosen"])
    }

    func testAChannelTaskSwitchReplacesTheActiveTranscript() throws {
        var state = try hydrated()
        var room = try XCTUnwrap(state.rooms.first)
        let previousThread = room.threadId
        state.apply(.message(threadId: previousThread, message: message("old-room-tail")))

        room.threadId = "another-room-task"
        room.messages = [message("new-room-root", text: "new channel task")]
        state.apply(.room(room))

        XCTAssertEqual(state.rooms.first(where: { $0.id == room.id })?.threadId, "another-room-task")
        XCTAssertEqual(state.transcript(forThread: "another-room-task").map(\.id), ["new-room-root"])
        XCTAssertFalse(state.transcript(forThread: "another-room-task").contains { $0.id == "old-room-tail" })
    }

    func testVisibleTranscriptFollowsTheActiveBranch() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        let root = message("root")
        var first = message("first", at: 2)
        first.parentId = root.id
        var fork = message("fork", at: 3)
        fork.parentId = root.id
        var tail = message("tail", at: 4)
        tail.parentId = fork.id
        state.messages[bot.threadId] = [root, first, fork, tail]

        state.apply(.thread(threadId: bot.threadId, activeLeafId: tail.id))
        XCTAssertEqual(state.visibleTranscript(forThread: bot.threadId).map(\.id), ["root", "fork", "tail"])
    }

    func testVersionsAreUserMessagesWithTheSameParent() {
        var state = CompanionState()
        let root = message("root")
        var first = message("first", at: 2)
        first.parentId = root.id
        var second = message("second", at: 3)
        second.parentId = root.id
        var reply = message("reply", at: 4)
        reply.role = .bot
        reply.parentId = root.id
        state.messages["t1"] = [root, second, reply, first]

        XCTAssertEqual(state.versions(of: first, inThread: "t1").map(\.id), ["first", "second"])
    }

    func testMessageAppendMovesTheLeafAndBranchSwitchClearsLiveText() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.apply(.runtime(RuntimeEvent(
            type: "content.delta", threadId: bot.threadId, delta: "old branch", streamKind: "assistant_text"
        )))
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "other"))
        XCTAssertNil(state.streaming[bot.threadId])

        var latest = message("latest")
        latest.parentId = "other"
        state.apply(.message(threadId: bot.threadId, message: latest))
        XCTAssertEqual(state.bot(bot.id)?.activeLeafId, "latest")
    }

    func testMessagesOnOtherBranchesDoNotMoveSelectedOrBackgroundThreadHeads() throws {
        for selected in [true, false] {
            var state = CompanionState()
            var bot = try XCTUnwrap(try fleet().bots.first)
            bot.threadId = selected ? "thread-a" : "thread-b"
            bot.tasks = [BotTask(threadId: "thread-a", title: "A", createdAt: 1),
                         BotTask(threadId: "thread-b", title: "B", createdAt: 2)]
            bot.activeLeafId = selected ? "chosen" : "sibling"
            state.apply(.bot(bot))
            var chosen = message("chosen")
            chosen.parentId = "root"
            state.merge(ThreadPage(messages: [message("root"), chosen], hasMore: false, activeLeafId: "chosen"),
                        intoThread: "thread-a")
            var alternative = message("alternative")
            alternative.parentId = "root"
            state.apply(.message(threadId: "thread-a", message: alternative))
            XCTAssertEqual(state.bot(forThread: "thread-a")?.activeLeafId, "chosen")
            XCTAssertEqual(state.bot(bot.id)?.activeLeafId, selected ? "chosen" : "sibling")
            XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root", "chosen"])

            var tail = message("tail")
            tail.parentId = "chosen"
            state.apply(.message(threadId: "thread-a", message: tail))
            XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root", "chosen", "tail"])
            state.apply(.message(threadId: "thread-a", message: chosen)) // replay cannot rewind the head
            XCTAssertEqual(state.bot(forThread: "thread-a")?.activeLeafId, "tail")
            state.apply(.thread(threadId: "thread-a", activeLeafId: "alternative"))
            XCTAssertEqual(state.visibleTranscript(forThread: "thread-a").map(\.id), ["root", "alternative"])
        }
    }

    func testDeletingABotTakesItsTranscriptWithIt() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.apply(.botDeleted(botId: bot.id))

        XCTAssertNil(state.bot(bot.id))
        XCTAssertTrue(state.transcript(forThread: bot.threadId).isEmpty)
        XCTAssertNil(state.hasMore[bot.threadId])
    }

    func testAnUnknownBotFrameAddsIt() throws {
        var state = CompanionState()
        var bot = try XCTUnwrap(try hydrated().bots.first)
        bot.id = "brand-new"
        bot.threadId = "brand-new-thread"
        state.apply(.bot(bot))
        XCTAssertEqual(state.bots.count, 1)
        XCTAssertNotNil(state.messages["brand-new-thread"])
    }

    // MARK: - Approvals

    func testPendingApprovalsAreTheUnansweredOnesNewestFirst() throws {
        var state = try hydrated()
        let firstThread = try XCTUnwrap(state.bots.first?.threadId)
        let secondThread = try XCTUnwrap(state.rooms.first?.threadId)
        func card(_ id: String, at: Double, requestId: String?, answered: String? = nil) -> Message {
            var message = Message(id: id, role: .bot, kind: .options, at: at)
            message.card = OptionCard(
                title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
                answered: answered, dismissed: nil, requestId: requestId, tool: "Bash",
                held: nil, allowKey: "Bash:rm"
            )
            return message
        }
        state.messages[firstThread] = [
            card("old", at: 1, requestId: "r1"),
            card("answered", at: 2, requestId: "r2", answered: "Allow"),
            card("history", at: 3, requestId: nil),
        ]
        state.messages[secondThread] = [card("new", at: 9, requestId: "r3")]

        let pending = state.pendingApprovals
        XCTAssertEqual(pending.map(\.message.id), ["new", "old"])
        XCTAssertEqual(pending.first?.threadId, secondThread)
    }

    // MARK: - Cursor

    func testTheCursorFollowsTheStreamAndKeepsItsStreamId() {
        var state = CompanionState()
        state.apply(.hello(cursor: "abc12345:7", resumed: true))
        XCTAssertNil(state.cursor, "hello is not committed before its replay or hydration")

        state.resetCursor("abc12345:7")
        XCTAssertEqual(state.cursor, "abc12345:7")

        state.advance(to: 8)
        XCTAssertEqual(state.cursor, "abc12345:8", "the stream id is what stops a stale replay")

        // hello frames carry no seq, and nothing should move without one
        state.advance(to: nil)
        XCTAssertEqual(state.cursor, "abc12345:8")
    }

    func testAdvancingBeforeAnyHelloDoesNothing() {
        var state = CompanionState()
        state.advance(to: 4)
        XCTAssertNil(state.cursor, "without a stream id there is no cursor worth keeping")
    }

    // MARK: - Notifications

    func testNotificationsCollectInOrder() {
        var state = CompanionState()
        let approval = NotificationFrame(
            kind: "approval", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout needs approval", body: "rm -rf"
        )
        let done = NotificationFrame(
            kind: "done", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout finished", body: "pushed"
        )
        state.apply(.notify(approval))
        state.apply(.notify(done))

        XCTAssertEqual(state.notifications.count, 2)
        XCTAssertTrue(state.notifications[0].isBlocking)
        XCTAssertFalse(state.notifications[1].isBlocking)
    }

    func testNotificationsKeepOnlyARecentWindow() {
        var state = CompanionState()
        for index in 0..<120 {
            state.apply(.notify(NotificationFrame(
                kind: "done", botId: "b1", botName: "Scout", threadId: "t1",
                title: "Done \(index)", body: "body"
            )))
        }
        XCTAssertEqual(state.notifications.count, 100)
        XCTAssertEqual(state.notifications.first?.title, "Done 20")
    }

    // MARK: - Frames with nothing to fold

    func testFramesThisClientIgnoresAreHarmless() throws {
        var state = try hydrated()
        let before = state.bots.count
        state.apply(.screen(botId: "b1", png: "AAAA", mime: "image/png"))
        state.apply(.computer(botId: "b1", state: "provisioning"))
        state.apply(.config)
        state.apply(.runtime(RuntimeEvent(type: "content.delta", threadId: "t1", delta: "hi", streamKind: "assistant_text")))
        state.apply(.unknown(kind: "routine.run"))
        XCTAssertEqual(state.bots.count, before)
    }
}

// MARK: - Live text

/// The harness relays raw provider deltas alongside the settled messages it
/// folds. These pin the handover between the two, which is where every
/// streaming bug in this project's desktop client has lived.
final class StreamingTests: XCTestCase {
    private func delta(_ text: String, thread: String = "t1", kind: String = "assistant_text") -> Frame {
        .runtime(RuntimeEvent(type: "content.delta", threadId: thread, delta: text, streamKind: kind))
    }

    func testDeltasAccumulateIntoLiveText() {
        var state = CompanionState()
        state.apply(delta("Hel"))
        state.apply(delta("lo, "))
        state.apply(delta("world"))
        XCTAssertEqual(state.streaming["t1"], "Hello, world")
    }

    func testReasoningIsKeptApartFromTheAnswer() {
        var state = CompanionState()
        state.apply(delta("thinking…", kind: "reasoning_text"))
        state.apply(delta("the answer"))
        XCTAssertEqual(state.reasoning["t1"], "thinking…")
        XCTAssertEqual(state.streaming["t1"], "the answer")
    }

    func testAnUnknownStreamKindIsDroppedRatherThanGuessedAt() {
        var state = CompanionState()
        state.apply(delta("???", kind: "some_future_kind"))
        XCTAssertNil(state.streaming["t1"])
        XCTAssertNil(state.reasoning["t1"])
    }

    func testASettledReplyReplacesTheLiveText() {
        // The bug this prevents: the live bubble surviving next to the real
        // one, so the tail renders below whatever settled after it and the
        // next turn's deltas append onto a duplicated fragment.
        var state = CompanionState()
        state.apply(delta("partial answer"))
        XCTAssertNotNil(state.streaming["t1"])

        state.apply(.message(threadId: "t1", message: Message(
            id: "m1", role: .bot, kind: .text, at: 1, text: "partial answer, completed"
        )))
        XCTAssertNil(state.streaming["t1"], "the settled message already contains those tokens")
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1)
    }

    func testOnlyASettledBotReplyClearsIt() {
        var state = CompanionState()
        state.apply(delta("mid-answer"))
        // the user's own message, and a tool chip, both land mid-turn
        state.apply(.message(threadId: "t1", message: Message(
            id: "u1", role: .user, kind: .text, at: 1, text: "another question"
        )))
        state.apply(.message(threadId: "t1", message: Message(
            id: "a1", role: .bot, kind: .activity, at: 2
        )))
        XCTAssertEqual(state.streaming["t1"], "mid-answer", "neither of those is the reply")
    }

    func testTheTurnEndingClearsEvenWithoutASettledMessage() {
        // A failed or interrupted turn may never produce one. Leaving the
        // caret blinking forever is the failure mode worth avoiding.
        for ending in ["turn.completed", "turn.failed", "turn.aborted"] {
            var state = CompanionState()
            state.apply(delta("half a sentence"))
            state.apply(.runtime(RuntimeEvent(type: ending, threadId: "t1", delta: nil, streamKind: nil)))
            XCTAssertNil(state.streaming["t1"], "\(ending) should end the live bubble")
        }
    }

    func testThreadsStreamIndependently() {
        var state = CompanionState()
        state.apply(delta("for one", thread: "t1"))
        state.apply(delta("for two", thread: "t2"))
        state.apply(.runtime(RuntimeEvent(type: "turn.completed", threadId: "t1", delta: nil, streamKind: nil)))
        XCTAssertNil(state.streaming["t1"])
        XCTAssertEqual(state.streaming["t2"], "for two", "one bot finishing must not silence another")
    }
}

// MARK: - The computer panel

/// Screen frames are the one thing this client asks the server *not* to send
/// by default — they are hundreds of kilobytes each and arrive every few
/// seconds. These pin the fold; the turning-on is the session's job.
final class ScreenTests: XCTestCase {
    private func frame(_ png: String, bot: String = "b1") -> Frame {
        .screen(botId: bot, png: png, mime: "image/png")
    }

    func testOnlyTheNewestFrameIsKept() {
        // A history of desktop captures is worth nothing and costs megabytes.
        var state = CompanionState()
        state.apply(frame("AAAA"))
        state.apply(frame("BBBB"))
        state.apply(frame("CCCC"))
        XCTAssertEqual(state.screens["b1"]?.png, "CCCC")
        XCTAssertEqual(state.screens.count, 1)
    }

    func testBotsAreTrackedSeparately() {
        var state = CompanionState()
        state.apply(frame("one", bot: "b1"))
        state.apply(frame("two", bot: "b2"))
        XCTAssertEqual(state.screens["b1"]?.png, "one")
        XCTAssertEqual(state.screens["b2"]?.png, "two")
    }

    func testClosingThePanelForgetsTheFrame() {
        // Otherwise the panel reopens on however the desktop looked last
        // time, which reads as a live view of a stale moment.
        var state = CompanionState()
        state.apply(frame("stale"))
        state.clearScreen("b1")
        XCTAssertNil(state.screens["b1"])
    }

    func testBadBase64DecodesToNilRatherThanCrashing() {
        let good = ScreenFrame(png: "aGVsbG8=", mime: "image/png")
        // The failable initialiser rather than `String(decoding:as:)`: the
        // latter substitutes replacement characters for anything invalid, so
        // a decode that produced garbage would still assert equal to garbage.
        // Here a wrong answer should be nil, and nil fails the test.
        XCTAssertEqual(good.data.flatMap { String(bytes: $0, encoding: .utf8) }, "hello")
        // the view treats nil as "no frame yet", which is the right fallback
        XCTAssertNil(ScreenFrame(png: "not base64 at all!!", mime: "image/png").data)
    }
}
