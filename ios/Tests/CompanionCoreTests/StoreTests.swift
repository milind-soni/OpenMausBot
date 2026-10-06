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
        for room in try fleet().groups {
            XCTAssertEqual(state.transcript(forThread: room.threadId).count, room.messages?.count)
            XCTAssertEqual(state.hasMore[room.threadId], room.hasMore)
        }
        // One copy of each transcript: the bots and rooms do not keep the
        // hydrate-time page beside it.
        XCTAssertTrue(state.bots.allSatisfy { $0.messages == nil })
        XCTAssertTrue(state.rooms.allSatisfy { $0.messages == nil })
    }

    func testBackgroundLiveTailStillNeedsItsInitialPage() throws {
        var state = try hydrated()
        let threadId = "background-thread"
        state.bots[0].tasks = [BotTask(threadId: threadId, title: "Background", createdAt: 1)]
        let latest = message("latest", at: 3)
        state.apply(.message(threadId: threadId, message: latest))

        XCTAssertEqual(state.transcript(forThread: threadId).map(\.id), ["latest"])
        XCTAssertFalse(state.hasLoadedPage(forThread: threadId), "A live tail does not contain the initial history.")
        state.merge(ThreadPage(messages: [message("old", at: 1), message("recent", at: 2)], hasMore: true),
                    intoThread: threadId)
        XCTAssertTrue(state.hasLoadedPage(forThread: threadId))
        XCTAssertEqual(state.transcript(forThread: threadId).map(\.id), ["old", "recent", "latest"])
        XCTAssertEqual(state.hasMore[threadId], true)
    }

    func testBackgroundPatchDoesNotCountAsAPageAndEmptyLegacyPageDoes() {
        var state = CompanionState()
        state.apply(.messagePatch(threadId: "thread", message: message("patched")))
        XCTAssertFalse(state.hasLoadedPage(forThread: "thread"))
        state.merge(ThreadPage(messages: []), intoThread: "thread")
        XCTAssertTrue(state.hasLoadedPage(forThread: "thread"))
        XCTAssertEqual(state.hasMore["thread"], false)
        XCTAssertEqual(state.transcript(forThread: "thread").map(\.id), ["patched"])

        state.merge(ThreadPage(messages: [], hasMore: true), intoThread: "thread")
        state.merge(ThreadPage(messages: []), intoThread: "thread")
        XCTAssertEqual(state.hasMore["thread"], true, "An unspecified landing-window boundary preserves known scrollback.")
    }

    func testMetadataOnlyFleetDoesNotCountAsLoadedButEmptyTranscriptsDo() throws {
        var source = try fleet()
        source.bots[0].messages = nil
        source.groups[0].messages = nil
        var state = CompanionState()
        state.hydrate(source)
        XCTAssertFalse(state.hasLoadedPage(forThread: source.bots[0].threadId))
        XCTAssertFalse(state.hasLoadedPage(forThread: source.groups[0].threadId))

        source.bots[0].messages = []
        source.groups[0].messages = []
        source.bots[0].hasMore = nil
        source.groups[0].hasMore = nil
        state.hydrate(source)
        XCTAssertTrue(state.hasLoadedPage(forThread: source.bots[0].threadId))
        XCTAssertTrue(state.hasLoadedPage(forThread: source.groups[0].threadId))
    }

    func testNewOwnerFramesOnlyCountAsLoadedWhenTheyContainAPage() throws {
        var source = try fleet()
        var bot = source.bots.removeFirst()
        var room = source.groups.removeFirst()
        bot.messages = nil
        room.messages = nil
        var state = CompanionState()
        state.apply(.bot(bot))
        state.apply(.room(room))
        XCTAssertFalse(state.hasLoadedPage(forThread: bot.threadId))
        XCTAssertFalse(state.hasLoadedPage(forThread: room.threadId))

        bot.messages = []
        room.messages = []
        state.apply(.bot(bot))
        state.apply(.room(room))
        XCTAssertTrue(state.hasLoadedPage(forThread: bot.threadId))
        XCTAssertTrue(state.hasLoadedPage(forThread: room.threadId))

        state = CompanionState()
        state.apply(.bot(bot))
        state.apply(.room(room))
        XCTAssertTrue(state.hasLoadedPage(forThread: bot.threadId))
        XCTAssertTrue(state.hasLoadedPage(forThread: room.threadId))
        state.apply(.botDeleted(botId: bot.id))
        state.apply(.roomDeleted(groupId: room.id))
        XCTAssertFalse(state.hasLoadedPage(forThread: bot.threadId))
        XCTAssertFalse(state.hasLoadedPage(forThread: room.threadId))
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

    func testMergeKeepsTheLastCopyOfARepeatedIdInsteadOfTrapping() {
        // The held pages came from the computer as they were; one that
        // repeats an id must not take the launch down with it.
        var state = CompanionState()
        state.messages["t1"] = [
            message("a", at: 1, text: "first copy"),
            message("a", at: 1, text: "last copy"),
            message("b", at: 2),
        ]
        state.merge(ThreadPage(messages: [message("c", at: 3)], hasMore: false), intoThread: "t1")
        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["a", "b", "c"])
        XCTAssertEqual(state.transcript(forThread: "t1").first?.text, "last copy")
    }

    func testHydratingAWaitingThreadWhoseTranscriptRepeatsAnIdDoesNotTrap() throws {
        // Every cold start merges the waiting threads into the transcripts
        // the fleet carried: this is the path a duplicate would crash on.
        var fleet = try fleet()
        let threadId = try XCTUnwrap(fleet.bots.first?.threadId)
        fleet.bots[0].messages = [message("dup", at: 1, text: "old"), message("dup", at: 1, text: "new")]
        fleet.bots[0].activeLeafId = nil
        var approval = Message(id: "ask", role: .bot, kind: .options, at: 2)
        approval.card = OptionCard(
            title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"],
            answered: nil, dismissed: nil, requestId: "r1", tool: "Bash", held: nil, allowKey: "Bash:ls"
        )
        var state = CompanionState()
        state.hydrate(fleet, waitingThreads: [threadId: ThreadPage(messages: [approval], hasMore: false)])
        XCTAssertEqual(state.transcript(forThread: threadId).map(\.id), ["dup", "ask"])
        XCTAssertEqual(state.transcript(forThread: threadId).first?.text, "new")
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["ask"])
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
        XCTAssertEqual(state.transcript(forThread: threadId).count, count, "the thread keeps the transcript it had")
        XCTAssertEqual(state.transcript(forThread: threadId).last?.id, "keep-me")
        XCTAssertNil(state.bot(bot.id)?.messages, "the transcript lives in messages alone, not on a second copy")
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

    /// root → question → old answer, with the old answer visible.
    func editableConversation() throws -> (CompanionState, String) {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first?.threadId)
        var root = message("root", at: 1, text: "Ready")
        root.role = .bot
        var question = message("q1", at: 2, text: "first try")
        question.parentId = "root"
        var answer = message("a1", at: 3, text: "old answer")
        answer.role = .bot
        answer.parentId = "q1"
        state.messages[threadId] = [root, question, answer]
        state.apply(.thread(threadId: threadId, activeLeafId: "a1"))
        return (state, threadId)
    }

    func testPendingEditReplacesTheQuestionAndHidesTheOldAnswerAtOnce() throws {
        var (state, threadId) = try editableConversation()
        let pending = PendingEdit(sourceId: "q1", text: "second try", at: 4)
        state.pendingEdits[threadId] = pending
        let visible = state.visibleTranscript(forThread: threadId)
        XCTAssertEqual(visible.map(\.id), ["root", pending.placeholderId])
        XCTAssertEqual(visible.last?.text, "second try")
        XCTAssertEqual(visible.last?.parentId, "root")
        // nothing was folded: the computer's transcript is untouched
        XCTAssertEqual(state.transcript(forThread: threadId).map(\.id), ["root", "q1", "a1"])
        // a failed edit only drops the stand-in, so the old branch returns
        state.pendingEdits[threadId] = nil
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).map(\.id), ["root", "q1", "a1"])
    }

    func testStreamedForkTakesOverFromThePendingEdit() throws {
        var (state, threadId) = try editableConversation()
        state.pendingEdits[threadId] = PendingEdit(sourceId: "q1", text: "second try", at: 4)
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        // the computer's message frame alone is a sibling, not a child of the leaf…
        state.apply(.message(threadId: threadId, message: fork))
        // …and its leaf frame moves the branch, which retires the stand-in
        state.apply(.thread(threadId: threadId, activeLeafId: "q2"))
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).map(\.id), ["root", "q2"])
    }

    func testAdoptEditShowsTheForkWhenTheResponseBeatsTheStream() throws {
        var (state, threadId) = try editableConversation()
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        state.adoptEdit(fork, inThread: threadId)
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).map(\.id), ["root", "q2"])
    }

    func testAdoptEditNeverHidesAReplyThatAlreadyArrived() throws {
        var (state, threadId) = try editableConversation()
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        state.apply(.message(threadId: threadId, message: fork))
        state.apply(.thread(threadId: threadId, activeLeafId: "q2"))
        var reply = message("a2", at: 5, text: "new answer")
        reply.role = .bot
        reply.parentId = "q2"
        state.apply(.message(threadId: threadId, message: reply))
        state.adoptEdit(fork, inThread: threadId)
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).map(\.id), ["root", "q2", "a2"])
    }

    func testLateEditResponseDoesNotUndoBranchSelectionOrANewerEdit() throws {
        var (state, threadId) = try editableConversation()
        let pending = PendingEdit(sourceId: "q1", text: "second try", baseLeafId: "a1")
        state.pendingEdits[threadId] = pending
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        state.apply(.thread(threadId: threadId, activeLeafId: "root"))
        state.adoptEdit(fork, inThread: threadId, expectedPending: pending)
        XCTAssertEqual(state.activeLeafIds[threadId], "root")
        XCTAssertTrue(state.transcript(forThread: threadId).contains { $0.id == "q2" })

        state.apply(.thread(threadId: threadId, activeLeafId: "a1"))
        state.pendingEdits[threadId] = PendingEdit(sourceId: "q1", text: "newer try", baseLeafId: "a1")
        state.adoptEdit(fork, inThread: threadId, expectedPending: pending)
        XCTAssertEqual(state.activeLeafIds[threadId], "a1")
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).last?.text, "newer try")
    }

    func testMatchingEditResponseCanSelectTheFork() throws {
        var (state, threadId) = try editableConversation()
        let pending = PendingEdit(sourceId: "q1", text: "second try", baseLeafId: "a1")
        state.pendingEdits[threadId] = pending
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        state.adoptEdit(fork, inThread: threadId, expectedPending: pending)
        XCTAssertEqual(state.visibleTranscript(forThread: threadId).last?.id, "q2")
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

    func testAnUnforkedThreadIsItsOwnBranch() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        var chain: [Message] = []
        for index in 0..<40 {
            var next = message("m\(index)", at: Double(index))
            next.parentId = chain.last?.id
            chain.append(next)
        }
        state.messages[bot.threadId] = chain
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "m39"))
        XCTAssertEqual(state.visibleTranscript(forThread: bot.threadId).map(\.id), chain.map(\.id))
        // a leaf further up hides what follows it
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "m9"))
        XCTAssertEqual(state.visibleTranscript(forThread: bot.threadId).map(\.id), chain.prefix(10).map(\.id))
    }

    func testBranchWalkKeepsTheNewestCopyOfARepeatedIdAndStopsOnACycle() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        let first = message("a", at: 1, text: "older a")
        var second = message("b", at: 2)
        second.parentId = "a"
        var repeated = message("a", at: 3, text: "newer a")
        repeated.parentId = "b"
        state.messages[bot.threadId] = [first, second, repeated]
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "a"))
        // the newest "a" is the leaf; its parent "b" points back at it
        let visible = state.visibleTranscript(forThread: bot.threadId)
        XCTAssertEqual(visible.map(\.id), ["b", "a"])
        XCTAssertEqual(visible.last?.text, "newer a")
    }

    func testLastVisibleMessageIsTheVisibleBranchsLast() throws {
        var (state, threadId) = try editableConversation()
        func check(_ label: String, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertEqual(
                state.lastVisibleMessage(forThread: threadId)?.id,
                state.visibleTranscript(forThread: threadId).last?.id,
                label, file: file, line: line
            )
        }
        check("leaf at the end")
        var fork = message("q2", at: 4, text: "second try")
        fork.parentId = "root"
        state.messages[threadId]?.append(fork)
        check("a fork appended after the leaf")
        state.apply(.thread(threadId: threadId, activeLeafId: "q2"))
        check("the fork selected")
        state.apply(.thread(threadId: threadId, activeLeafId: "nowhere"))
        check("a leaf the transcript does not hold")
        state.apply(.thread(threadId: threadId, activeLeafId: "a1"))
        state.pendingEdits[threadId] = PendingEdit(sourceId: "q1", text: "third try", at: 5)
        check("an edit in flight")
        state.pendingEdits[threadId] = nil
        state.messages[threadId]?.append(message("a1", at: 6, text: "replayed"))
        check("a repeated id")
        XCTAssertEqual(state.lastVisibleMessage(forThread: threadId)?.text, "replayed")
        XCTAssertNil(state.lastVisibleMessage(forThread: "missing"))
    }

    func testAnApprovalOnAnotherBranchIsNotPending() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        let root = message("root")
        var hidden = Message(id: "hidden-ask", role: .bot, kind: .options, at: 2)
        hidden.parentId = root.id
        hidden.card = OptionCard(
            title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"],
            answered: nil, dismissed: nil, requestId: "r1", tool: "Bash", held: nil, allowKey: "Bash:ls"
        )
        var visible = message("visible", at: 3)
        visible.parentId = root.id
        state.messages[bot.threadId] = [root, hidden, visible]
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "visible"))
        XCTAssertFalse(state.pendingApprovals.contains { $0.message.id == "hidden-ask" })
        state.apply(.thread(threadId: bot.threadId, activeLeafId: "hidden-ask"))
        XCTAssertTrue(state.pendingApprovals.contains { $0.message.id == "hidden-ask" })
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
        XCTAssertEqual(state.userMessageVersions(inThread: "t1")[root.id]?.map(\.id), ["first", "second"])
        XCTAssertEqual(state.userMessageVersions(inThread: "t1")[nil]?.map(\.id), [root.id])
        XCTAssertTrue(state.versions(of: reply, inThread: "t1").isEmpty)
    }

    func testGroupedVersionsKeepChronologicalTieOrderAndThreadIsolation() {
        var state = CompanionState()
        var first = message("a", at: 2)
        first.parentId = "parent"
        var second = message("b", at: 2)
        second.parentId = "parent"
        var other = message("other", at: 1)
        other.parentId = "different-parent"
        state.messages["one"] = [second, other, first]
        state.messages["two"] = [message("other-thread", at: 0)]
        let groups = state.userMessageVersions(inThread: "one")
        XCTAssertEqual(groups["parent"]?.map(\.id), ["a", "b"])
        XCTAssertEqual(groups["different-parent"]?.map(\.id), ["other"])
        XCTAssertNil(groups[nil])
        XCTAssertTrue(state.userMessageVersions(inThread: "missing").isEmpty)
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

    // MARK: - Live calls

    private func liveCall(_ status: LiveCallState.Status) -> LiveCallState {
        LiveCallState(callId: "c1", botId: "b1", threadId: "t1", client: "desktop", voice: "marin", startedAt: 1, status: status)
    }

    func testALiveCallFrameReplacesTheCallAndNullClearsIt() throws {
        var state = try hydrated()
        XCTAssertNil(state.liveCall)
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.connecting)))
        XCTAssertEqual(state.liveCall?.status, .connecting)
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        XCTAssertEqual(state.liveCall?.status, .live)
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.ended)))
        XCTAssertEqual(state.liveCall?.status, .ended, "the ended state stays until the harness clears it: the bar reads the reason from it")
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: nil))
        XCTAssertNil(state.liveCall)
    }

    func testTheMacsAnswerToAHangUpReplacesTheCallAtOnce() throws {
        var state = try hydrated()
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        var ended = liveCall(.ended)
        ended.endReason = "hung-up"
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: ended))
        XCTAssertEqual(state.liveCall, ended, "the remote bar goes without waiting for the frame")
    }

    func testAnOlderAnswerToAHangUpDoesNotUndoLaterFrames() throws {
        var state = try hydrated()
        var ended = liveCall(.ended)
        ended.endReason = "hung-up"

        // the frame already cleared the line
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: ended))
        XCTAssertNil(state.liveCall)

        // the frame already said ended, with the Mac's own reason
        var idle = liveCall(.ended)
        idle.endReason = "idle"
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: idle))
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: ended))
        XCTAssertEqual(state.liveCall, idle)

        // a newer call is on the line now
        var newer = liveCall(.live)
        newer.callId = "c2"
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: newer))
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: ended))
        XCTAssertEqual(state.liveCall, newer)
    }

    func testAHangUpTheMacNoLongerKnowsAsksForTheLine() throws {
        // 404: the Mac runs no such call, yet it reads as running here — a
        // frame was missed. Not a guess at the line: Session asks for it.
        var state = try hydrated()
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        XCTAssertTrue(state.applyLiveCallEnd(callId: "c1", answer: nil))
        XCTAssertEqual(state.liveCall, liveCall(.live), "left for the lookup to replace")

        state.apply(.liveCall(botId: "b1", threadId: "t1", call: nil))
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: nil), "nothing stale to look up")
    }

    func testALookupThatStraddledAFrameIsDropped() throws {
        // GET /api/live/call goes out with the line empty; a start's frame
        // lands while it is out; the lookup's older `null` must not end the
        // call that just began
        var state = try hydrated()
        let revision = state.liveCallRevision
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.connecting)))
        XCTAssertFalse(state.applyLiveCallLookup(nil, ifRevisionIs: revision))
        XCTAssertEqual(state.liveCall, liveCall(.connecting))
    }

    func testALookupThatStraddledAHangUpAnswerIsDropped() throws {
        // no frame, but the remote bar's hang-up answer changed the line
        var state = try hydrated()
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        let revision = state.liveCallRevision
        var ended = liveCall(.ended)
        ended.endReason = "hung-up"
        XCTAssertFalse(state.applyLiveCallEnd(callId: "c1", answer: ended))
        XCTAssertFalse(state.applyLiveCallLookup(liveCall(.live), ifRevisionIs: revision))
        XCTAssertEqual(state.liveCall, ended)
    }

    func testALookupThatStraddledAFrameRestatingTheLineIsStillDropped() throws {
        // a frame that wrote the same value is still newer than the answer
        var state = try hydrated()
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        let revision = state.liveCallRevision
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        XCTAssertFalse(state.applyLiveCallLookup(nil, ifRevisionIs: revision))
        XCTAssertEqual(state.liveCall, liveCall(.live))
    }

    func testALookupOutWhileOtherFramesFoldIsApplied() throws {
        // The stream keeps folding while the lookup is out — tokens, tool
        // steps, the cursor moving. None of it is about the line, so a phone
        // that connects mid-call under a busy fleet still learns of the call.
        var state = try hydrated()
        state.resetCursor("abc12345:7")
        let revision = state.liveCallRevision
        state.applyBatch([
            StreamFrame(frame: .runtime(RuntimeEvent(type: "content.delta", threadId: "t1", delta: "hi", streamKind: "assistant_text")), seq: 8),
            StreamFrame(frame: .message(threadId: "t1", message: Message(id: "m-live", role: .bot, kind: .text, at: 9)), seq: 9),
        ])
        XCTAssertEqual(state.cursor, "abc12345:9")
        XCTAssertTrue(state.applyLiveCallLookup(liveCall(.live), ifRevisionIs: revision))
        XCTAssertEqual(state.liveCall, liveCall(.live))
    }

    func testALookupWithNothingNewerMeanwhileIsApplied() throws {
        var state = try hydrated()
        XCTAssertTrue(state.applyLiveCallLookup(liveCall(.live), ifRevisionIs: state.liveCallRevision))
        XCTAssertEqual(state.liveCall, liveCall(.live), "a phone that connects mid-call learns about it")
        XCTAssertTrue(state.applyLiveCallLookup(nil, ifRevisionIs: state.liveCallRevision))
        XCTAssertNil(state.liveCall)
    }

    func testHydrateLeavesTheLineRevisionAlone() throws {
        // hydrate does not touch the line, so a lookup that straddles a
        // hydrate (notification navigation) still lands
        var state = try hydrated()
        let revision = state.liveCallRevision
        state.hydrate(try fleet())
        XCTAssertEqual(state.liveCallRevision, revision)
    }

    func testHydrateKeepsTheCallTheStreamReported() throws {
        // hydrate replaces the fleet, not the line; Session refreshes the
        // call separately with GET /api/live/call
        var state = CompanionState()
        state.apply(.liveCall(botId: "b1", threadId: "t1", call: liveCall(.live)))
        state.hydrate(try fleet())
        XCTAssertEqual(state.liveCall?.callId, "c1")
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
