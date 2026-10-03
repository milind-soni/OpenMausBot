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
}
