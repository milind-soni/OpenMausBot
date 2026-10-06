import XCTest
import Combine
@testable import CompanionCore

private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
}

final class EventBatchTests: XCTestCase {
    private func delta(_ seq: Int, thread: String = "other-bot", text: String = "x") -> StreamFrame {
        StreamFrame(frame: .runtime(RuntimeEvent(type: "content.delta", threadId: thread,
                                                delta: text, streamKind: "assistant_text")), seq: seq)
    }

    private func source(_ frames: [StreamFrame]) -> AsyncThrowingStream<StreamFrame, Error> {
        AsyncThrowingStream { continuation in
            for frame in frames { continuation.yield(frame) }
            continuation.finish()
        }
    }

    private func runtime(_ type: String, _ seq: Int, thread: String = "t") -> StreamFrame {
        StreamFrame(frame: .runtime(RuntimeEvent(type: type, threadId: thread)), seq: seq)
    }

    private func ask(_ id: String) -> Message {
        var message = Message(id: id, role: .bot, kind: .options, at: 1)
        message.card = OptionCard(
            title: "Approval needed", subtitle: "ls", options: ["Allow", "Deny"],
            answered: nil, dismissed: nil, requestId: "r-\(id)", tool: "Bash", held: nil, allowKey: "Bash:ls"
        )
        return message
    }

    func testBurstIsBoundedOrderedAndFoldsEveryTokenAndCursor() async throws {
        let input = (1...500).map { delta($0, thread: "bot-\($0 % 20)") }
        var batches: [[StreamFrame]] = []
        for try await batch in eventBatches(source(input), intervalNanoseconds: 60_000_000_000) {
            batches.append(batch)
        }
        // A window closes at 100 frames; a consumer that has not asked yet
        // gets the closed windows as one batch, so there may be fewer.
        XCTAssertTrue((1...5).contains(batches.count), "500 tokens should not publish 1,000 global state mutations")
        XCTAssertEqual(batches.flatMap { $0 }.compactMap(\.seq), Array(1...500))
        var state = CompanionState()
        state.resetCursor("fixture:0")
        for batch in batches { state.applyBatch(batch) }
        XCTAssertEqual(state.cursor, "fixture:500")
        XCTAssertEqual(state.streaming.count, 20)
        XCTAssertTrue(state.streaming.values.allSatisfy { $0 == String(repeating: "x", count: 25) })
    }

    func testToolStepsAndSettledRepliesRideTheWindowRatherThanPublishingEach() async throws {
        // A busy fleet's tool steps are most of its non-token traffic; each
        // one used to cost a publish and a full Home render of its own.
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let handedOver = Counter()
        let consumer = Task {
            var received: [[StreamFrame]] = []
            for try await batch in eventBatches(input.stream, intervalNanoseconds: 60_000_000_000) {
                received.append(batch)
                await handedOver.increment()
                break
            }
            return received
        }
        let ordinary: [StreamFrame] = [
            runtime("item.started", 1),
            delta(2),
            StreamFrame(frame: .message(threadId: "t", message: Message(id: "step", role: .bot, kind: .activity, at: 1)), seq: 3),
            runtime("item.completed", 4),
            StreamFrame(frame: .messagePatch(threadId: "t", message: Message(id: "reply", role: .bot, kind: .text, at: 2)), seq: 5),
            runtime("turn.completed", 6),
            StreamFrame(frame: .thread(threadId: "t", activeLeafId: "reply"), seq: 7),
            StreamFrame(frame: .botDeleted(botId: "gone"), seq: 8),
        ]
        for frame in ordinary { input.continuation.yield(frame) }
        try await Task.sleep(nanoseconds: 300_000_000)
        let early = await handedOver.value
        XCTAssertEqual(early, 0, "nothing is handed over before the window closes or something is asked")
        input.continuation.yield(StreamFrame(frame: .message(threadId: "t", message: ask("a")), seq: 9))
        let received = try await consumer.value
        XCTAssertEqual(received.map { $0.compactMap(\.seq) }, [Array(1...9)], "one batch, in order")
        input.continuation.finish()
    }

    func testAWindowOfOrdinaryFramesClosesOnItsOwnTimer() async throws {
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let delivered = expectation(description: "the timer delivers without an ask")
        let consumer = Task {
            var sequences: [Int] = []
            for try await batch in eventBatches(input.stream, intervalNanoseconds: 20_000_000) {
                sequences += batch.compactMap(\.seq)
                if sequences.count == 2 {
                    delivered.fulfill()
                    break
                }
            }
            return sequences
        }
        input.continuation.yield(runtime("item.started", 1))
        input.continuation.yield(runtime("item.completed", 2))
        await fulfillment(of: [delivered], timeout: 2)
        let sequences = try await consumer.value
        XCTAssertEqual(sequences, [1, 2])
        input.continuation.finish()
    }

    func testHelloIsAloneAndWhatSomeoneWaitsOnClosesTheWindowAtOnce() async throws {
        let notification = NotificationFrame(kind: "approval", botId: "b", botName: "Bot",
                                             threadId: "t", title: "Approve", body: "Run?")
        var secret = Message(id: "secret", role: .bot, kind: .secret, at: 1)
        secret.secret = SecretRequestCardData(label: "Token")
        let controls: [Frame] = [
            .hello(cursor: "fixture:0", resumed: true),
            .notify(notification),
            .message(threadId: "t", message: ask("a")),
            .messagePatch(threadId: "t", message: ask("b")),
            .message(threadId: "t", message: secret),
            .runtime(RuntimeEvent(type: "request.opened", threadId: "t")),
            .runtime(RuntimeEvent(type: "request.resolved", threadId: "t")),
            .runtime(RuntimeEvent(type: "runtime.error", threadId: "t")),
            .runtime(RuntimeEvent(type: "turn.failed", threadId: "t")),
            .runtime(RuntimeEvent(type: "turn.aborted", threadId: "t")),
            .liveCall(botId: "b", threadId: "t", call: nil),
        ]
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let handedOver = Counter()
        let consumer = Task {
            var received: [[StreamFrame]] = []
            for try await batch in eventBatches(input.stream, intervalNanoseconds: 60_000_000_000) {
                received.append(batch)
                await handedOver.increment()
                if received.count == controls.count { break }
            }
            return received
        }
        // One at a time, each taken before the next is sent: a consumer
        // still busy with one would get the next two windows as one batch.
        // The window is a minute long, so only the frame itself closes it.
        for (index, frame) in controls.enumerated() {
            if index > 0 { input.continuation.yield(delta(index * 2 - 1)) }
            input.continuation.yield(StreamFrame(frame: frame, seq: index * 2))
            let deadline = Date().addingTimeInterval(5)
            while await handedOver.value <= index, Date() < deadline {
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        let received = try await consumer.value
        XCTAssertEqual(received.first?.count, 1)
        XCTAssertEqual(received.dropFirst().map(\.count), Array(repeating: 2, count: controls.count - 1))
        XCTAssertEqual(received.flatMap { $0 }.compactMap(\.seq), Array(0...(controls.count * 2 - 2)))
        input.continuation.finish()
    }

    func testABusyConsumerGetsTheBacklogAsOneBatchButHelloStaysAlone() async throws {
        let buffer = EventBatchBuffer(interval: 60_000_000_000, maximumCount: 2)
        await buffer.append(delta(1))
        await buffer.append(delta(2)) // a full window closes
        await buffer.append(delta(3))
        await buffer.append(StreamFrame(frame: .notify(NotificationFrame(
            kind: "done", botId: "b", botName: "Bot", threadId: "t", title: "Done", body: ""
        )), seq: 4)) // another window, closed early
        await buffer.append(StreamFrame(frame: .hello(cursor: "fixture:4", resumed: true), seq: nil))
        await buffer.append(delta(5))
        await buffer.finish()
        var batches: [[Int?]] = []
        while let batch = try await buffer.next() { batches.append(batch.map(\.seq)) }
        XCTAssertEqual(batches, [[1, 2, 3, 4], [nil], [5]])
    }

    func testAConsumerThatStopsIteratingClosesTheSource() async throws {
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let stopped = expectation(description: "input closed")
        input.continuation.onTermination = { _ in stopped.fulfill() }
        input.continuation.yield(StreamFrame(frame: .hello(cursor: "fixture:0", resumed: true), seq: 0))
        for try await _ in eventBatches(input.stream, intervalNanoseconds: 60_000_000_000) { break }
        await fulfillment(of: [stopped], timeout: 2)
    }

    func testLoneDeltaArrivesWithoutMoreInputAndErrorFlushesTail() async throws {
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let delivered = expectation(description: "timer delivers an unfinished reply")
        let consumer = Task {
            var received: [Int] = []
            do {
                for try await batch in eventBatches(input.stream, intervalNanoseconds: 10_000_000) {
                    received += batch.compactMap(\.seq)
                    if received == [1] {
                        delivered.fulfill()
                        input.continuation.yield(self.delta(2))
                        input.continuation.finish(throwing: URLError(.networkConnectionLost))
                    }
                }
                XCTFail("transport failure must survive batching")
            } catch let error as URLError {
                XCTAssertEqual(error.code, .networkConnectionLost)
            }
            return received
        }
        input.continuation.yield(delta(1))
        await fulfillment(of: [delivered], timeout: 2)
        let result = try await consumer.value
        XCTAssertEqual(result, [1, 2])
    }

    func testCancellationStopsInputAndDoesNotPublishThePendingTail() async throws {
        let input = AsyncThrowingStream<StreamFrame, Error>.makeStream()
        let stopped = expectation(description: "input cancelled")
        input.continuation.onTermination = { _ in stopped.fulfill() }
        let received = expectation(description: "hello received")
        let consumer = Task {
            var sequences: [Int] = []
            for try await batch in eventBatches(input.stream, intervalNanoseconds: 60_000_000_000) {
                sequences += batch.compactMap(\.seq)
                received.fulfill()
            }
            return sequences
        }
        input.continuation.yield(StreamFrame(frame: .hello(cursor: "fixture:0", resumed: true), seq: 0))
        input.continuation.yield(delta(1))
        await fulfillment(of: [received], timeout: 2)
        consumer.cancel()
        await fulfillment(of: [stopped], timeout: 2)
        let result = try await consumer.value
        XCTAssertEqual(result, [0], "the unpublished tail must be replayed, not advance state")
    }

    @MainActor
    func testBatchPublishesOnceIncludingCursorAndPreservesOtherLocalWork() {
        final class Model: ObservableObject { @Published var state = CompanionState() }
        let model = Model()
        model.state.resetCursor("fixture:0")
        model.state.pendingEdits["selected"] = PendingEdit(sourceId: "user", text: "my edit")
        var publications = 0
        let observation = model.objectWillChange.sink { publications += 1 }
        var next = model.state
        next.applyBatch((1...100).map { delta($0) })
        model.state = next
        XCTAssertEqual(publications, 1)
        XCTAssertEqual(model.state.cursor, "fixture:100")
        XCTAssertEqual(model.state.pendingEdits["selected"]?.text, "my edit")
        withExtendedLifetime(observation) {}
    }
}
