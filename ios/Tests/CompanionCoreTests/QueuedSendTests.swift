// Mid-turn sends: what the phone shows between posting a message and the
// computer actually running it.
//
// The harness answers a mid-turn send in one of three ways, and only one of
// them puts anything in the transcript. These are claims about the other
// two — the ones that used to leave the screen blank.
import XCTest
@testable import CompanionCore

final class QueuedSendTests: XCTestCase {
    private func echo() -> Bot {
        Bot(
            id: "b1", threadId: "t1", name: "Echo", title: "", description: "",
            notifications: true, color: "blue", unread: false,
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.5"),
            createdAt: 1
        )
    }

    private func drained(_ id: String, queueId: String, text: String = "and add tests") -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: 10)
        message.text = text
        message.queueId = queueId
        return message
    }

    // MARK: - The receipt

    func testAHeldSendDecodesAsQueued() throws {
        let body = Data(#"{"ok":true,"queued":true,"queueId":"q1","threadId":"t1"}"#.utf8)
        let receipt = try JSONDecoder().decode(SendReceiptBody.self, from: body).receipt
        XCTAssertEqual(receipt, .queued(queueId: "q1", threadId: "t1"))
    }

    func testASendTakenIntoTheRunningTurnDecodesAsSteered() throws {
        let body = Data(#"{"ok":true,"steered":true,"threadId":"t1","message":{"id":"m1"}}"#.utf8)
        let receipt = try JSONDecoder().decode(SendReceiptBody.self, from: body).receipt
        XCTAssertEqual(receipt, .sent(threadId: "t1", steered: true))
    }

    /// An older harness answers `{ok:true}`. That is a plain send, not a
    /// failure and not something to draw a ghost for.
    func testAnAnswerWithoutMidTurnDetailIsAPlainSend() throws {
        let body = Data(#"{"ok":true}"#.utf8)
        let receipt = try JSONDecoder().decode(SendReceiptBody.self, from: body).receipt
        XCTAssertEqual(receipt, .sent(threadId: nil, steered: false))
    }

    /// `queued` without the id it is identified by is not something this
    /// client can track, cancel, or retire. Treating it as a plain send
    /// loses the ghost; treating it as queued would strand one forever.
    func testQueuedWithoutAnIdFallsBackToAPlainSend() throws {
        let body = Data(#"{"ok":true,"queued":true,"threadId":"t1"}"#.utf8)
        let receipt = try JSONDecoder().decode(SendReceiptBody.self, from: body).receipt
        XCTAssertEqual(receipt, .sent(threadId: "t1", steered: false))
    }

    // MARK: - The fold

    func testAHeldSendStaysOnScreenUntilItsLineLands() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "and add tests"), inThread: "t1")
        XCTAssertEqual(state.pendingQueued["t1"]?.map(\.text), ["and add tests"])

        state.apply(.message(threadId: "t1", message: drained("m1", queueId: "q1")))
        XCTAssertNil(state.pendingQueued["t1"])
        XCTAssertEqual(state.transcript(forThread: "t1").count, 1)
    }

    func testHoldsAreKeptInSendOrderAndNeverTwice() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        state.rememberQueued(QueuedSend(queueId: "q2", text: "second"), inThread: "t1")
        // a retried POST returns the same receipt
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        XCTAssertEqual(state.pendingQueued["t1"]?.map(\.text), ["first", "second"])
    }

    /// The turn can settle before the POST that queued the message has even
    /// returned. Its line is already in the transcript by then, so the late
    /// receipt must not put a ghost of it back on screen.
    func testADrainThatBeatsItsOwnReceiptDoesNotResurrectTheGhost() {
        var state = CompanionState()
        state.apply(.message(threadId: "t1", message: drained("m1", queueId: "q1")))
        state.rememberQueued(QueuedSend(queueId: "q1", text: "and add tests"), inThread: "t1")
        XCTAssertNil(state.pendingQueued["t1"])
    }

    /// One tombstone, one use. A later queue entry that happens to reuse the
    /// id is a different message and has to be shown.
    func testTheTombstoneIsSpentOnce() {
        var state = CompanionState()
        state.apply(.message(threadId: "t1", message: drained("m1", queueId: "q1")))
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        XCTAssertEqual(state.pendingQueued["t1"]?.map(\.text), ["first"])
    }

    func testCancellingAHoldRemovesItAndOnlyIt() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        state.rememberQueued(QueuedSend(queueId: "q2", text: "second"), inThread: "t1")
        state.forgetQueued("q1", inThread: "t1")
        XCTAssertEqual(state.pendingQueued["t1"]?.map(\.text), ["second"])
        state.forgetQueued("q2", inThread: "t1")
        XCTAssertNil(state.pendingQueued["t1"])
    }

    /// A phone that was asleep through the drain never saw the message
    /// frame. The transcript it wakes up to is the correction.
    func testAPageThatAlreadyContainsTheLineRetiresItsGhost() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "and add tests"), inThread: "t1")
        state.merge(
            ThreadPage(messages: [drained("m1", queueId: "q1")], hasMore: false),
            intoThread: "t1"
        )
        XCTAssertNil(state.pendingQueued["t1"])
    }

    func testHoldsAreKeptPerThread() {
        var state = CompanionState()
        state.rememberQueued(QueuedSend(queueId: "q1", text: "first"), inThread: "t1")
        state.rememberQueued(QueuedSend(queueId: "q2", text: "second"), inThread: "t2")
        state.apply(.message(threadId: "t1", message: drained("m1", queueId: "q1")))
        XCTAssertNil(state.pendingQueued["t1"])
        XCTAssertEqual(state.pendingQueued["t2"]?.map(\.text), ["second"])
    }

    /// A bot frame carrying a whole transcript replaces `messages` outright
    /// rather than appending, so it never runs the retirement that `append`
    /// does. Without reconciling here the held message sits above the chat
    /// bar for ever, long after its line has landed.
    func testAWholesaleTranscriptReplacementRetiresTheGhost() {
        var state = CompanionState()
        var bot = echo()
        state.apply(.bot(bot))
        state.rememberQueued(QueuedSend(queueId: "q1", text: "Count to 5"), inThread: "t1")
        XCTAssertEqual(state.pendingQueued["t1"]?.count, 1)

        bot.messages = [drained("m1", queueId: "q1")]
        state.apply(.bot(bot))
        XCTAssertNil(state.pendingQueued["t1"])
    }

    /// An engine that dies mid-sentence reports the failure as activity, not
    /// as a settled reply, so nothing else clears the buffer. Left alone it
    /// renders as an answer that streams for ever.
    func testAnIdleBotHasNothingStreaming() {
        var state = CompanionState()
        var bot = echo()
        bot.busy = true
        state.apply(.bot(bot))
        state.apply(.runtime(RuntimeEvent(
            type: "content.delta", threadId: "t1", delta: "A History of Comp", streamKind: "assistant_text"
        )))
        XCTAssertFalse((state.streaming["t1"] ?? "").isEmpty)

        bot.busy = false
        state.apply(.bot(bot))
        XCTAssertNil(state.streaming["t1"])
    }

    // MARK: - Taking one back

    /// The harness and the sidecar both answer 404. Only one of them means
    /// the message is gone; the other means this computer cannot cancel at
    /// all, and treating them alike takes the words off the phone while the
    /// computer still intends to run them.
    func testOnlyTheHarnessesOwn404CountsAsAlreadyGone() {
        let drained = APIError.status(code: 404, message: CompanionClient.alreadyDrained)
        let noRoute = APIError.status(code: 404, message: "no route: DELETE /api/bots/b1/queue/q1")
        XCTAssertTrue(isAlreadyDrained(drained))
        XCTAssertFalse(isAlreadyDrained(noRoute))
        XCTAssertFalse(isAlreadyDrained(APIError.status(code: 404, message: nil)))
    }

    /// Mirrors the `catch` pattern in `cancelQueued`.
    private func isAlreadyDrained(_ error: APIError) -> Bool {
        guard case let .status(code, message) = error else { return false }
        return code == 404
            && message?.localizedCaseInsensitiveContains(CompanionClient.alreadyDrained) == true
    }

    // MARK: - The message

    func testATranscriptLineCarriesItsMidTurnMarkers() throws {
        let body = Data(#"""
        {"id":"m1","role":"user","kind":"text","at":1,"text":"stop and explain","steered":true}
        """#.utf8)
        let message = try JSONDecoder().decode(Message.self, from: body)
        XCTAssertEqual(message.steered, true)
        XCTAssertNil(message.queueId)
    }

    func testAnEngineThatCanTakeWordsIntoATurnSaysSo() throws {
        let body = Data(#"{"effortLevels":["low"],"queueing":true}"#.utf8)
        let capabilities = try JSONDecoder().decode(InstanceCapabilities.self, from: body)
        XCTAssertEqual(capabilities.queueing, true)
    }
}
