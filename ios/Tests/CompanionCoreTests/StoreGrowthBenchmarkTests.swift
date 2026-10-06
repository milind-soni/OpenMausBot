// What the fold costs at the size a long session reaches: 20 threads of
// 2,000 messages each. These print timings rather than assert them — a
// timing threshold is a flaky test on a shared CI runner — so they are
// skipped unless asked for:
//
//   COMPANION_BENCH=1 swift test --package-path ios -c release \
//     -Xswiftc -enable-testing --filter StoreGrowthBenchmarkTests
//
// The structural claims (no copy per frame, the bound, the indexes agreeing
// with a full scan) are asserted in StoreGrowthTests, which always run.
import XCTest
@testable import CompanionCore

final class StoreGrowthBenchmarkTests: XCTestCase {
    private let threadCount = 20
    private let perThread = 2_000

    override func setUpWithError() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["COMPANION_BENCH"] == "1",
            "timings only; set COMPANION_BENCH=1 to run"
        )
    }

    // MARK: - Fixture

    private func templateBot() throws -> Bot {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try XCTUnwrap(try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)).bots.first)
    }

    private func id(_ thread: Int, _ index: Int) -> String { "t\(thread)-m\(index)" }

    /// One unforked chain per thread, the shape a working bot produces.
    /// Two threads end on an open approval; half the bots are working and a
    /// few are unread, so `updates()` takes every branch it has.
    private func fleet(perThread: Int) throws -> Fleet {
        let template = try templateBot()
        var bots: [Bot] = []
        for thread in 0..<threadCount {
            var bot = template
            bot.id = "bot-\(thread)"
            bot.threadId = "thread-\(thread)"
            bot.name = "Bot \(thread)"
            bot.tasks = [BotTask(threadId: bot.threadId, title: "Task", createdAt: 1)]
            bot.busy = thread % 2 == 0
            bot.unread = thread % 5 == 1
            var messages: [Message] = []
            messages.reserveCapacity(perThread)
            for index in 0..<perThread {
                var message = Message(id: id(thread, index), role: index % 2 == 0 ? .user : .bot, kind: .text, at: Double(index))
                message.text = "Message \(index) of a long-running thread, about as long as a status line."
                message.parentId = index == 0 ? nil : id(thread, index - 1)
                messages.append(message)
            }
            if thread < 2 {
                messages[perThread - 1].kind = .options
                messages[perThread - 1].card = OptionCard(
                    title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
                    requestId: "request-\(thread)", tool: "Bash"
                )
            }
            bot.messages = messages
            bot.activeLeafId = messages.last?.id
            bot.hasMore = true
            bots.append(bot)
        }
        return Fleet(bots: bots, groups: [])
    }

    /// 2,000 new messages, round-robin over the threads, each the child of
    /// its thread's newest message.
    private func frames(after perThread: Int, count: Int = 2_000) -> [StreamFrame] {
        (0..<count).map { step in
            let thread = step % threadCount
            let index = perThread + step / threadCount
            var message = Message(id: id(thread, index), role: .bot, kind: .activity, at: Double(index))
            message.parentId = id(thread, index - 1)
            return StreamFrame(frame: .message(threadId: "thread-\(thread)", message: message), seq: step + 1)
        }
    }

    // MARK: - Timing

    private func microseconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1_000_000 + Double(duration.components.attoseconds) / 1_000_000_000_000
    }

    private func report(_ label: String, _ value: Double, unit: String) {
        print(String(format: "[store-bench] %@: %.2f %@", label, value, unit))
    }

    private func held(_ state: CompanionState) -> Int {
        state.messages.values.reduce(0) { $0 + $1.count }
    }

    /// Frames folded one at a time into a state nothing else holds.
    func testAppendCostPerFrame() throws {
        for size in [500, perThread] {
            var state = CompanionState()
            state.hydrate(try fleet(perThread: size))
            state.resetCursor("bench:0")
            let input = frames(after: size)
            let elapsed = ContinuousClock().measure {
                for frame in input { state.applyBatch([frame]) }
            }
            report("append, one frame per batch, threads seeded at \(size)", microseconds(elapsed) / Double(input.count), unit: "µs/frame")
            report("messages held after 2,000 appends to threads seeded at \(size)", Double(held(state)), unit: "messages")
        }
    }

    /// The way Session folds: a copy of the published state takes a 50 ms
    /// batch (here 10 frames) and is assigned back, while the old value is
    /// still alive.
    func testAppendCostPerFrameAsSessionBatchesIt() throws {
        for size in [500, perThread] {
            var state = CompanionState()
            state.hydrate(try fleet(perThread: size))
            state.resetCursor("bench:0")
            let input = frames(after: size)
            let elapsed = ContinuousClock().measure {
                var start = 0
                while start < input.count {
                    let batch = Array(input[start..<min(start + 10, input.count)])
                    var updated = state
                    updated.applyBatch(batch)
                    state = updated
                    start += 10
                }
            }
            report("append, Session-style 10-frame batches, threads seeded at \(size)", microseconds(elapsed) / Double(input.count), unit: "µs/frame")
        }
    }

    /// The derived state three surfaces ask for on every publish.
    func testPendingApprovalsAndUpdatesCost() throws {
        var hydrated = CompanionState()
        hydrated.hydrate(try fleet(perThread: perThread))
        var grown = hydrated
        grown.resetCursor("bench:0")
        for frame in frames(after: perThread) { grown.applyBatch([frame]) }

        for (label, state) in [("20 × 2,000 held", hydrated), ("after 2,000 more appends", grown)] {
            let calls = 200
            var sink = 0
            let approvals = ContinuousClock().measure {
                for _ in 0..<calls { sink &+= state.pendingApprovals.count }
            }
            let updates = ContinuousClock().measure {
                for _ in 0..<calls { sink &+= state.updates(detail: .full).count }
            }
            let transcript = ContinuousClock().measure {
                for _ in 0..<calls { sink &+= state.visibleTranscript(forThread: "thread-3").count }
            }
            XCTAssertGreaterThan(sink, 0)
            report("pendingApprovals, \(label)", microseconds(approvals) / Double(calls), unit: "µs/call")
            report("updates(detail: .full), \(label)", microseconds(updates) / Double(calls), unit: "µs/call")
            report("visibleTranscript, one thread, \(label)", microseconds(transcript) / Double(calls), unit: "µs/call")
        }
    }
}
