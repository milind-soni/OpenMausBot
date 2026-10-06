// Comfortable Home's preview lines, kept between renders.
//
// The cache is only worth having if a kept line is always the line a fresh
// fold would give, so every test here also checks it against
// `rosterPreview(visibleTranscript(forThread:))`.
import XCTest
@testable import CompanionCore

final class RosterPreviewCacheTests: XCTestCase {
    private func text(_ id: String, _ body: String, parent: String? = nil, at: Double = 1) -> Message {
        var message = Message(id: id, role: .bot, kind: .text, at: at)
        message.text = body
        message.parentId = parent
        return message
    }

    private func activity(_ id: String, _ name: String, ok: Bool? = true, at: Double = 1) -> Message {
        var message = Message(id: id, role: .bot, kind: .activity, at: at)
        message.tool = ToolActivity(name: name, ok: ok)
        return message
    }

    private func fresh(_ state: CompanionState, _ threadId: String, _ detail: ActivityDetail) -> String {
        rosterPreview(state.visibleTranscript(forThread: threadId), detail: detail)
    }

    private func assertAgrees(
        _ cache: RosterPreviewCache, _ state: CompanionState, _ threadId: String, _ detail: ActivityDetail,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(
            cache.preview(forThread: threadId, in: state, detail: detail), fresh(state, threadId, detail),
            file: file, line: line
        )
    }

    func testAnUnchangedThreadIsFoldedOnce() {
        var state = CompanionState()
        state.messages["t1"] = [text("a", "Deployed to staging"), activity("b", "shell")]
        state.messages["t2"] = [text("c", "Hello")]
        let cache = RosterPreviewCache()

        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "shell")
        XCTAssertEqual(cache.preview(forThread: "t2", in: state, detail: .full), "Hello")
        XCTAssertEqual(cache.folds, 2)

        // Another thread moving, or a streaming reply, is not this thread changing.
        state.messages["t2"]?.append(text("d", "Again"))
        state.streaming["t1"] = "typing…"
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "shell")
        XCTAssertEqual(cache.folds, 2)
        XCTAssertEqual(cache.preview(forThread: "t2", in: state, detail: .full), "Again")
        XCTAssertEqual(cache.folds, 3)
    }

    func testANewMessageIsFoldedAgain() {
        var state = CompanionState()
        state.messages["t1"] = [text("a", "First")]
        let cache = RosterPreviewCache()
        assertAgrees(cache, state, "t1", .full)

        state.apply(.message(threadId: "t1", message: text("b", "Second", at: 2)))
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "Second")
        XCTAssertEqual(cache.folds, 2)
    }

    /// The case a key built from the last message would miss: a step in the
    /// middle of a run finishes, and the run's summary changes with it.
    func testAnEarlierMessageChangingIsFoldedAgain() {
        var state = CompanionState()
        state.messages["t1"] = [
            text("a", "Working on it"),
            activity("b", "read"), activity("c", "write", ok: nil), activity("d", "test"),
        ]
        let cache = RosterPreviewCache()
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .reduced), "Running 3 steps")

        state.messages["t1"]?[2].tool = ToolActivity(name: "write", ok: true)
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .reduced), "Ran 3 steps")
        assertAgrees(cache, state, "t1", .reduced)
    }

    func testTheSettingIsPartOfTheLine() {
        var state = CompanionState()
        state.messages["t1"] = [text("a", "Deployed to staging"), activity("b", "shell")]
        let cache = RosterPreviewCache()

        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "shell")
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .hidden), "Deployed to staging")
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "shell")
        XCTAssertEqual(cache.folds, 3)
    }

    /// Switching branches changes what is visible without touching the
    /// stored transcript.
    func testMovingTheActiveBranchIsFoldedAgain() {
        var state = CompanionState()
        state.messages["t1"] = [
            text("q", "Question"),
            text("a1", "First answer", parent: "q"),
            text("a2", "Second answer", parent: "q"),
        ]
        state.activeLeafIds["t1"] = "a1"
        let cache = RosterPreviewCache()
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "First answer")

        state.activeLeafIds["t1"] = "a2"
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "Second answer")
        assertAgrees(cache, state, "t1", .full)
    }

    func testAnEditInFlightIsFoldedAgain() {
        var state = CompanionState()
        var question = text("q", "Original question")
        question.role = .user
        state.messages["t1"] = [question, text("a", "Answer", parent: "q")]
        let cache = RosterPreviewCache()
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "Answer")

        state.pendingEdits["t1"] = PendingEdit(sourceId: "q", text: "Edited question")
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "Edited question")
        assertAgrees(cache, state, "t1", .full)

        state.pendingEdits["t1"] = nil
        XCTAssertEqual(cache.preview(forThread: "t1", in: state, detail: .full), "Answer")
    }

    func testKeepOnlyForgetsTheOtherThreads() {
        var state = CompanionState()
        state.messages["t1"] = [text("a", "One")]
        state.messages["t2"] = [text("b", "Two")]
        let cache = RosterPreviewCache()
        _ = cache.preview(forThread: "t1", in: state, detail: .full)
        _ = cache.preview(forThread: "t2", in: state, detail: .full)

        cache.keepOnly(["t2"])
        _ = cache.preview(forThread: "t2", in: state, detail: .full)
        XCTAssertEqual(cache.folds, 2)
        _ = cache.preview(forThread: "t1", in: state, detail: .full)
        XCTAssertEqual(cache.folds, 3)

        cache.removeAll()
        _ = cache.preview(forThread: "t2", in: state, detail: .full)
        XCTAssertEqual(cache.folds, 4)
    }
}
