// Held mid-turn sends: the state machine, the wire shapes it reads, and the
// row derivation that surfaces it. Queued is client state derived from the
// wire, never task activity — the activity arm for it is gone for good.
import XCTest
@testable import CompanionCore

final class QueuedSendTests: XCTestCase {
    private func held(_ queueId: String, _ text: String = "follow-up", reason: String? = nil) -> QueuedSend {
        QueuedSend(queueId: queueId, text: text, reason: reason)
    }

    private func landed(_ id: String, queueId: String?) -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: 1)
        message.text = "hello"
        message.queueId = queueId
        return message
    }

    private func room(_ id: String, threadId: String) throws -> Room {
        try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"\(id)","threadId":"\(threadId)","name":"Ops","memberIds":["bot"],
         "defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1}
        """.utf8))
    }

    // MARK: - Remembering and retiring

    func testRememberShowsARowAndDeduplicates() {
        var state = CompanionState()
        state.rememberQueued(held("q1"), threadId: "t1")
        state.rememberQueued(held("q1", "again"), threadId: "t1")
        XCTAssertEqual(state.pendingQueued["t1"], [held("q1")])
        XCTAssertEqual(state.queuedThreadIds, ["t1"])
    }

    func testConsumeRetiresTheRowAndTombstonesIt() {
        var state = CompanionState()
        state.rememberQueued(held("q1"), threadId: "t1")
        state.consumeQueued(queueId: "q1", threadId: "t1")
        XCTAssertNil(state.pendingQueued["t1"])
        XCTAssertEqual(state.drainedQueueIds, ["q1"])
    }

    func testDrainThatBeatsItsOwnPostCannotResurrectTheRow() {
        var state = CompanionState()
        state.consumeQueued(queueId: "q1", threadId: "t1")
        XCTAssertTrue(state.drainedQueueIds.contains("q1"))
        state.rememberQueued(held("q1"), threadId: "t1")
        XCTAssertNil(state.pendingQueued["t1"], "the tombstone wins and is spent")
        XCTAssertFalse(state.drainedQueueIds.contains("q1"))
    }

    func testMessageFrameWithAQueueIdConsumesTheRow() {
        var state = CompanionState()
        state.rememberQueued(held("q1"), threadId: "t1")
        state.apply(.message(threadId: "t1", message: landed("m1", queueId: "q1")))
        XCTAssertNil(state.pendingQueued["t1"])
        XCTAssertEqual(state.drainedQueueIds, ["q1"])
    }

    func testTranscriptPagesRetireLandedSends() {
        var state = CompanionState()
        state.rememberQueued(held("q1"), threadId: "t1")
        state.rememberQueued(held("q2"), threadId: "t1")
        state.merge(
            ThreadPage(messages: [landed("m1", queueId: "q1")], hasMore: false),
            intoThread: "t1"
        )
        XCTAssertEqual(state.pendingQueued["t1"], [held("q2")])
        XCTAssertTrue(state.drainedQueueIds.contains("q1"))
    }

    func testTombstoneWindowStaysBounded() {
        var state = CompanionState()
        for index in 0..<70 {
            state.consumeQueued(queueId: "q\(index)", threadId: "t1")
        }
        XCTAssertEqual(state.drainedQueueIds.count, 64)
        XCTAssertEqual(state.drainedQueueIds.first, "q6")
    }

    // MARK: - The server-owned snapshot

    func testBotQueuedFrameReplacesBotQueuesWholesale() throws {
        var state = CompanionState()
        state.rooms = [try room("room", threadId: "room-thread")]
        state.rememberQueued(held("bot-old"), threadId: "bot-thread")
        state.rememberQueued(held("room-held"), threadId: "room-thread")

        state.apply(.botQueued(queues: ["bot-thread": [held("bot-new", reason: "capacity")]]))

        XCTAssertEqual(state.pendingQueued["bot-thread"], [held("bot-new", reason: "capacity")])
        XCTAssertEqual(state.pendingQueued["room-thread"], [held("room-held")], "room queues are a separate queue the frame does not describe")
        XCTAssertTrue(state.drainedQueueIds.contains("bot-old"), "a vanished entry is tombstoned so a slow POST cannot resurrect it")
    }

    func testHydrateSeedsQueuesFromTheFleetAndReconcilesLandedLines() throws {
        var state = CompanionState()
        state.rememberQueued(held("stale"), threadId: "bot-thread")
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data("""
        {"bots":[{"id":"bot","threadId":"bot-thread","name":"Scout","title":"Researcher",
          "description":"","notifications":true,"color":"green","unread":false,
          "modelSelection":{"instanceId":"engine","model":"default"},"createdAt":1,
          "messages":[{"id":"m1","role":"user","kind":"text","at":1,"text":"hello","queueId":"q-landed"}]}],
         "groups":[],
         "botQueuedMessages":{"bot-thread":[{"queueId":"q-held","text":"follow-up"}]}}
        """.utf8))
        state.hydrate(fleet)
        XCTAssertEqual(state.pendingQueued["bot-thread"], [held("q-held")])
        XCTAssertTrue(state.drainedQueueIds.contains("q-landed"))
        XCTAssertTrue(state.drainedQueueIds.contains("stale"))
    }

    // MARK: - Defensive wire parsing

    func testBotQueuedFrameDropsMalformedEntriesWithoutDroppingTheFrame() throws {
        let frame = try JSONDecoder().decode(Frame.self, from: Data("""
        {"kind":"bot.queued","queues":{"t1":[
          {"queueId":"q1","text":"good"},
          {"queueId":"q2"},
          {"text":"no id"},
          "not even an object"
        ]}}
        """.utf8))
        guard case let .botQueued(queues) = frame else {
            return XCTFail("expected bot.queued, got \(frame)")
        }
        XCTAssertEqual(queues["t1"], [held("q1", "good")])
    }

    func testAnUnreadableBotQueuedFrameIsIgnoredNotReadAsAnEmptyQueue() throws {
        for payload in [
            "{\"kind\":\"bot.queued\"}",
            "{\"kind\":\"bot.queued\",\"queues\":\"not a dictionary\"}"
        ] {
            let frame = try JSONDecoder().decode(Frame.self, from: Data(payload.utf8))
            guard case let .unknown(kind) = frame else {
                return XCTFail("expected an ignored frame, got \(frame)")
            }
            XCTAssertEqual(kind, "bot.queued")
        }

        var state = CompanionState()
        state.rememberQueued(held("q1"), threadId: "t1")
        let frame = try JSONDecoder().decode(Frame.self, from: Data("{\"kind\":\"bot.queued\"}".utf8))
        state.apply(frame)
        XCTAssertEqual(state.pendingQueued["t1"], [held("q1")],
                       "an unreadable frame is not the server retiring the queue")
    }

    func testSendReceiptDecodesQueuedAndDirectShapes() throws {
        let queued = try JSONDecoder().decode(SendReceipt.self, from: Data("""
        {"ok":true,"queued":true,"queueId":"q1","threadId":"t1","reason":"capacity"}
        """.utf8))
        XCTAssertEqual(queued.queued, true)
        XCTAssertEqual(queued.queueId, "q1")
        XCTAssertEqual(queued.threadId, "t1")
        XCTAssertEqual(queued.reason, "capacity")

        let direct = try JSONDecoder().decode(SendReceipt.self, from: Data("""
        {"ok":true,"threadId":"t1","message":{"id":"m1","role":"user","kind":"text","at":1}}
        """.utf8))
        XCTAssertNil(direct.queued)
        XCTAssertNil(direct.queueId)
    }

    // MARK: - Row and attention derivation

    func testWireQueuedActivityStillDemandsAttention() {
        var task = BotTask(threadId: "t1", title: "t", createdAt: 1)
        task.activity = "queued"
        XCTAssertFalse(task.busy == true)
        XCTAssertTrue(
            task.demandsAttention(queued: false),
            "main surfaces a thread whose wire activity says queued; the client flag covers the out-of-band queues"
        )
    }

    func testClientQueuedStateDemandsAttentionAndFloatsClosedThreads() {
        var task = BotTask(threadId: "t1", title: "t", createdAt: 1)
        task.closedBy = ThreadCloser(botId: "bot", name: "Scout", at: 1)
        XCTAssertTrue(task.demandsAttention(queued: true))

        let bot = Bot(
            id: "bot", threadId: "current", name: "Scout", title: "Researcher",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1,
            tasks: [task]
        )
        XCTAssertTrue(bot.threadGroups().flatMap(\.tasks).isEmpty, "closed and quiet folds away")
        XCTAssertEqual(bot.threadGroups(queuedThreadIds: ["t1"]).flatMap(\.tasks).map(\.threadId), ["t1"], "a held send keeps the row up")
    }
}
