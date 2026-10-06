import XCTest
import Combine
@testable import CompanionCore

final class LiveActivityUpdatesTests: XCTestCase {
    @MainActor
    func testFixedWindowPublishesDuringTrafficAndClearsAfterUnpair() async throws {
        let source = CurrentValueSubject<Int?, Never>(0)
        let active = expectation(description: "update arrives while fleet is still publishing")
        let cleared = expectation(description: "final unpair clears the compact surface")
        var deliveries: [Int?] = []
        let observation = source
            .collect(.byTime(DispatchQueue.main, .milliseconds(100)))
            .compactMap(\.last)
            .sink { value in
                deliveries.append(value)
                if deliveries.count == 1 {
                    XCTAssertNotEqual(value, 0, "startup must wait for its first window")
                    active.fulfill()
                }
                if value == nil { cleared.fulfill() }
            }
        XCTAssertTrue(deliveries.isEmpty, "do not publish the cold-launch empty state immediately")
        var sequence = 0
        let producer = Task { @MainActor in
            while !Task.isCancelled {
                sequence += 1
                source.send(sequence)
                do { try await Task.sleep(nanoseconds: 10_000_000) } catch { return }
            }
        }
        defer { producer.cancel(); observation.cancel() }
        await fulfillment(of: [active], timeout: 2)
        XCTAssertFalse(producer.isCancelled)
        producer.cancel()
        await producer.value
        source.send(nil)
        await fulfillment(of: [cleared], timeout: 2)
        observation.cancel()
        let count = deliveries.count
        source.send(999)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(deliveries.count, count, "cancelled compact surfaces must stop receiving")
    }

    func testOneActivityPerBotKeepsTheNewestAskAndLeavesThreadUpdatesIntact() throws {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: "updates-fleet", withExtension: "json", subdirectory: "Fixtures"
        ))
        var state = CompanionState()
        state.hydrate(try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)))
        let botIndex = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-busy" })
        var task = try XCTUnwrap(state.bots[botIndex].tasks?.first)
        task.busy = false
        task.activity = "waiting-on-you"
        var ask = try XCTUnwrap(state.messages["t-ask-new"]?.last { $0.card?.isPending == true })
        for (threadId, at) in [("older-ask", 100.0), ("newest-ask", 200.0)] {
            task.threadId = threadId
            state.bots[botIndex].tasks?.append(task)
            ask.id = threadId
            ask.at = at
            ask.card?.requestId = threadId
            state.messages[threadId] = [ask]
        }

        XCTAssertEqual(state.updates(detail: .full).filter { $0.chat.id == "bot-busy" }.count, 3)
        let selected = state.liveActivityUpdates(detail: .full)
        XCTAssertEqual(selected.count, 3)
        XCTAssertEqual(Set(selected.map(\.chat.id)).count, selected.count)
        XCTAssertTrue(selected.allSatisfy { $0.chat.isBot && $0.kind != .toReview })
        XCTAssertEqual(selected.first { $0.chat.id == "bot-busy" }?.chat.threadId, "newest-ask")
        XCTAssertEqual(selected.first { $0.chat.id == "bot-busy" }?.card?.requestId, "newest-ask")
        XCTAssertEqual(state.liveActivityUpdates(detail: .full), selected)

        state.messages["newest-ask"]?[0].card?.answered = "Ship it"
        XCTAssertEqual(state.liveActivityUpdates(detail: .full).first { $0.chat.id == "bot-busy" }?.chat.threadId, "older-ask")
    }

    // MARK: - Pacing

    private func working(_ line: String, face: String = "working", threadId: String = "t-busy") -> BotActivityContent {
        BotActivityContent(
            face: face, kind: "working", headline: "Wren is working", line: line,
            threadId: threadId, card: nil, since: Date(timeIntervalSince1970: 0)
        )
    }

    func testContentIsBuiltFromTheUpdateAsTheIslandShowsIt() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "updates-fleet", withExtension: "json", subdirectory: "Fixtures"))
        var state = CompanionState()
        state.hydrate(try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url)))
        let since = Date(timeIntervalSince1970: 42)
        let updates = state.liveActivityUpdates(detail: .full)

        let ask = try XCTUnwrap(updates.first { $0.chat.threadId == "t-ask-new" })
        let asking = BotActivityContent(update: ask, face: "curious", since: since)
        XCTAssertEqual(asking.kind, "needsYou")
        XCTAssertEqual(asking.headline, "Pesto needs you")
        XCTAssertEqual(asking.line, "All gates are green on the fork")
        XCTAssertEqual(asking.threadId, "t-ask-new")
        XCTAssertEqual(asking.requestId, "req-new")
        XCTAssertEqual(asking.options, ["Ship it", "Hold"])
        XCTAssertEqual(asking.face, "curious")
        XCTAssertEqual(asking.since, since)

        let busy = try XCTUnwrap(updates.first { $0.chat.threadId == "t-busy" })
        let working = BotActivityContent(update: busy, face: "working", since: since)
        XCTAssertEqual(working.kind, "working")
        XCTAssertEqual(working.headline, "Wren is working")
        XCTAssertEqual(working.line, busy.line)
        XCTAssertNil(working.requestId)
        XCTAssertTrue(working.options.isEmpty)
    }

    func testAWorkingLineAloneIsHeldForItsIntervalThenSent() {
        var pacer = LiveActivityPacer()
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(pacer.decision(for: working("Reading"), bot: "bot-busy", at: start), .send, "a new activity goes at once")
        pacer.record(working("Reading"), bot: "bot-busy", at: start)
        XCTAssertEqual(pacer.decision(for: working("Reading"), bot: "bot-busy", at: start.addingTimeInterval(0.4)), .unchanged)

        let due = start.addingTimeInterval(LiveActivityPacer.workingLineInterval)
        XCTAssertEqual(pacer.decision(for: working("Reading the schema"), bot: "bot-busy", at: start.addingTimeInterval(0.4)), .held(until: due))
        XCTAssertEqual(pacer.decision(for: working("Reading the schema and"), bot: "bot-busy", at: due.addingTimeInterval(-0.1)), .held(until: due))
        XCTAssertEqual(pacer.decision(for: working("Reading the schema and"), bot: "bot-busy", at: due), .send)
        // Another bot's pacing is its own.
        XCTAssertEqual(pacer.decision(for: working("Writing"), bot: "bot-other", at: start.addingTimeInterval(0.4)), .send)
        // Unpaced, as before this gate existed.
        var unpaced = LiveActivityPacer(workingLineInterval: 0)
        unpaced.record(working("Reading"), bot: "bot-busy", at: start)
        XCTAssertEqual(unpaced.decision(for: working("Reading the schema"), bot: "bot-busy", at: start.addingTimeInterval(0.4)), .send)
        // A clock that went backwards does not hold a line for as long as it jumped.
        XCTAssertEqual(pacer.decision(for: working("Reading the schema"), bot: "bot-busy", at: start.addingTimeInterval(-60)), .send)
    }

    func testAsksStatusAndThreadChangesAreNeverHeld() {
        var pacer = LiveActivityPacer()
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let soon = start.addingTimeInterval(0.4)
        pacer.record(working("Reading"), bot: "bot-busy", at: start)

        let card = OptionCard(title: "Run shell?", subtitle: "echo hello", options: ["Allow", "Deny"], requestId: "request", tool: "shell")
        let ask = BotActivityContent(
            face: "curious", kind: "needsYou", headline: "Wren needs you", line: "echo hello",
            threadId: "t-busy", card: card, since: soon
        )
        XCTAssertEqual(pacer.decision(for: ask, bot: "bot-busy", at: soon), .send, "an ask")
        XCTAssertEqual(pacer.decision(for: working("Reading", face: "alerting"), bot: "bot-busy", at: soon), .send, "a failed tool's face")
        XCTAssertEqual(pacer.decision(for: working("Reading", threadId: "t-other"), bot: "bot-busy", at: soon), .send, "another thread")
        XCTAssertEqual(pacer.decision(for: working("Reading the schema", threadId: "t-other"), bot: "bot-busy", at: soon), .send)

        // An ask's own line is the question, not narration.
        pacer.record(ask, bot: "bot-busy", at: soon)
        var edited = ask
        edited.line = "echo goodbye"
        XCTAssertEqual(pacer.decision(for: edited, bot: "bot-busy", at: soon.addingTimeInterval(0.4)), .send)
        // Back to work after the answer is a kind change too.
        XCTAssertEqual(pacer.decision(for: working("Running it"), bot: "bot-busy", at: soon.addingTimeInterval(0.4)), .send)
        XCTAssertEqual(pacer.lastSent(forBot: "bot-busy"), ask)

        // An ended activity starts afresh.
        pacer.forget(bot: "bot-busy")
        XCTAssertNil(pacer.lastSent(forBot: "bot-busy"))
        XCTAssertEqual(pacer.decision(for: working("Reading"), bot: "bot-busy", at: soon.addingTimeInterval(0.8)), .send)
    }
}
