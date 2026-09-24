// The two pieces of preference logic worth testing without a screen: how a
// transcript folds at each activity level, and how a quick-reply list
// survives a round trip through storage.
//
// Both are written against what the reader ends up seeing, not internals —
// a run collapses, a failure never does, and a corrupt store still puts
// four usable chips on the composer.
import XCTest
@testable import CompanionCore

final class ChatPreferencesTests: XCTestCase {
    private func text(_ id: String, at: Double = 1) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = "hello"
        return message
    }

    private func activity(_ id: String, at: Double = 1, ok: Bool? = true) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: "run", ok: ok)
        return message
    }

    /// What the harness appends after every settled turn: a work receipt,
    /// decoded from the wire exactly as it arrives.
    private func digest(_ id: String, at: Double = 1) -> Message {
        let json = """
        {"id":"\(id)","role":"bot","kind":"digest","at":\(at),"text":"[digest] · tools: /bin/bash -lc 'composio search' ×1 · reply: Done."}
        """
        return try! JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    // MARK: - Full

    func testFullKeepsEveryMessageInOrder() {
        let messages = [text("a"), activity("b"), activity("c"), text("d")]
        let rows = transcriptRows(messages, detail: .full)
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c", "d"])
        XCTAssertTrue(rows.allSatisfy { if case .message = $0 { return true } else { return false } })
    }

    // MARK: - Hidden

    func testHiddenDropsActivityAndKeepsTheRest() {
        let messages = [text("a"), activity("b"), activity("c"), text("d")]
        XCTAssertEqual(transcriptRows(messages, detail: .hidden).map(\.id), ["a", "d"])
    }

    // The digest and compaction receipts are the harness talking about the
    // tool calls: hidden with them, but never folded into a run of them.

    func testHiddenDropsDigestAndCompactionReceiptsToo() {
        let messages = [text("a"), activity("b"), digest("c"), text("d"), compaction("e")]
        XCTAssertEqual(transcriptRows(messages, detail: .hidden).map(\.id), ["a", "d"])
    }

    func testReducedKeepsACompactionAsItsOwnRowAndBreaksTheRun() {
        let messages = [activity("a"), activity("b"), compaction("c"), activity("d"), activity("e")]
        let rows = transcriptRows(messages, detail: .reduced)
        XCTAssertEqual(rows.map(\.id), ["run.a", "c", "run.d"])
        XCTAssertEqual(rows[1].kind, .compaction)
    }

    private func compaction(_ id: String, at: Double = 1) -> Message {
        var message = Message(id: id, role: .bot, kind: .compaction, at: at)
        message.text = "[compaction] summary"
        message.compaction = Compaction(summary: "summary", tokensBefore: 10)
        return message
    }

    func testHiddenDropsFailedActivityToo() {
        let messages = [text("a"), activity("b", ok: false)]
        XCTAssertEqual(transcriptRows(messages, detail: .hidden).map(\.id), ["a"])
    }

    // MARK: - Reduced

    func testReducedCollapsesConsecutiveActivityIntoOneRun() {
        let messages = [text("a"), activity("b"), activity("c"), activity("d"), text("e")]
        let rows = transcriptRows(messages, detail: .reduced)
        XCTAssertEqual(rows.count, 3)
        guard case let .activityRun(items) = rows[1] else { return XCTFail("expected a run") }
        XCTAssertEqual(items.map(\.id), ["b", "c", "d"])
    }

    func testReducedLeavesALoneActivityAlone() {
        // A run of one is not a run — collapsing it would replace a chip
        // with a chip that says there is one chip.
        let messages = [text("a"), activity("b"), text("c")]
        let rows = transcriptRows(messages, detail: .reduced)
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c"])
        guard case .message = rows[1] else { return XCTFail("expected a plain message") }
    }

    func testReducedBreaksOutAFailureOnItsOwn() {
        // The whole point of reduced: noise folds, failures never do.
        let messages = [activity("a"), activity("b"), activity("c", ok: false), activity("d"), activity("e")]
        let rows = transcriptRows(messages, detail: .reduced)
        XCTAssertEqual(rows.count, 3)
        guard case let .activityRun(before) = rows[0] else { return XCTFail("expected a run") }
        XCTAssertEqual(before.map(\.id), ["a", "b"])
        guard case let .message(failed) = rows[1] else { return XCTFail("expected the failure alone") }
        XCTAssertEqual(failed.id, "c")
        guard case let .activityRun(after) = rows[2] else { return XCTFail("expected a run") }
        XCTAssertEqual(after.map(\.id), ["d", "e"])
    }

    func testReducedSplitsRunsAroundOtherMessages() {
        let messages = [activity("a"), activity("b"), text("c"), activity("d"), activity("e")]
        let rows = transcriptRows(messages, detail: .reduced)
        XCTAssertEqual(rows.count, 3)
        guard case .activityRun = rows[0] else { return XCTFail("expected a run") }
        guard case .message = rows[1] else { return XCTFail("expected the text") }
        guard case .activityRun = rows[2] else { return XCTFail("expected a run") }
    }

    func testReducedRunReportsStillRunningWhileAStepHasNoVerdict() {
        let messages = [activity("a"), activity("b", ok: nil)]
        let rows = transcriptRows(messages, detail: .reduced)
        guard case let .activityRun(items) = rows[0] else { return XCTFail("expected a run") }
        XCTAssertTrue(items.contains { $0.tool?.ok == nil })
    }

    func testRowCarriesTheTimeAndSenderOfItsFirstMessage() {
        // The transcript's date separators and bubble tails read these off
        // the row rather than the message, so a run must answer for itself.
        let rows = transcriptRows([activity("a", at: 500), activity("b", at: 900)], detail: .reduced)
        XCTAssertEqual(rows[0].at, 500)
        XCTAssertEqual(rows[0].kind, .activity)
        XCTAssertEqual(rows[0].role, .bot)
        XCTAssertEqual(rows[0].endAt, 900)
    }

    func testEmptyTranscriptStaysEmptyAtEveryLevel() {
        for detail in ActivityDetail.allCases {
            XCTAssertTrue(transcriptRows([], detail: detail).isEmpty)
        }
    }

    // MARK: - Quick replies

    func testDefaultsAreTheFourChipsTheComposerAlreadyShows() {
        XCTAssertEqual(QuickReply.defaults.count, 4)
        XCTAssertEqual(QuickReply.defaults.map(\.title), ["Show diff", "Run tests", "Explain steps", "What's next?"])
    }

    func testQuickRepliesSurviveARoundTrip() {
        let mine = [
            QuickReply(title: "Deploy", prompt: "Deploy to staging", icon: "paperplane"),
            QuickReply(title: "Log", prompt: "Show the last 50 log lines", icon: "doc.text"),
        ]
        XCTAssertEqual(QuickReply.decode(QuickReply.encode(mine)), mine)
    }

    func testAnEmptyStoreFallsBackToDefaults() {
        // First launch: nothing written yet.
        XCTAssertEqual(QuickReply.decode(""), QuickReply.defaults)
    }

    func testCorruptStoreFallsBackToDefaultsRatherThanNoChips() {
        // A composer with no chips is worse than a composer with the stock
        // ones, so a bad decode is not allowed to empty the row.
        XCTAssertEqual(QuickReply.decode("{not json"), QuickReply.defaults)
    }

    func testDeletingEveryChipIsRespectedRatherThanReset() {
        // Distinct from a corrupt store: an explicit empty list means the
        // user cleared the row on purpose and it must stay cleared.
        XCTAssertEqual(QuickReply.decode(QuickReply.encode([])), [])
    }

    func testEmptyQuickReplyIDFallsBackToDefaults() {
        let replies = [QuickReply(id: " ", title: "Deploy", prompt: "Deploy", icon: "paperplane")]
        XCTAssertEqual(QuickReply.decode(QuickReply.encode(replies)), QuickReply.defaults)
    }

    func testDuplicateQuickReplyIDsFallBackToDefaults() {
        let replies = [
            QuickReply(id: "same", title: "Deploy", prompt: "Deploy", icon: "paperplane"),
            QuickReply(id: "same", title: "Logs", prompt: "Show logs", icon: "doc.text"),
        ]
        XCTAssertEqual(QuickReply.decode(QuickReply.encode(replies)), QuickReply.defaults)
    }

    // MARK: - Island intro

    func testIslandIntroDefaultsToOncePerBot() {
        XCTAssertEqual(IslandIntro.oncePerBot.rawValue, "oncePerBot")
        XCTAssertEqual(IslandIntro(rawValue: "nonsense"), nil)
        XCTAssertEqual(IslandIntro.allCases.count, 3)
    }

    // MARK: - Digests

    // The harness writes a "[digest] · tools: … · reply: …" receipt after
    // every turn. Desktop shows it only behind "show tool calls"; the phone
    // drew it as a bubble under every reply. It is never a row.
    func testADigestIsNeverATranscriptRow() {
        let messages = [text("a"), activity("b"), digest("c"), text("d"), digest("e")]
        XCTAssertEqual(transcriptRows(messages, detail: .full).map(\.id), ["a", "b", "d"])
        XCTAssertEqual(transcriptRows(messages, detail: .hidden).map(\.id), ["a", "d"])
        XCTAssertEqual(transcriptRows(messages, detail: .reduced).map(\.id), ["a", "b", "d"])
    }
}
