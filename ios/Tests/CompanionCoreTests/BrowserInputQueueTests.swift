import XCTest
@testable import CompanionCore

/// Records what the queue actually sent, and can be held open so a test can
/// stack work behind one in-flight request — which is the only state where
/// coalescing is observable.
private actor Recorder {
    private(set) var sent: [BrowserInputBody] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var held = false
    var failNext = false

    func hold() { held = true }

    func release() {
        held = false
        gate?.resume()
        gate = nil
    }

    func send(_ body: BrowserInputBody) async throws {
        if held { await withCheckedContinuation { gate = $0 } }
        if failNext {
            failNext = false
            throw BrowserInputError.tooSlow
        }
        sent.append(body)
    }

    func setFailNext() { failNext = true }
}

/// The queue reports errors from a `@Sendable` callback, so the test's record
/// of them has to be safe to touch from wherever that fires.
private final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Error?

    func store(_ error: Error) {
        lock.lock()
        defer { lock.unlock() }
        stored = error
    }

    var value: Error? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

final class BrowserInputQueueTests: XCTestCase {
    private func move(_ x: Double, _ y: Double) -> BrowserInputBody {
        BrowserInputBody(type: "input_mouse", eventType: "mouseMoved", x: x, y: y, button: "none", clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 0)
    }

    private func wheel(_ dy: Double) -> BrowserInputBody {
        BrowserInputBody(type: "input_mouse", eventType: "mouseWheel", x: 0, y: 0, button: "none", clickCount: 0, modifiers: 0, deltaX: 0, deltaY: dy)
    }

    private func press() -> BrowserInputBody {
        BrowserInputBody(type: "input_mouse", eventType: "mousePressed", x: 0, y: 0, button: "left", clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 0)
    }

    private func release() -> BrowserInputBody {
        BrowserInputBody(type: "input_mouse", eventType: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 0)
    }

    private func typed(_ text: String) -> BrowserInputBody {
        BrowserInputBody(type: "input_keyboard", eventType: "char", text: text)
    }

    private func makeQueue(_ recorder: Recorder) -> BrowserInputQueue {
        BrowserInputQueue(send: { body in try await recorder.send(body) }, onError: { _ in })
    }

    func testEverythingEnqueuedIsSentInOrder() async {
        let recorder = Recorder()
        let queue = makeQueue(recorder)

        await queue.enqueue(press())
        await queue.enqueue(typed("hi"))
        await queue.enqueue(release())
        await queue.settle()

        let sent = await recorder.sent
        XCTAssertEqual(sent.map(\.eventType), ["mousePressed", "char", "mouseReleased"])
    }

    /// Stale pointer positions are worth nothing; only the newest matters.
    func testConsecutiveMovesCoalesceToTheNewest() async {
        let recorder = Recorder()
        await recorder.hold()
        let queue = makeQueue(recorder)

        await queue.enqueue(move(1, 1))
        for step in 2...20 { await queue.enqueue(move(Double(step), Double(step))) }

        // One in flight, one replaceable survivor behind it.
        let depth = await queue.depth
        XCTAssertLessThanOrEqual(depth, 1)

        await recorder.release()
        await queue.settle()

        let sent = await recorder.sent
        XCTAssertLessThanOrEqual(sent.count, 2, "a burst of moves must not become a burst of requests")
        XCTAssertEqual(sent.last?.x, 20, "the newest position is the one that matters")
    }

    /// A flick must scroll as far as its parts would have, or coalescing
    /// silently eats distance.
    func testWheelDeltasSumWhenCoalesced() async {
        let recorder = Recorder()
        await recorder.hold()
        let queue = makeQueue(recorder)

        await queue.enqueue(wheel(-10))
        await queue.enqueue(wheel(-10))
        await queue.enqueue(wheel(-10))
        await queue.enqueue(wheel(-10))

        await recorder.release()
        await queue.settle()

        let sent = await recorder.sent
        let total = sent.compactMap(\.deltaY).reduce(0, +)
        XCTAssertEqual(total, -40, accuracy: 0.001)
    }

    /// A wheel must never absorb a pointer move, or the cursor teleports.
    func testDifferentMovementKindsDoNotCoalesceIntoEachOther() async {
        let recorder = Recorder()
        await recorder.hold()
        let queue = makeQueue(recorder)

        await queue.enqueue(move(5, 5))
        await queue.enqueue(wheel(-10))

        await recorder.release()
        await queue.settle()

        let sent = await recorder.sent
        XCTAssertEqual(sent.map(\.eventType), ["mouseMoved", "mouseWheel"])
    }

    /// Presses and typing keep their order and their count no matter what
    /// movement is going on around them.
    func testKeyboardAndButtonOrderSurvivesCoalescing() async {
        let recorder = Recorder()
        await recorder.hold()
        let queue = makeQueue(recorder)

        await queue.enqueue(press())
        await queue.enqueue(move(1, 1))
        await queue.enqueue(move(2, 2))
        await queue.enqueue(typed("a"))
        await queue.enqueue(typed("b"))
        await queue.enqueue(release())

        await recorder.release()
        await queue.settle()

        let sent = await recorder.sent
        let meaningful = sent.filter { !$0.isMovement }.map(\.eventType)
        XCTAssertEqual(meaningful, ["mousePressed", "char", "char", "mouseReleased"])
        XCTAssertEqual(sent.filter { $0.eventType == "char" }.compactMap(\.text), ["a", "b"])
    }

    /// A slow link must not bank minutes of typing that lands long after it
    /// meant anything.
    func testTheCeilingHaltsRatherThanBankingInput() async {
        let recorder = Recorder()
        await recorder.hold()
        let reported = ErrorBox()
        let queue = BrowserInputQueue(
            send: { body in try await recorder.send(body) },
            onError: { reported.store($0) }
        )

        for index in 0..<(BrowserInputQueue.ceiling + 20) {
            await queue.enqueue(typed("\(index)"))
        }

        let stopped = await queue.isStopped
        XCTAssertTrue(stopped, "the queue must halt rather than grow without bound")
        XCTAssertEqual(reported.value as? BrowserInputError, .tooSlow)

        await recorder.release()
        await queue.settle()
    }

    /// Even halted, a release must get through — the alternative is a button
    /// held down on the remote with nothing left to lift it.
    func testAHaltedQueueStillAcceptsReleases() async {
        let recorder = Recorder()
        let queue = makeQueue(recorder)

        await recorder.hold()
        for index in 0..<(BrowserInputQueue.ceiling + 20) {
            await queue.enqueue(typed("\(index)"))
        }
        let halted = await queue.isStopped
        XCTAssertTrue(halted)

        await queue.enqueue(typed("ignored"))
        await queue.enqueue(release())
        await recorder.release()
        await queue.settle()

        let sent = await recorder.sent
        XCTAssertTrue(sent.contains { $0.isRelease }, "a release must survive a halt")
        XCTAssertFalse(sent.contains { $0.text == "ignored" }, "ordinary input must not")
    }

    /// Reconnecting must not replay input aimed at a page that has moved on.
    func testClearForgetsQueuedInputAndTheHalt() async {
        let recorder = Recorder()
        let queue = makeQueue(recorder)

        await recorder.hold()
        for index in 0..<(BrowserInputQueue.ceiling + 20) {
            await queue.enqueue(typed("\(index)"))
        }
        let halted = await queue.isStopped
        XCTAssertTrue(halted)

        await queue.clear()

        let stillHalted = await queue.isStopped
        let depth = await queue.depth
        XCTAssertFalse(stillHalted)
        XCTAssertEqual(depth, 0)
    }

    /// Hand-back waits for what the remote is holding, not for stale travel.
    func testDrainDropsMovementButCompletesTheRest() async {
        let recorder = Recorder()
        await recorder.hold()
        let queue = makeQueue(recorder)

        await queue.enqueue(press())
        await queue.enqueue(move(9, 9))
        await queue.enqueue(release())

        await recorder.release()
        await queue.drain()

        let sent = await recorder.sent
        XCTAssertTrue(sent.contains { $0.eventType == "mousePressed" })
        XCTAssertTrue(sent.contains { $0.isRelease })
        XCTAssertFalse(sent.contains { $0.x == 9 }, "hand-back abandons stale travel")
        let depth = await queue.depth
        XCTAssertEqual(depth, 0)
    }
}
