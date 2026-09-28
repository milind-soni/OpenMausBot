// The widget snapshot contract: what the app freezes must be exactly what
// the widget extension thaws. The derivation rides the same fixture fleet
// as the Updates characterization, so the pill and the widgets can never
// disagree about what an update is; the store round-trips the one file both
// processes share, including the failure modes a reader can hit.
import XCTest
@testable import CompanionCore

final class WidgetSnapshotTests: XCTestCase {
    // MARK: - Fixtures

    private func fixture(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: name, withExtension: "json")
        else {
            XCTFail("missing fixture \(name).json")
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    /// The fleet hydrated exactly as a cold `GET /api/bots` would land.
    private var hydrated: CompanionState {
        get throws {
            let fleet = try JSONDecoder().decode(Fleet.self, from: try fixture("updates-fleet"))
            var state = CompanionState()
            state.hydrate(fleet)
            return state
        }
    }

    // MARK: - Derivation

    func testRowsMirrorUpdatesOneToOneWithFacesResolvedAtWriteTime() throws {
        let state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: now) { chat in
            "face-of-\(chat.threadId)"
        }
        XCTAssertEqual(snapshot.writtenAt, now)
        XCTAssertEqual(snapshot.connectionID, "computer-1")
        XCTAssertEqual(snapshot.rows.count, state.updates.count)
        XCTAssertEqual(snapshot.rows.map(\.chat.threadId), state.updates.map(\.chat.threadId))
        XCTAssertEqual(snapshot.rows.map(\.kind), state.updates.map(\.kind))
        XCTAssertEqual(snapshot.rows.map(\.line), state.updates.map(\.line))
        XCTAssertEqual(snapshot.rows.map(\.card), state.updates.map(\.card))
        // The face is whatever the app resolved when it wrote — one per
        // row, so the widget needs no live state to draw one.
        XCTAssertEqual(snapshot.rows.map(\.face), state.updates.map { "face-of-\($0.chat.threadId)" })
    }

    func testSkillRequestRowsKeepTheCardButOfferNoQuickAnswers() throws {
        var state = try hydrated
        let index = try XCTUnwrap(
            state.messages["t-ask-old"]?.firstIndex { $0.card?.requestId == "req-old-second" }
        )
        state.messages["t-ask-old"]?[index].card?.skillRequest = SkillRequestCardData(
            version: 1,
            requestId: "req-old-second",
            botId: "bot-ask-old",
            threadId: "t-ask-old",
            stagedId: "stage-1",
            action: "learn",
            name: "deploy-helper",
            gist: "Deploys the app",
            source: nil,
            preview: nil,
            sha256: nil,
            warnings: [],
            createdAt: 20
        )
        let snapshot = state.widgetSnapshot(connectionID: "computer-1") { _ in "idle" }
        let row = try XCTUnwrap(snapshot.rows.first { $0.chat.threadId == "t-ask-old" })
        // The ask stays visible — a SKILL.md must be read in the chat
        // before it enables anything — but no compact surface may grow an
        // answer pill for it.
        XCTAssertEqual(row.card?.skillRequest?.name, "deploy-helper")
        XCTAssertTrue(row.answerOptions.isEmpty)
    }

    func testLiveAsksCarryTheirOptionsAndNothingElseDoes() throws {
        let state = try hydrated
        let snapshot = state.widgetSnapshot(connectionID: "computer-1") { _ in "idle" }
        XCTAssertEqual(snapshot.rows.first { $0.chat.threadId == "t-ask-new" }?.answerOptions, ["Ship it", "Hold"])
        XCTAssertEqual(snapshot.rows.first { $0.chat.threadId == "t-ask-old" }?.answerOptions, ["Go", "Stop"])
        // Working, to-review, and room rows are not asks; waiting-on-you
        // has no card at all. None of them may grow pills.
        for row in snapshot.rows where row.chat.threadId != "t-ask-new" && row.chat.threadId != "t-ask-old" {
            XCTAssertTrue(row.answerOptions.isEmpty, "row \(row.chat.threadId) grew answer options")
        }
    }

    func testAnswerOptionsRequireALiveNeedsYouAsk() throws {
        let state = try hydrated
        let chat = try XCTUnwrap(state.chat(forThread: "t-ask-new"))
        let card = try XCTUnwrap(state.messages["t-ask-new"]?.last?.card)

        XCTAssertEqual(ChatUpdate(chat: chat, kind: .needsYou, line: "", card: card).answerOptions, ["Ship it", "Hold"])

        var answered = card
        answered.answered = "Ship it"
        XCTAssertTrue(ChatUpdate(chat: chat, kind: .needsYou, line: "", card: answered).answerOptions.isEmpty)

        var dismissed = card
        dismissed.dismissed = true
        XCTAssertTrue(ChatUpdate(chat: chat, kind: .needsYou, line: "", card: dismissed).answerOptions.isEmpty)

        XCTAssertTrue(ChatUpdate(chat: chat, kind: .working, line: "", card: card).answerOptions.isEmpty)
        XCTAssertTrue(ChatUpdate(chat: chat, kind: .needsYou, line: "", card: nil).answerOptions.isEmpty)
    }

    func testSinceClosureStampsEachRowAndDefaultsToUnknown() throws {
        let state = try hydrated
        let began = Date(timeIntervalSince1970: 1_700_000_100)
        var stamped = false
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: began) { _ in "idle" } since: { _ in
            stamped = true
            return began
        }
        // The stamp is exactly what the closure said, once per row; a
        // writer that knows nothing passes nothing and the rows say so.
        XCTAssertEqual(snapshot.rows.map(\.since), snapshot.rows.map { _ in began })
        XCTAssertTrue(stamped)

        let unstamped = state.widgetSnapshot(connectionID: "computer-1") { _ in "idle" }
        XCTAssertEqual(unstamped.rows.map(\.since), snapshot.rows.map { _ in nil })
    }

    func testSinceClockHoldsWhileKindHoldsAndRestartsOnKindChange() throws {
        let state = try hydrated
        let chat = try XCTUnwrap(state.chat(forThread: "t-ask-new"))
        var clock = WidgetSinceClock()
        let first = Date(timeIntervalSince1970: 1_700_000_000)
        let later = first.addingTimeInterval(600)

        // The first sighting starts the clock; the same kind keeps it.
        XCTAssertEqual(clock.stamp(for: chat, kind: .needsYou, at: first), first)
        XCTAssertEqual(clock.stamp(for: chat, kind: .needsYou, at: later), first)
        // A new kind is a new beginning — the island restarts the same way.
        XCTAssertEqual(clock.stamp(for: chat, kind: .working, at: later), later)
        XCTAssertEqual(clock.stamp(for: chat, kind: .working, at: later.addingTimeInterval(60)), later)
    }

    func testSinceClockForgetsDepartedChatsAndSeedsFromTheLastSnapshot() throws {
        let state = try hydrated
        let askChat = try XCTUnwrap(state.chat(forThread: "t-ask-new"))
        let otherChat = try XCTUnwrap(state.chat(forThread: "t-ask-old"))
        let began = Date(timeIntervalSince1970: 1_700_000_000)
        var clock = WidgetSinceClock()
        _ = clock.stamp(for: askChat, kind: .needsYou, at: began)
        _ = clock.stamp(for: otherChat, kind: .working, at: began)

        // A chat leaving the updates forgets its stamp, so a return
        // restarts instead of resurrecting a clock from another era —
        // while the chat that stayed keeps its clock running.
        clock.forget(absentFrom: [askChat])
        let returned = Date(timeIntervalSince1970: 1_700_006_000)
        XCTAssertEqual(clock.stamp(for: askChat, kind: .needsYou, at: returned), began)
        XCTAssertEqual(clock.stamp(for: otherChat, kind: .working, at: returned), returned)

        // Seeding from the last snapshot carries elapsed time across a
        // relaunch — and ignores rows that never had a stamp.
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: began) { _ in "idle" }
        var seeded = WidgetSinceClock(seed: snapshot)
        XCTAssertEqual(seeded.stamp(for: askChat, kind: .needsYou, at: returned), returned)

        var reseeded = WidgetSinceClock(seed: try hydrated.widgetSnapshot(
            connectionID: "computer-1",
            now: began
        ) { _ in "idle" } since: { update in
            update.chat.threadId == "t-ask-new" ? began : nil
        })
        XCTAssertEqual(reseeded.stamp(for: askChat, kind: .needsYou, at: returned), began)
        XCTAssertEqual(reseeded.stamp(for: otherChat, kind: .needsYou, at: returned), returned)
    }

    // MARK: - Answering

    func testAnswerableCardMatchesTheRenderedPill() throws {
        let state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: now) { _ in "idle" }

        // The exact pill a widget rendered: same thread, same request,
        // an offered option, the same card kind.
        let card = try XCTUnwrap(
            snapshot.answerableCard(
                threadId: "t-ask-new",
                requestId: "req-new",
                choice: "Ship it",
                isPermission: false,
                at: now
            )
        )
        XCTAssertEqual(card.options, ["Ship it", "Hold"])
        XCTAssertEqual(card.requestId, "req-new")
    }

    func testAnswerableCardRejectsEveryMismatchWithTheRenderedPill() throws {
        let state = try hydrated
        let snapshot = state.widgetSnapshot(connectionID: "computer-1") { _ in "idle" }

        // Wrong thread: a working chat has no ask to answer.
        XCTAssertNil(
            snapshot.answerableCard(threadId: "t-busy", requestId: "req-new", choice: "Ship it", isPermission: false)
        )
        // Wrong request: the pill belonged to an earlier ask.
        XCTAssertNil(
            snapshot.answerableCard(threadId: "t-ask-new", requestId: "req-old", choice: "Ship it", isPermission: false)
        )
        // A choice the pill never offered.
        XCTAssertNil(
            snapshot.answerableCard(threadId: "t-ask-new", requestId: "req-new", choice: "Restart everything", isPermission: false)
        )
        // The wrong card kind: permission asks answer through a
        // different endpoint contract than questions.
        XCTAssertNil(
            snapshot.answerableCard(threadId: "t-ask-new", requestId: "req-new", choice: "Ship it", isPermission: true)
        )
    }

    func testAnswerableCardExpiresSoAStalePillCannotAnswer() throws {
        let state = try hydrated
        let written = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: written) { _ in "idle" }

        // Ten minutes is still the snapshot's moment; ten minutes and a
        // tick is history the chat may already have moved past.
        XCTAssertNotNil(
            snapshot.answerableCard(
                threadId: "t-ask-new", requestId: "req-new", choice: "Ship it",
                isPermission: false, at: written.addingTimeInterval(WidgetSnapshot.answerMaximumAge)
            )
        )
        XCTAssertNil(
            snapshot.answerableCard(
                threadId: "t-ask-new", requestId: "req-new", choice: "Ship it",
                isPermission: false, at: written.addingTimeInterval(WidgetSnapshot.answerMaximumAge + 0.1)
            )
        )
    }

    func testAnswerableCardRefusesAnsweredDismissedAndSkillRequests() throws {
        var state = try hydrated
        func snapshot() -> WidgetSnapshot {
            state.widgetSnapshot(connectionID: "computer-1") { _ in "idle" }
        }
        let index = try XCTUnwrap(
            state.messages["t-ask-new"]?.firstIndex { $0.card?.requestId == "req-new" }
        )

        // Already answered in the chat.
        state.messages["t-ask-new"]?[index].card?.answered = "Ship it"
        XCTAssertNil(
            snapshot().answerableCard(threadId: "t-ask-new", requestId: "req-new", choice: "Ship it", isPermission: false)
        )

        // Dismissed in the chat.
        state.messages["t-ask-new"]?[index].card?.answered = nil
        state.messages["t-ask-new"]?[index].card?.dismissed = true
        XCTAssertNil(
            snapshot().answerableCard(threadId: "t-ask-new", requestId: "req-new", choice: "Ship it", isPermission: false)
        )

        // A SKILL.md request: compact surfaces never grow pills for
        // those, so none may answer one either.
        state.messages["t-ask-new"]?[index].card?.dismissed = false
        state.messages["t-ask-new"]?[index].card?.skillRequest = SkillRequestCardData(
            version: 1,
            requestId: "req-new",
            botId: "bot-ask-new",
            threadId: "t-ask-new",
            stagedId: "stage-1",
            action: "learn",
            name: "deploy-helper",
            gist: "Deploys the app",
            source: nil,
            preview: nil,
            sha256: nil,
            warnings: [],
            createdAt: 20
        )
        XCTAssertNil(
            snapshot().answerableCard(threadId: "t-ask-new", requestId: "req-new", choice: "Ship it", isPermission: false)
        )
    }

    func testRemovingRowDropsTheAnsweredAskAndKeepsTheRestAsWritten() throws {
        let state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", now: now) { _ in "idle" }

        let after = snapshot.removingRow(answeredInThread: "t-ask-new")
        XCTAssertFalse(after.rows.contains { $0.chat.threadId == "t-ask-new" })
        XCTAssertEqual(
            after.rows.map(\.chat.threadId),
            snapshot.rows.map(\.chat.threadId).filter { $0 != "t-ask-new" }
        )
        // The write is not new information: the survivor rows keep the
        // timestamp and connection they were written with.
        XCTAssertEqual(after.writtenAt, now)
        XCTAssertEqual(after.connectionID, "computer-1")
    }

    // MARK: - Store

    func testStoreRoundTripsReplacesAndRemoves() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-snapshot-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = WidgetSnapshotStore(directory: directory)

        // No file yet: the reader says nil; it never invents content.
        XCTAssertNil(store.read())

        let state = try hydrated
        let first = state.widgetSnapshot(
            connectionID: "computer-1",
            now: Date(timeIntervalSince1970: 1_700_000_000)
        ) { _ in "idle" }
        try store.write(first)
        XCTAssertEqual(store.read(), first)

        let second = state.widgetSnapshot(
            connectionID: "computer-2",
            now: Date(timeIntervalSince1970: 1_700_000_060)
        ) { _ in "working" }
        try store.write(second)
        XCTAssertEqual(store.read(), second)

        store.remove()
        XCTAssertNil(store.read())
    }

    func testAnUndecodableFileReadsAsNilAndStaysForDiagnosis() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-snapshot-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = WidgetSnapshotStore(directory: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not a snapshot".utf8).write(to: store.fileURL)

        XCTAssertNil(store.read())
        // A corrupt file is evidence, not garbage: the reader leaves it for
        // the app's next good write to replace.
        XCTAssertEqual(try String(contentsOf: store.fileURL, encoding: .utf8), "not a snapshot")
    }
}
