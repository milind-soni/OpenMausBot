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

    func testSnapshotOmitsTranscriptsAndUnrelatedTasksWithoutChangingWidgetContent() throws {
        let state = try hydrated
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
        for (row, update) in zip(snapshot.rows, state.updates(detail: .full)) {
            XCTAssertEqual(row.chat.destination, update.chat.destination)
            XCTAssertEqual(row.chat.name, update.chat.name)
            XCTAssertEqual(row.chat.color, update.chat.color)
            XCTAssertEqual(row.chat.threadTitle, update.chat.threadTitle)
            XCTAssertEqual(row.card, update.card)
            switch row.chat {
            case let .bot(bot):
                XCTAssertNil(bot.messages)
                XCTAssertNil(bot.projects)
                XCTAssertTrue((bot.tasks ?? []).allSatisfy { $0.threadId == bot.threadId })
            case let .room(room):
                XCTAssertNil(room.messages)
                XCTAssertTrue((room.tasks ?? []).allSatisfy { $0.threadId == room.threadId })
            }
        }
        // Deriving the compact snapshot never changes the app's transcript.
        XCTAssertFalse(try XCTUnwrap(state.messages["t-ask-new"]).isEmpty)
    }

    func testUnchangedPayloadRenewsAtMostOnceAMinuteAndChangesPublishImmediately() throws {
        var state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func snapshot(at offset: TimeInterval = 0, connectionID: String = "computer-1") -> WidgetSnapshot {
            state.widgetSnapshot(connectionID: connectionID, detail: .full, now: now.addingTimeInterval(offset)) { _ in "idle" }
        }
        let first = snapshot()
        XCTAssertTrue(first.shouldReplace(nil))
        XCTAssertFalse(snapshot(at: 0.001).shouldReplace(first))
        XCTAssertFalse(snapshot(at: 59.999).shouldReplace(first))
        XCTAssertTrue(snapshot(at: 60).shouldReplace(first))
        XCTAssertTrue(snapshot(at: -1).shouldReplace(first))
        XCTAssertTrue(snapshot(connectionID: "computer-2").shouldReplace(first))
        XCTAssertTrue(state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "alerting" }.shouldReplace(first))

        let index = try XCTUnwrap(state.bots.firstIndex { $0.id == "bot-ask-new" })
        state.bots[index].name = "Renamed"
        XCTAssertTrue(snapshot().shouldReplace(first))
        let renamed = snapshot()
        state.bots[index].color = "red"
        XCTAssertTrue(snapshot().shouldReplace(renamed))
        let recolored = snapshot()
        state.bots[index].tasks?[0].title = "New thread title"
        XCTAssertTrue(snapshot().shouldReplace(recolored))
        let retitled = snapshot()
        let cardIndex = try XCTUnwrap(state.messages["t-ask-new"]?.firstIndex { $0.card?.requestId == "req-new" })
        state.messages["t-ask-new"]?[cardIndex].card?.options = ["Cancel"]
        XCTAssertTrue(snapshot().shouldReplace(retitled))
        let changedOptions = snapshot()
        state.messages["t-ask-new"]?[cardIndex].card?.answered = "Cancel"
        XCTAssertTrue(snapshot().shouldReplace(changedOptions))

        // Equality for a widget payload never extends the trust window on
        // an old snapshot that the app has stopped refreshing.
        XCTAssertNil(first.answerableCard(
            threadId: "t-ask-new", requestId: "req-new", choice: "Ship it", isPermission: false,
            at: now.addingTimeInterval(WidgetSnapshot.answerMaximumAge + 0.1)
        ))

        // Room identity equality intentionally ignores the selected thread;
        // the widget's deep link must not inherit that shortcut.
        var room = try XCTUnwrap(state.rooms.first)
        let oldRow = WidgetSnapshot.Row(chat: .room(room), kind: .working, line: "Working", card: nil, face: "idle", since: nil)
        room.threadId = "new-room-thread"
        let newRow = WidgetSnapshot.Row(chat: .room(room), kind: .working, line: "Working", card: nil, face: "idle", since: nil)
        XCTAssertEqual(oldRow, newRow)
        XCTAssertTrue(WidgetSnapshot(writtenAt: now, connectionID: "computer-1", rows: [newRow])
            .shouldReplace(WidgetSnapshot(writtenAt: now, connectionID: "computer-1", rows: [oldRow])))
    }

    func testAWorkingLineAloneWaitsItsIntervalAndEverythingElsePublishesAtOnce() throws {
        var state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func snapshot(at offset: TimeInterval, face: String = "idle") -> WidgetSnapshot {
            state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(offset)) { _ in face }
        }
        state.streaming["t-busy"] = "Reading the schema"
        let first = snapshot(at: 0)
        state.streaming["t-busy"]? += " and the migrations"
        let narrated = snapshot(at: 0.4)
        XCTAssertNotEqual(narrated.rows, first.rows, "the streamed tail is in the row")
        XCTAssertFalse(narrated.shouldReplace(first), "a streamed word is not worth a reload")
        XCTAssertFalse(snapshot(at: WidgetSnapshot.workingLineInterval - 0.1).shouldReplace(first))
        XCTAssertTrue(snapshot(at: WidgetSnapshot.workingLineInterval).shouldReplace(first))
        // Unpaced, as before this gate existed.
        XCTAssertTrue(narrated.shouldReplace(first, workingLineInterval: 0))
        // The narration interval never outlasts the renewal.
        XCTAssertTrue(snapshot(at: WidgetSnapshot.renewalInterval).shouldReplace(first, workingLineInterval: 600))
        XCTAssertFalse(snapshot(at: WidgetSnapshot.renewalInterval - 0.1).shouldReplace(first, workingLineInterval: 600))

        // While narration is held, anything else still goes in its window.
        XCTAssertTrue(snapshot(at: 0.4, face: "alerting").shouldReplace(first), "a face change")
        XCTAssertTrue(state.widgetSnapshot(connectionID: "computer-2", detail: .full, now: now.addingTimeInterval(0.4)) { _ in "idle" }
            .shouldReplace(first), "another computer")
        var changed = state
        let busy = try XCTUnwrap(changed.bots.firstIndex { $0.id == "bot-busy" })
        changed.bots[busy].tasks?[0].busy = false
        changed.bots[busy].tasks?[0].activity = "waiting-on-you"
        XCTAssertTrue(changed.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(0.4)) { _ in "idle" }
            .shouldReplace(first), "the bot stopped to ask")
        changed = state
        changed.bots[busy].tasks?[0].busy = false
        XCTAssertTrue(changed.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(0.4)) { _ in "idle" }
            .shouldReplace(first), "the bot finished")
        changed = state
        let idle = try XCTUnwrap(changed.bots.firstIndex { $0.id == "bot-idle" })
        changed.bots[idle].busy = true
        changed.bots[idle].tasks = changed.bots[idle].tasks?.map { task in
            var task = task
            task.busy = true
            return task
        }
        XCTAssertGreaterThan(
            changed.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }.rows.count, first.rows.count
        )
        XCTAssertTrue(changed.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(0.4)) { _ in "idle" }
            .shouldReplace(first), "another bot started")
        changed = state
        changed.bots[busy].name = "Renamed"
        XCTAssertTrue(changed.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(0.4)) { _ in "idle" }
            .shouldReplace(first), "a rename")

        // Only a working row's line is narration: an ask's line is the
        // question, a finished chat's is its reply.
        for kind in [ChatUpdate.Kind.needsYou, .toReview] {
            let row = try XCTUnwrap(first.rows.first { $0.kind == kind })
            let edited = WidgetSnapshot.Row(chat: row.chat, kind: kind, line: row.line + " (edited)", card: row.card, face: row.face, since: row.since)
            let rows = first.rows.map { $0.chat.threadId == row.chat.threadId ? edited : $0 }
            XCTAssertTrue(WidgetSnapshot(writtenAt: now.addingTimeInterval(0.4), connectionID: "computer-1", rows: rows, detail: first.detail)
                .shouldReplace(first), "\(kind) line change")
        }
    }

    func testTheLastWriteBeforeSuspensionLandsAHeldWorkingLine() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-writer-exact-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = WidgetSnapshotStore(directory: directory)
        let writer = WidgetSnapshotWriter(store: store)
        var state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        state.streaming["t-busy"] = "Reading the schema"
        let first = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "idle" }
        state.streaming["t-busy"]? += " and the migrations"
        let narrated = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(1)) { _ in "idle" }
        let unchanged = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(2)) { _ in "idle" }
        let completed = expectation(description: "paced, then exact")
        completed.expectedFulfillmentCount = 4
        writer.publish(first) { changed in
            XCTAssertTrue(changed)
            completed.fulfill()
        }
        writer.publish(narrated) { changed in
            XCTAssertFalse(changed, "a window's narration waits")
            XCTAssertEqual(store.read(), first)
            completed.fulfill()
        }
        writer.publish(narrated, exact: true) { changed in
            XCTAssertTrue(changed, "the flush writes it")
            XCTAssertEqual(store.read(), narrated)
            completed.fulfill()
        }
        writer.publish(unchanged, exact: true) { changed in
            XCTAssertFalse(changed, "an exact write still skips an identical payload until its renewal")
            completed.fulfill()
        }
        wait(for: [completed], timeout: 5)
    }

    func testRowsMirrorUpdatesOneToOneWithFacesResolvedAtWriteTime() throws {
        let state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { chat in
            "face-of-\(chat.threadId)"
        }
        XCTAssertEqual(snapshot.writtenAt, now)
        XCTAssertEqual(snapshot.connectionID, "computer-1")
        XCTAssertEqual(snapshot.rows.count, state.updates(detail: .full).count)
        XCTAssertEqual(snapshot.rows.map(\.chat.threadId), state.updates(detail: .full).map(\.chat.threadId))
        XCTAssertEqual(snapshot.rows.map(\.kind), state.updates(detail: .full).map(\.kind))
        XCTAssertEqual(snapshot.rows.map(\.line), state.updates(detail: .full).map(\.line))
        XCTAssertEqual(snapshot.rows.map(\.card), state.updates(detail: .full).map(\.card))
        // The face is whatever the app resolved when it wrote — one per
        // row, so the widget needs no live state to draw one.
        XCTAssertEqual(snapshot.rows.map(\.face), state.updates(detail: .full).map { "face-of-\($0.chat.threadId)" })
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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
        let row = try XCTUnwrap(snapshot.rows.first { $0.chat.threadId == "t-ask-old" })
        // The ask stays visible — a SKILL.md must be read in the chat
        // before it enables anything — but no compact surface may grow an
        // answer pill for it.
        XCTAssertEqual(row.card?.skillRequest?.name, "deploy-helper")
        XCTAssertTrue(row.answerOptions.isEmpty)
    }

    func testLiveAsksCarryTheirOptionsAndNothingElseDoes() throws {
        let state = try hydrated
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: began) { _ in "idle" } since: { _ in
            stamped = true
            return began
        }
        // The stamp is exactly what the closure said, once per row; a
        // writer that knows nothing passes nothing and the rows say so.
        XCTAssertEqual(snapshot.rows.map(\.since), snapshot.rows.map { _ in began })
        XCTAssertTrue(stamped)

        let unstamped = state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: began) { _ in "idle" }
        var seeded = WidgetSinceClock(seed: snapshot)
        XCTAssertEqual(seeded.stamp(for: askChat, kind: .needsYou, at: returned), returned)

        var reseeded = WidgetSinceClock(seed: try hydrated.widgetSnapshot(
            connectionID: "computer-1",
            detail: .full,
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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "idle" }

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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }

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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: written) { _ in "idle" }

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
            state.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
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
        let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "idle" }

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

    func testWriterRunsOffMainAndPreservesWriteUnpairPairOrder() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-writer-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = WidgetSnapshotStore(directory: directory)
        let writer = WidgetSnapshotWriter(store: store)
        let state = try hydrated
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let first = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "idle" }
        let duplicate = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now.addingTimeInterval(0.001)) { _ in "idle" }
        let paired = state.widgetSnapshot(connectionID: "computer-2", detail: .full, now: now) { _ in "idle" }
        let completed = expectation(description: "ordered writes")
        completed.expectedFulfillmentCount = 4
        writer.publish(first) { changed in
            XCTAssertFalse(Thread.isMainThread)
            XCTAssertTrue(changed)
            XCTAssertEqual(store.read(), first)
            completed.fulfill()
        }
        writer.publish(duplicate) { changed in
            XCTAssertFalse(changed)
            XCTAssertEqual(store.read(), first)
            completed.fulfill()
        }
        writer.publish(nil) { changed in
            XCTAssertTrue(changed)
            XCTAssertNil(store.read())
            completed.fulfill()
        }
        writer.publish(paired) { changed in
            XCTAssertTrue(changed)
            XCTAssertEqual(store.read(), paired)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 5)
        XCTAssertEqual(store.read(), paired)
    }

    func testWriterRetriesAnUnchangedPayloadAfterWriteFailure() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-writer-failure-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        // A file where the container directory belongs makes the first
        // write fail, without changing real App Group permissions.
        try Data("blocked".utf8).write(to: directory)
        let store = WidgetSnapshotStore(directory: directory)
        let writer = WidgetSnapshotWriter(store: store)
        let snapshot = try hydrated.widgetSnapshot(connectionID: "computer-1", detail: .full) { _ in "idle" }
        let completed = expectation(description: "retry after failed write")
        completed.expectedFulfillmentCount = 2
        writer.publish(snapshot) { changed in
            XCTAssertFalse(changed)
            XCTAssertNil(store.read())
            try? FileManager.default.removeItem(at: directory)
            completed.fulfill()
        }
        writer.publish(snapshot) { changed in
            XCTAssertTrue(changed)
            XCTAssertEqual(store.read()?.connectionID, snapshot.connectionID)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 5)
        XCTAssertEqual(store.read()?.connectionID, snapshot.connectionID)
    }

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
            detail: .full,
            now: Date(timeIntervalSince1970: 1_700_000_000)
        ) { _ in "idle" }
        try store.write(first)
        XCTAssertEqual(store.read(), first)

        let second = state.widgetSnapshot(
            connectionID: "computer-2",
            detail: .full,
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

    func testASnapshotRemembersTheActivitySettingItWasFoldedUnder() throws {
        // The widget's own background refresh cannot read the app's
        // settings; it reuses the one the app wrote with (MOCA-204).
        let state = try hydrated
        let hidden = state.widgetSnapshot(connectionID: "computer-1", detail: .hidden) { _ in "idle" }
        XCTAssertEqual(hidden.detail, .hidden)
        XCTAssertEqual(hidden.removingRow(answeredInThread: "t-ask-new").detail, .hidden)
        let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(hidden))
        XCTAssertEqual(decoded.detail, .hidden)
        // A file written before the field existed still reads.
        let legacy = try JSONDecoder().decode(WidgetSnapshot.self, from: Data(#"{"writtenAt":0,"connectionID":"c","rows":[]}"#.utf8))
        XCTAssertNil(legacy.detail)
    }
}
