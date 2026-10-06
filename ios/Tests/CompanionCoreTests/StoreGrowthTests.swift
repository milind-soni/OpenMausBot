// The transcript's growth and the indexes the fold keeps beside it.
//
// A phone left connected to a working fleet for hours folds tens of
// thousands of messages. These pin the three things that keep that cheap
// without changing what anyone sees: a frame changes its thread in place
// rather than copying it, a thread holds a bounded window that Load earlier
// can always page back past, and the indexes (`pendingCardThreads`, the
// unforked-chain shortcut) always agree with a full scan.
import XCTest
@testable import CompanionCore

final class StoreGrowthTests: XCTestCase {
    /// A small window, so a trim is a few dozen frames away rather than six
    /// hundred: every rule is the same at any size, and the real size has
    /// its own test below.
    private let held = 40
    private let slack = 10

    // MARK: - Fixtures

    private func templateBot() throws -> Bot {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try XCTUnwrap(try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)).bots.first)
    }

    private func templateRoom() throws -> Room {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try XCTUnwrap(try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)).groups.first)
    }

    private func text(_ id: String, at: Double, parent: String?) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = "line \(id)"
        message.parentId = parent
        return message
    }

    private func card(_ id: String, at: Double, parent: String?, answered: String? = nil) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: at)
        message.parentId = parent
        message.card = OptionCard(
            title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
            answered: answered, requestId: "request-\(id)", tool: "Bash"
        )
        return message
    }

    /// One bot on `thread`, whose transcript starts as `seed`.
    private func state(thread: String = "thread", seed: [Message], window: (held: Int, slack: Int)? = nil) throws -> CompanionState {
        var bot = try templateBot()
        bot.id = "bot"
        bot.threadId = thread
        bot.tasks = [BotTask(threadId: thread, title: "Task", createdAt: 1)]
        bot.messages = seed
        bot.activeLeafId = seed.last?.id
        bot.hasMore = false
        var state = CompanionState()
        state.window = window ?? (held: held, slack: slack)
        state.hydrate(Fleet(bots: [bot], groups: []))
        return state
    }

    /// Append `count` messages to `thread`, each the child of the last.
    private func grow(_ state: inout CompanionState, thread: String = "thread", by count: Int, from start: Int) {
        for index in start..<(start + count) {
            let parent = state.transcript(forThread: thread).last?.id
            state.apply(.message(threadId: thread, message: text("m\(index)", at: Double(index), parent: parent)))
        }
    }

    private func chain(_ range: Range<Int>, parentOfFirst: String? = nil) -> [Message] {
        range.map { text("m\($0)", at: Double($0), parent: $0 == range.lowerBound ? parentOfFirst : "m\($0 - 1)") }
    }

    private func bufferAddress(_ state: CompanionState, _ thread: String) -> UInt {
        state.messages[thread]!.withUnsafeBufferPointer { UInt(bitPattern: $0.baseAddress) }
    }

    // MARK: - In place

    func testAMessageFrameAppendsInPlaceRatherThanCopyingTheThread() throws {
        // Build the thread through the fold, so nothing else holds its buffer.
        var state = try state(seed: [], window: (CompanionState.heldMessages, CompanionState.trimSlack))
        grow(&state, by: 300, from: 0)
        var appendsWithRoom = 0
        for index in 300..<450 {
            var hadRoom = false
            var address: UInt = 0
            do {
                // scoped, so this read is not a second owner during the append
                let before = state.messages["thread"]!
                hadRoom = before.count < before.capacity
                address = before.withUnsafeBufferPointer { UInt(bitPattern: $0.baseAddress) }
            }
            grow(&state, by: 1, from: index)
            if hadRoom {
                appendsWithRoom += 1
                XCTAssertEqual(bufferAddress(state, "thread"), address, "frame \(index) copied the thread to append one message")
            }
        }
        XCTAssertGreaterThan(appendsWithRoom, 100, "the check above must actually have run")
    }

    func testAPatchReplacesInPlace() throws {
        var state = try state(seed: [], window: (CompanionState.heldMessages, CompanionState.trimSlack))
        grow(&state, by: 200, from: 0)
        let address = bufferAddress(state, "thread")
        for index in stride(from: 0, to: 200, by: 7) {
            var patched = text("m\(index)", at: Double(index), parent: index == 0 ? nil : "m\(index - 1)")
            patched.text = "edited"
            state.apply(.messagePatch(threadId: "thread", message: patched))
        }
        XCTAssertEqual(bufferAddress(state, "thread"), address)
        XCTAssertEqual(state.transcript(forThread: "thread")[7].text, "edited")
        XCTAssertEqual(state.transcript(forThread: "thread").count, 200)
    }

    func testBotsAndRoomsCarryNoSecondCopyOfTheTranscript() throws {
        var bot = try templateBot()
        var room = try templateRoom()
        var state = CompanionState()
        state.hydrate(Fleet(bots: [bot], groups: [room]))
        state.apply(.message(threadId: bot.threadId, message: text("live", at: 9e15, parent: nil)))

        // a metadata frame, a task switch, a new bot and a new room
        bot.messages = nil
        bot.busy = true
        state.apply(.bot(bot))
        XCTAssertNil(state.bot(bot.id)?.messages)
        XCTAssertEqual(state.transcript(forThread: bot.threadId).last?.id, "live")
        bot.threadId = "switched"
        bot.messages = [text("root", at: 1, parent: nil)]
        state.apply(.bot(bot))
        XCTAssertNil(state.bot(bot.id)?.messages)
        XCTAssertEqual(state.transcript(forThread: "switched").map(\.id), ["root"])
        var added = bot
        added.id = "another"
        added.threadId = "another-thread"
        added.messages = [text("first", at: 1, parent: nil)]
        state.apply(.bot(added))
        XCTAssertNil(state.bot("another")?.messages)
        XCTAssertEqual(state.transcript(forThread: "another-thread").map(\.id), ["first"])

        room.messages = [text("room-root", at: 1, parent: nil)]
        room.threadId = "room-switched"
        state.apply(.room(room))
        var newRoom = room
        newRoom.id = "new-room"
        newRoom.threadId = "new-room-thread"
        state.apply(.room(newRoom))
        XCTAssertTrue(state.rooms.allSatisfy { $0.messages == nil })
        XCTAssertEqual(state.transcript(forThread: "room-switched").map(\.id), ["room-root"])
        XCTAssertEqual(state.transcript(forThread: "new-room-thread").map(\.id), ["room-root"])
    }

    // MARK: - The bound

    func testALiveThreadKeepsItsNewestWindowAndSaysThereIsMore() throws {
        // The real window: a chat opens on 50, holds at most 600.
        let held = CompanionState.heldMessages
        let slack = CompanionState.trimSlack
        XCTAssertEqual(CompanionState().window.held, held)
        XCTAssertEqual(CompanionState().window.slack, slack)
        var state = try state(seed: chain(0..<50), window: (held, slack))
        XCTAssertEqual(state.hasMore["thread"], false)
        var largest = 0
        for index in 50..<(50 + 2 * (held + slack)) {
            grow(&state, by: 1, from: index)
            largest = max(largest, state.transcript(forThread: "thread").count)
        }
        XCTAssertEqual(largest, held + slack, "a thread never holds more than the window and its slack")
        let transcript = state.transcript(forThread: "thread")
        let newest = 50 + 2 * (held + slack) - 1
        XCTAssertEqual(transcript.last?.id, "m\(newest)", "nothing new is ever trimmed")
        XCTAssertEqual(transcript.map(\.id), (newest - transcript.count + 1...newest).map { "m\($0)" }, "the newest, contiguous, in order")
        XCTAssertGreaterThanOrEqual(transcript.count, held)
        XCTAssertEqual(state.hasMore["thread"], true, "Load earlier has something to fetch")
        XCTAssertTrue(state.hasLoadedPage(forThread: "thread"))
        XCTAssertEqual(state.visibleTranscript(forThread: "thread"), transcript, "the branch is still the whole held chain")
    }

    func testLoadEarlierAfterATrimPagesBackFromTheFirstHeldMessage() throws {
        var state = try state(seed: [])
        grow(&state, by: held + slack + 1, from: 0)
        let first = try XCTUnwrap(state.transcript(forThread: "thread").first)
        XCTAssertEqual(first.id, "m\(slack + 1)")
        XCTAssertEqual(state.hasMore["thread"], true)

        // What Session.loadOlder asks for: the page before the first held
        // message, which is exactly what was trimmed.
        let trimmed = slack + 1
        state.prepend(ThreadPage(messages: chain(0..<trimmed), hasMore: false), toThread: "thread")
        XCTAssertEqual(state.transcript(forThread: "thread").map(\.id), (0..<(held + trimmed)).map { "m\($0)" })
        XCTAssertEqual(state.hasMore["thread"], false)
        XCTAssertEqual(state.visibleTranscript(forThread: "thread").count, held + trimmed, "one chain again")

        // The page the reader fetched stays while they read it: a busy
        // thread does not pull it out from under them...
        let afterPage = held + slack + 1
        grow(&state, by: held, from: afterPage)
        XCTAssertEqual(state.transcript(forThread: "thread").first?.id, "m0")
        XCTAssertEqual(state.transcript(forThread: "thread").count, 2 * held + trimmed)
        // ...until a whole window of newer messages has arrived after it.
        grow(&state, by: 1, from: afterPage + held)
        XCTAssertEqual(state.transcript(forThread: "thread").count, held)
        XCTAssertEqual(state.transcript(forThread: "thread").last?.id, "m\(afterPage + held)")
        XCTAssertEqual(state.hasMore["thread"], true)
    }

    func testASearchLandingSurvivesTheNextWindowOfLiveMessages() throws {
        var state = try state(seed: [])
        grow(&state, by: held + 5, from: 1_000)
        // a window around an old hit, sorted in above the live tail
        state.merge(ThreadPage(messages: chain(10..<20), hasMore: true), intoThread: "thread")
        grow(&state, by: held, from: 1_000 + held + 5)
        XCTAssertEqual(state.transcript(forThread: "thread").first?.id, "m10", "the landing is still there to read")
    }

    func testAnOpenCardIsNeverTrimmed() throws {
        var state = try state(seed: [card("ask", at: 0, parent: nil)])
        grow(&state, by: 2 * (held + slack), from: 1)
        XCTAssertEqual(state.transcript(forThread: "thread").first?.id, "ask", "trimming stops at the open card")
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["ask"])

        // Once it is answered, the next growth past the slack trims as usual.
        state.apply(.messagePatch(threadId: "thread", message: card("ask", at: 0, parent: nil, answered: "Allow")))
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        grow(&state, by: 1, from: 2 * (held + slack) + 1)
        XCTAssertEqual(state.transcript(forThread: "thread").count, held)
    }

    func testTheBranchHeadIsNeverTrimmed() throws {
        // The reader picked an early version; the bot keeps writing on
        // another branch without moving this thread's head.
        var state = try state(seed: chain(0..<10))
        state.apply(.thread(threadId: "thread", activeLeafId: "m5"))
        for index in 10..<(10 + 2 * (held + slack)) {
            state.apply(.message(threadId: "thread", message: text("m\(index)", at: Double(index), parent: "m\(index - 1)")))
        }
        XCTAssertEqual(state.transcript(forThread: "thread").first?.id, "m5")
        XCTAssertEqual(state.visibleTranscript(forThread: "thread").map(\.id), ["m5"])
        XCTAssertEqual(state.lastVisibleMessage(forThread: "thread")?.id, "m5")
    }

    func testALatePatchForATrimmedMessageStaysHistory() throws {
        var state = try state(seed: [])
        grow(&state, by: held + slack + 1, from: 0)
        let before = state.transcript(forThread: "thread")
        XCTAssertFalse(before.contains { $0.id == "m3" })

        // The harness drops an old screenshot's pixels, moves an old routine
        // card on: a change to history, not the newest line.
        var patched = text("m3", at: 3, parent: "m2")
        patched.text = "pixels dropped"
        state.apply(.messagePatch(threadId: "thread", message: patched))
        var boundary = text("m\(slack)", at: Double(slack), parent: "m\(slack - 1)")
        boundary.text = "the newest trimmed one"
        state.apply(.messagePatch(threadId: "thread", message: boundary))
        XCTAssertEqual(state.transcript(forThread: "thread"), before)

        // A patch for something newer we never saw is still appended, as
        // before; so is any message frame, which is always a new line.
        state.apply(.messagePatch(threadId: "thread", message: text("never-seen", at: 9_999, parent: nil)))
        XCTAssertEqual(state.transcript(forThread: "thread").last?.id, "never-seen")
        state.apply(.message(threadId: "thread", message: text("old-stamp", at: 1, parent: "never-seen")))
        XCTAssertEqual(state.transcript(forThread: "thread").last?.id, "old-stamp")
    }

    func testABackgroundLiveTailThatOutgrowsTheWindowCountsAsPaged() throws {
        // A background task's thread fills from frames alone; once trimmed,
        // its first held message is a boundary Load earlier pages from.
        var state = try state(seed: [])
        state.bots[0].tasks?.append(BotTask(threadId: "background", title: "Background", createdAt: 2))
        grow(&state, thread: "background", by: held, from: 0)
        XCTAssertFalse(state.hasLoadedPage(forThread: "background"))
        grow(&state, thread: "background", by: slack + 1, from: held)
        XCTAssertTrue(state.hasLoadedPage(forThread: "background"))
        XCTAssertEqual(state.hasMore["background"], true)
    }

    func testTheHeldTranscriptIsAlwaysTheNewestPartOfTheWholeOne() throws {
        // The old fold, unbounded, as the reference: append or replace by id.
        var generator = SeededGenerator(seed: 0x5EED)
        var state = try state(seed: [])
        var whole: [Message] = []
        var positions: [String: Int] = [:]
        var next = 0
        for _ in 0..<1_500 {
            let message: Message
            let frame: Frame
            let roll = Int.random(in: 0..<100, using: &generator)
            if roll < 70 || whole.isEmpty {
                // new lines arrive as message frames, which move the head
                message = text("m\(next)", at: Double(next), parent: whole.last?.id)
                frame = .message(threadId: "thread", message: message)
                next += 1
            } else if roll < 90 {
                // a patch of anything ever sent, held or long since trimmed
                var old = whole[Int.random(in: 0..<whole.count, using: &generator)]
                old.text = "patched \(roll)"
                message = old
                frame = .messagePatch(threadId: "thread", message: message)
            } else {
                // a resumed stream replaying a line it already delivered
                let heldNow = state.transcript(forThread: "thread")
                message = heldNow[Int.random(in: max(0, heldNow.count - 5)..<heldNow.count, using: &generator)]
                frame = .message(threadId: "thread", message: message)
            }
            state.apply(frame)
            if let index = positions[message.id] {
                whole[index] = message
            } else {
                positions[message.id] = whole.count
                whole.append(message)
            }
            let heldNow = state.transcript(forThread: "thread")
            XCTAssertEqual(heldNow.last, whole.last)
            XCTAssertEqual(heldNow, Array(whole.suffix(heldNow.count)))
            XCTAssertLessThanOrEqual(heldNow.count, held + slack)
            if heldNow.count < whole.count { XCTAssertEqual(state.hasMore["thread"], true) }
        }
        XCTAssertGreaterThan(whole.count, 10 * held, "the window must actually have moved")
    }

    // MARK: - The cursor

    func testTheCursorMovesOncePerBatchToTheLastSequencedFrame() {
        var state = CompanionState()
        state.resetCursor("stream:1")
        state.applyBatch([
            StreamFrame(frame: .message(threadId: "t", message: text("a", at: 1, parent: nil)), seq: 2),
            StreamFrame(frame: .message(threadId: "t", message: text("b", at: 2, parent: "a")), seq: 3),
            StreamFrame(frame: .hello(cursor: "other:9", resumed: true), seq: nil),
        ])
        XCTAssertEqual(state.cursor, "stream:3")
        state.applyBatch([StreamFrame(frame: .hello(cursor: "other:9", resumed: true), seq: nil)])
        XCTAssertEqual(state.cursor, "stream:3")
        state.applyBatch([])
        XCTAssertEqual(state.cursor, "stream:3")
    }

    // MARK: - Indexes agree with a full scan

    func testAnsweringTheOnlyOpenCardTakesTheThreadOutOfTheIndex() throws {
        var state = try state(seed: [text("root", at: 0, parent: nil)])
        state.apply(.message(threadId: "thread", message: card("first", at: 1, parent: "root")))
        state.apply(.message(threadId: "thread", message: card("second", at: 2, parent: "first")))
        XCTAssertEqual(state.pendingCardThreads, ["thread"])
        state.apply(.messagePatch(threadId: "thread", message: card("first", at: 1, parent: "root", answered: "Allow")))
        XCTAssertEqual(state.pendingCardThreads, ["thread"], "the second card is still open")
        state.apply(.messagePatch(threadId: "thread", message: card("second", at: 2, parent: "first", answered: "Deny")))
        XCTAssertEqual(state.pendingCardThreads, [])
        XCTAssertTrue(state.pendingApprovals.isEmpty)
    }

    func testAReparentedMessageTakesTheThreadOffTheChainShortcut() throws {
        // m3 now follows m1: the branch to m4 skips m2, as the walk says.
        var state = try state(seed: chain(0..<5))
        XCTAssertEqual(state.visibleTranscript(forThread: "thread").map(\.id), ["m0", "m1", "m2", "m3", "m4"])
        state.apply(.messagePatch(threadId: "thread", message: text("m3", at: 3, parent: "m1")))
        XCTAssertEqual(state.visibleTranscript(forThread: "thread").map(\.id), ["m0", "m1", "m3", "m4"])
        XCTAssertEqual(state.visibleTranscript(forThread: "thread"), Reference.visibleTranscript(state, "thread"))
    }

    func testALateArtifactInsertedAboveTheHeadReadsInOrder() throws {
        // The harness's insertMessageAfter: a screenshot that settled after
        // the reader already sent their next line goes in above it, and the
        // line is re-parented onto it. The head does not move.
        var state = try state(seed: chain(0..<3))
        state.apply(.message(threadId: "thread", message: text("next", at: 3, parent: "m2")))
        state.apply(.message(threadId: "thread", message: text("shot", at: 4, parent: "m2")))
        state.apply(.messagePatch(threadId: "thread", message: text("next", at: 3, parent: "shot")))
        XCTAssertEqual(state.visibleTranscript(forThread: "thread").map(\.id), ["m0", "m1", "m2", "shot", "next"])
        XCTAssertEqual(state.visibleTranscript(forThread: "thread"), Reference.visibleTranscript(state, "thread"))
    }

    func testIndexesMatchAFullScanAcrossRandomFrames() throws {
        for seed: UInt64 in [1, 2, 3, 4, 5, 6, 7, 8] {
            var fuzz = try Fuzz(seed: seed, bot: templateBot(), room: templateRoom())
            for step in 0..<600 {
                let (label, touched) = fuzz.step()
                // The touched thread every step, every thread every tenth.
                let threads = step % 10 == 0 || touched == nil ? Array(fuzz.state.messages.keys) : [touched!]
                try check(fuzz.state, "seed \(seed), step \(step), after \(label)", threads: threads, updates: step % 10 == 0)
            }
            XCTAssertGreaterThan(fuzz.trims, 10, "seed \(seed) barely moved a window")
        }
    }

    /// The full scans the fold used before it kept indexes — the old code,
    /// verbatim in substance — against what the indexes now answer.
    private func check(
        _ state: CompanionState, _ label: String, threads: [String], updates: Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let scanned = Set(state.messages.filter { $0.value.contains { $0.card?.isPending == true } }.keys)
        guard state.pendingCardThreads == scanned else {
            XCTFail("pendingCardThreads \(state.pendingCardThreads.sorted()) != scan \(scanned.sorted()) — \(label)", file: file, line: line)
            throw Stop()
        }
        for threadId in threads {
            let expected = Reference.visibleTranscript(state, threadId)
            guard state.visibleTranscript(forThread: threadId) == expected else {
                XCTFail("visibleTranscript(\(threadId)) differs — \(label)", file: file, line: line)
                throw Stop()
            }
            guard state.lastVisibleMessage(forThread: threadId) == expected.last else {
                XCTFail("lastVisibleMessage(\(threadId)) differs — \(label)", file: file, line: line)
                throw Stop()
            }
        }
        let approvals = state.pendingApprovals.map { "\($0.threadId)/\($0.message.id)@\($0.message.at)" }
        let reference = Reference.pendingApprovals(state).map { "\($0.threadId)/\($0.message.id)@\($0.message.at)" }
        guard approvals == reference else {
            XCTFail("pendingApprovals \(approvals) != \(reference) — \(label)", file: file, line: line)
            throw Stop()
        }
        // Built from the two above; the slowest check, so not every step.
        for detail in updates ? [ActivityDetail.full, .hidden] : [] {
            guard state.updates(detail: detail) == state.updates(detail: detail, pendingApprovals: Reference.pendingApprovals(state)) else {
                XCTFail("updates(\(detail)) differ — \(label)", file: file, line: line)
                throw Stop()
            }
        }
    }

    private struct Stop: Error {}
}

// MARK: - The old algorithms

/// `activeBranch`, `visibleTranscript` and `pendingApprovals` as they were
/// before the fold kept indexes: hash every id, scan every message.
private enum Reference {
    static func activeBranch(_ state: CompanionState, _ threadId: String) -> [Message] {
        let all = state.messages[threadId] ?? []
        guard let leafId = state.activeLeafIds[threadId] ?? state.bot(forThread: threadId)?.activeLeafId else { return all }
        var positions: [String: Int] = [:]
        for position in all.indices { positions[all[position].id] = position }
        guard var current = positions[leafId] else { return all }
        var path: [Int] = []
        var visited = Set<Int>()
        while visited.insert(current).inserted {
            path.append(current)
            guard let parentId = all[current].parentId, let parent = positions[parentId] else { break }
            current = parent
        }
        return path.reversed().map { all[$0] }
    }

    static func visibleTranscript(_ state: CompanionState, _ threadId: String) -> [Message] {
        let branch = activeBranch(state, threadId)
        guard let pending = state.pendingEdits[threadId],
              let index = branch.firstIndex(where: { $0.id == pending.sourceId }) else { return branch }
        let source = branch[index]
        var standIn = Message(id: pending.placeholderId, role: .user, kind: .text, at: pending.at)
        standIn.text = pending.text
        standIn.parentId = source.parentId
        return Array(branch[..<index]) + [standIn]
    }

    static func pendingApprovals(_ state: CompanionState) -> [(threadId: String, message: Message)] {
        var out: [(threadId: String, message: Message)] = []
        let activeThreads = Set(state.bots.flatMap { [$0.threadId] + ($0.tasks ?? []).map(\.threadId) } + state.rooms.map(\.threadId))
        for threadId in activeThreads.sorted() {
            guard state.messages[threadId]?.contains(where: { $0.card?.isPending == true }) == true else { continue }
            for message in visibleTranscript(state, threadId) where message.card?.isPending == true {
                out.append((threadId: threadId, message: message))
            }
        }
        return out.sorted { $0.message.at > $1.message.at }
    }
}

// MARK: - Random frames

/// A small fleet driven by random frames of every kind that writes a
/// transcript: new lines (mostly chained, sometimes forked or rootless),
/// cards opened and answered, patches and replays of held, trimmed and
/// never-seen ids, branch switches, task switches, pages, outside writes,
/// edits in flight, and bursts long enough to trim.
private struct Fuzz {
    var state = CompanionState()
    var generator: SeededGenerator
    let bot: Bot
    let room: Room
    let threads = ["bot-main", "bot-task", "room-main", "orphan"]
    var clock = 1_000.0
    var older = 999.0
    var next = 0
    /// Every message ever sent, by thread, so patches can name trimmed ids.
    var sent: [String: [Message]] = [:]
    /// Steps after which some thread's trimmed history reached further.
    var trims = 0

    init(seed: UInt64, bot template: Bot, room roomTemplate: Room) {
        generator = SeededGenerator(seed: seed)
        var bot = template
        bot.id = "bot"
        bot.threadId = "bot-main"
        bot.tasks = [BotTask(threadId: "bot-main", title: "Main", createdAt: 1),
                     BotTask(threadId: "bot-task", title: "Task", createdAt: 2)]
        bot.messages = []
        bot.activeLeafId = nil
        var room = roomTemplate
        room.id = "room"
        room.threadId = "room-main"
        room.messages = []
        self.bot = bot
        self.room = room
        // A small window, so threads trim (and pin, and page) every few
        // dozen frames rather than every six hundred.
        state.window = (held: 30, slack: 10)
        state.hydrate(Fleet(bots: [bot], groups: [room]))
    }

    mutating func roll(_ upper: Int) -> Int { Int.random(in: 0..<upper, using: &generator) }
    mutating func pick<T>(_ items: [T]) -> T? { items.isEmpty ? nil : items[roll(items.count)] }

    mutating func fresh(parent: String?, at: Double? = nil, cards: Bool = true) -> Message {
        next += 1
        clock += 1
        let pending = cards && roll(100) < 5
        var message = Message(id: "x\(next)", role: roll(2) == 0 ? .bot : .user, kind: pending ? .options : .text, at: at ?? clock)
        message.text = "line \(next)"
        message.parentId = parent
        if pending {
            message.card = OptionCard(title: "Ask", subtitle: "q\(next)", options: ["Yes", "No"], requestId: "r\(next)")
        }
        return message
    }

    mutating func send(_ message: Message, to thread: String, patch: Bool, new: Bool = false) {
        state.apply(patch ? .messagePatch(threadId: thread, message: message) : .message(threadId: thread, message: message))
        if new {
            sent[thread, default: []].append(message)
        } else if let index = sent[thread]?.firstIndex(where: { $0.id == message.id }) {
            sent[thread]![index] = message
        } else {
            sent[thread, default: []].append(message)
        }
    }

    /// What happened, and the one thread it touched (nil: several).
    mutating func step() -> (String, String?) {
        let thread = pick(threads)!
        let before = state.trimmedThrough
        let label = act(thread)
        if state.trimmedThrough.contains(where: { before[$0.key] != $0.value }) { trims += 1 }
        let several = ["bot ", "room ", "outside "].contains { label.hasPrefix($0) }
        return (label, several ? nil : thread)
    }

    /// Where the bot writes next: the branch head, as the harness does.
    func head(_ thread: String) -> String? {
        state.activeLeafIds[thread] ?? state.transcript(forThread: thread).last?.id
    }

    private mutating func act(_ thread: String) -> String {
        let heldNow = state.transcript(forThread: thread)
        let operation = roll(100)
        switch operation {
        case 0..<36:
            let parentRoll = roll(10)
            let parent = parentRoll < 8 ? head(thread) : parentRoll < 9 ? pick(heldNow)?.id : nil
            send(fresh(parent: parent), to: thread, patch: false, new: true)
            return "new line in \(thread)"
        case 36..<44:
            // a run of tool steps: no asks, each on the head
            for _ in 0..<(10 + roll(50)) {
                send(fresh(parent: head(thread), cards: false), to: thread, patch: false, new: true)
            }
            return "burst in \(thread)"
        case 44..<58:
            // Open cards are what pin a thread's window; answer them often.
            let open = heldNow.filter { $0.card?.isPending == true }
            guard var message = (roll(2) == 0 ? pick(open) : nil) ?? pick(heldNow) else { return "nothing to patch" }
            if let card = message.card {
                message.card?.answered = card.answered == nil ? "Yes" : nil
                if roll(4) == 0 { message.card?.dismissed = true }
            } else {
                message.text = "patched \(operation)"
            }
            if roll(20) == 0 { message.parentId = pick(heldNow)?.id }
            send(message, to: thread, patch: roll(5) != 0)
            return "patch of held \(message.id) in \(thread)"
        case 58..<62:
            send(fresh(parent: heldNow.last?.id), to: thread, patch: true, new: true)
            return "patch of a never-seen id in \(thread)"
        case 62..<68:
            let heldIds = Set(heldNow.map(\.id))
            guard var message = pick((sent[thread] ?? []).filter { !heldIds.contains($0.id) }) else { return "nothing trimmed" }
            message.text = "late patch"
            if message.card != nil { message.card?.answered = "late" }
            send(message, to: thread, patch: true)
            return "late patch of trimmed \(message.id) in \(thread)"
        case 68..<72:
            guard let message = pick(heldNow) else { return "nothing to replay" }
            send(message, to: thread, patch: false)
            return "replay of \(message.id) in \(thread)"
        case 72..<78:
            // the harness moves heads on bot threads; rooms do not branch
            guard thread.hasPrefix("bot-") else { return "no branch switch in \(thread)" }
            let leaf = roll(6) == 0 ? "nowhere" : pick(heldNow)?.id ?? "nowhere"
            state.apply(.thread(threadId: thread, activeLeafId: leaf))
            return "branch switch in \(thread) to \(leaf)"
        case 78..<82:
            var update = bot
            update.messages = nil
            update.busy = roll(2) == 0
            update.unread = roll(2) == 0
            state.apply(.bot(update))
            return "bot metadata"
        case 82..<83:
            var update = bot
            var page: [Message] = []
            for _ in 0..<roll(8) { page.append(fresh(parent: page.last?.id)) }
            if roll(3) == 0, let repeated = page.first { page.append(repeated) }
            update.messages = page
            update.activeLeafId = page.last?.id
            update.hasMore = roll(2) == 0
            state.apply(.bot(update))
            sent["bot-main"] = page
            return "bot task switch"
        case 83..<84:
            var update = room
            var page: [Message] = []
            for _ in 0..<roll(6) { page.append(fresh(parent: page.last?.id)) }
            update.messages = page
            state.apply(.room(update))
            sent["room-main"] = page
            return "room task switch"
        case 84..<88:
            var page: [Message] = []
            for _ in 0..<(1 + roll(5)) {
                older -= 1
                page.insert(fresh(parent: nil, at: older), at: 0)
            }
            for index in page.indices.dropFirst() { page[index].parentId = page[index - 1].id }
            if !heldNow.isEmpty, roll(2) == 0 {
                // the page ends where the held transcript starts (an outside
                // write: the fold has no frame that re-roots a thread)
                state.messages[thread]?[0].parentId = page.last?.id
            }
            state.prepend(ThreadPage(messages: page, hasMore: roll(2) == 0), toThread: thread)
            sent[thread, default: []].insert(contentsOf: page, at: 0)
            return "prepend in \(thread)"
        case 88..<91:
            var page: [Message] = []
            if var known = pick(heldNow) { known.text = "merged"; page.append(known) }
            for _ in 0..<roll(4) { page.append(fresh(parent: pick(heldNow)?.id)) }
            state.merge(ThreadPage(messages: page, hasMore: roll(3) == 0 ? nil : roll(2) == 0,
                                   activeLeafId: roll(3) == 0 ? page.last?.id : nil), intoThread: thread)
            for message in page where !(sent[thread] ?? []).contains(where: { $0.id == message.id }) {
                sent[thread, default: []].append(message)
            }
            return "merge in \(thread)"
        case 91..<92:
            // an outside write: a repeated id, or a cycle through one
            var a = fresh(parent: nil)
            let b = fresh(parent: a.id)
            var copy = a
            copy.parentId = b.id
            a.text = "older a"
            let written = roll(2) == 0 ? [a, b, copy] : [a, a, b]
            state.messages[thread] = written
            sent[thread] = written
            return "outside write to \(thread)"
        case 92..<96:
            if roll(2) == 0, let source = pick(heldNow) {
                state.pendingEdits[thread] = PendingEdit(sourceId: source.id, text: "edited", at: clock)
                return "edit in flight in \(thread)"
            }
            state.pendingEdits[thread] = nil
            return "edit cleared in \(thread)"
        case 96..<99:
            guard let source = pick(heldNow) else { return "nothing to edit" }
            var fork = fresh(parent: source.parentId)
            fork.card = nil
            fork.kind = .text
            state.adoptEdit(fork, inThread: thread)
            sent[thread, default: []].append(fork)
            return "adopted edit in \(thread)"
        default:
            state.apply(.botDeleted(botId: bot.id))
            var back = bot
            back.messages = []
            state.apply(.bot(back))
            sent["bot-main"] = []
            sent["bot-task"] = []
            return "bot deleted and re-added"
        }
    }
}

/// SplitMix64: a fixed seed gives the same frames on every run and machine.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
