// A routine run's card and a turn's digest, as the phone reads them off
// the wire. Both used to reach the reader as one line of text — "Routine
// “X” completed" with the report dropped, or no digest at all — so these
// are written against what ends up on screen: the report, the state in the
// computer's own words, and a digest's parts without its reply.
import XCTest
@testable import CompanionCore

final class RoutineRunDigestTests: XCTestCase {
    private func decode(_ json: String) throws -> Message {
        try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    // MARK: - Decoding

    func testARoutineRunDecodesItsCard() throws {
        let message = try decode("""
        {"id":"r1","role":"bot","kind":"routine.run","at":1,"text":"Routine “Inbox sweep” completed",
         "routineRun":{"runId":"run-1","routineId":"rt-1","routineName":"Inbox sweep","scheduledFor":1790000000000,
          "status":"completed","executionThreadId":"exec-1","summary":"Three replies drafted.\\nOne needs you."}}
        """)
        XCTAssertEqual(message.kind, .routineRun)
        let card = try XCTUnwrap(message.routineRun)
        XCTAssertEqual(card.knownStatus, .completed)
        XCTAssertEqual(card.executionThreadId, "exec-1")
        XCTAssertEqual(card.summary, "Three replies drafted.\nOne needs you.")
        XCTAssertEqual(card.headline, "Routine “Inbox sweep” completed")
    }

    // Older or partial computers can send the kind without the card; the
    // text is written for exactly that reader.
    func testARoutineRunWithoutItsCardKeepsTheText() throws {
        let message = try decode("""
        {"id":"r1","role":"bot","kind":"routine.run","at":1,"text":"Routine “Inbox sweep” completed"}
        """)
        XCTAssertEqual(message.kind, .routineRun)
        XCTAssertNil(message.routineRun)
        XCTAssertEqual(previewText(of: message), "Routine “Inbox sweep” completed")
    }

    // A status added on the computer after this build must not cost the
    // message — or the page it arrived in.
    func testAnUnknownStatusStillDecodesAndReadsAsItself() throws {
        let message = try decode("""
        {"id":"r1","role":"bot","kind":"routine.run","at":1,"text":"x",
         "routineRun":{"runId":"run-1","routineId":"rt-1","routineName":"Sweep","status":"rehearsing","goalStatus":"pondering"}}
        """)
        let card = try XCTUnwrap(message.routineRun)
        XCTAssertNil(card.knownStatus)
        XCTAssertEqual(card.stateText, "rehearsing")
        XCTAssertEqual(card.tone, .neutral)
    }

    func testAMistypedCardFieldCostsOnlyThatField() throws {
        let message = try decode("""
        {"id":"r1","role":"bot","kind":"routine.run","at":1,
         "routineRun":{"runId":"run-1","routineName":"Sweep","status":"failed","scheduledFor":"soon","error":"Timed out"}}
        """)
        let card = try XCTUnwrap(message.routineRun)
        XCTAssertNil(card.scheduledFor)
        XCTAssertEqual(card.routineId, "")
        XCTAssertEqual(card.error, "Timed out")
    }

    // MARK: - Wording

    func testStateMirrorsTheComputersWording() {
        func state(_ status: String, goal: String? = nil, deferred: Double? = nil) -> String {
            RoutineRunCard(runId: "r", routineId: "t", routineName: "N", status: status,
                           deferredAt: deferred, goalStatus: goal).stateText
        }
        XCTAssertEqual(state("completed"), "completed")
        XCTAssertEqual(state("failed"), "failed")
        XCTAssertEqual(state("waiting"), "needs your attention")
        XCTAssertEqual(state("cancelled"), "was cancelled")
        XCTAssertEqual(state("missed"), "was missed")
        XCTAssertEqual(state("queued"), "queued")
        XCTAssertEqual(state("queued", deferred: 5), "deferred: target busy")
        XCTAssertEqual(state("running"), "running")
        // A room goal's outcome is the more exact fact.
        XCTAssertEqual(state("completed", goal: "needs-input"), "needs your input")
        XCTAssertEqual(state("completed", goal: "blocked"), "was blocked")
        XCTAssertEqual(state("completed", goal: "limit-reached"), "reached its limit")
        XCTAssertEqual(state("completed", goal: "stopped"), "was stopped")
        XCTAssertEqual(state("running", goal: "paused"), "running")
    }

    // MARK: - Previews

    func testPreviewCarriesTheFirstLineOfTheReport() throws {
        let message = try decode("""
        {"id":"r1","role":"bot","kind":"routine.run","at":1,"text":"Routine “Inbox sweep” completed",
         "routineRun":{"runId":"run-1","routineId":"rt-1","routineName":"Inbox sweep","status":"completed",
          "summary":"\\n  Three replies drafted.\\nOne needs you."}}
        """)
        XCTAssertEqual(previewText(of: message), "Routine “Inbox sweep” completed: Three replies drafted.")
        XCTAssertEqual(rosterPreview([message], detail: .hidden), "Routine “Inbox sweep” completed: Three replies drafted.")
        XCTAssertEqual(
            Walkie.settledReply(transcript: [message], baseline: [], busy: false),
            "Routine “Inbox sweep” completed: Three replies drafted."
        )
    }

    func testPreviewWithoutAReportIsTheHeadline() {
        var message = Message(id: "r1", role: .bot, kind: .routineRun, at: 1)
        message.routineRun = RoutineRunCard(runId: "r", routineId: "t", routineName: "Sweep", status: "missed")
        XCTAssertEqual(previewText(of: message), "Routine “Sweep” was missed")
    }

    // MARK: - Opening the run

    func testTheRunThreadResolvesWithoutJoiningTheThreadList() throws {
        var state = CompanionState()
        var bot = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"scout","threadId":"main","name":"Scout","title":"","description":"","notifications":true,
         "color":"green","unread":false,"modelSelection":{"instanceId":"e","model":"m"},"createdAt":1,
         "tasks":[{"threadId":"main","title":"Main","createdAt":1},
                  {"threadId":"exec-1","title":"Run","createdAt":2,"routineRunId":"run-1"}]}
        """.utf8))
        bot.unread = false
        state.bots = [bot]
        var card = RoutineRunCard(runId: "run-1", routineId: "t", routineName: "Sweep", status: "completed",
                                  executionThreadId: "exec-1")
        let ref = try XCTUnwrap(state.routineExecutionRef(for: card))
        XCTAssertEqual(ref.botId, "scout")
        XCTAssertEqual(ref.threadId, "exec-1")
        XCTAssertFalse(bot.visibleTasks.contains { $0.threadId == "exec-1" })

        card.executionThreadId = "deleted"
        XCTAssertNil(state.routineExecutionRef(for: card))
        card.executionThreadId = nil
        XCTAssertNil(state.routineExecutionRef(for: card))
    }

    // MARK: - Digest summary

    func testADigestSplitsIntoLabelledSectionsWithoutTheReply() {
        let summary = DigestSummary(text:
            "[digest] · tools: memory_update ×2 (1 failed), shell ×3 · files: changed a.ts, b.ts; added c.ts · memory: updated MEMORY.md, created notes/x.md · reply: Done."
        )
        XCTAssertEqual(summary.lines.map(\.label), ["Tools", "Files", "Memory"])
        XCTAssertEqual(summary.lines[0].items, ["memory_update ×2 (1 failed)", "shell ×3"])
        XCTAssertEqual(summary.lines[1].items, ["changed a.ts, b.ts", "added c.ts"])
        XCTAssertEqual(summary.lines[2].items, ["updated MEMORY.md", "created notes/x.md"])
        XCTAssertEqual(summary.toolCalls, 5)
        XCTAssertEqual(summary.chipLabel, "What I did · 5 tool calls")
        XCTAssertFalse(summary.plainText.contains("Done."))
    }

    // Tool names can be raw commands with commas and quotes of their own.
    func testARawCommandToolNameStaysOneEntry() {
        let summary = DigestSummary(text: "[digest] · tools: /bin/bash -lc 'composio search' ×1 · reply: Done.")
        XCTAssertEqual(summary.lines.count, 1)
        XCTAssertEqual(summary.lines[0].items, ["/bin/bash -lc 'composio search' ×1"])
        XCTAssertEqual(summary.chipLabel, "What I did · 1 tool call")

        let commas = DigestSummary(text: "[digest] · tools: echo a, b ×2, shell ×1")
        XCTAssertEqual(commas.lines[0].items, ["echo a, b ×2", "shell ×1"])
    }

    func testUnknownPartsAreKeptAsPlainLines() {
        let summary = DigestSummary(text: "[digest] · tools: shell ×1 · +3 more memory changes · reply: ok")
        XCTAssertEqual(summary.lines.count, 2)
        XCTAssertNil(summary.lines[1].label)
        XCTAssertEqual(summary.lines[1].value, "+3 more memory changes")
    }

    func testATurnThatDidNothingHasNoSummary() {
        XCTAssertTrue(DigestSummary(text: "[digest] · no tool calls · reply: Hi.").isEmpty)
        XCTAssertTrue(DigestSummary(text: "[digest] · no tool activity observed in this turn · files: none changed · reply: Hi.").isEmpty)
        XCTAssertTrue(DigestSummary(text: "[digest] · no tool calls · files: none changed · reply: Choose A · B · tools: examples only").isEmpty)
        XCTAssertEqual(DigestSummary(text: "[digest] · files: changed a.ts · reply: Choose A · B").lines.map(\.value), ["changed a.ts"])
        XCTAssertTrue(DigestSummary(text: "").isEmpty)
        XCTAssertEqual(DigestSummary(text: "[digest] · files: changed a.ts").chipLabel, "What I did")
    }

    // MARK: - Teammate reports

    // A finished teammate's chip carries its report in `tool.output`; the
    // label stays the short "X replied", and so does every preview.
    func testATeammateReplyDecodesItsReportButPreviewsItsName() throws {
        let message = try decode("""
        {"id":"a1","role":"bot","kind":"activity","at":1,
         "tool":{"name":"Engineering lead replied","ok":true,"output":"  Shipped the fix in #212.\\nTests green.  "},
         "roomRequest":{"phase":"result"},
         "threadRef":{"botId":"eng","threadId":"t-eng","title":"Fix retry"}}
        """)
        XCTAssertEqual(message.tool?.output, "  Shipped the fix in #212.\nTests green.  ")
        XCTAssertEqual(message.tool?.expandableOutput, "Shipped the fix in #212.\nTests green.")
        XCTAssertTrue(message.isTeammateReport)
        XCTAssertEqual(previewText(of: message), "Engineering lead replied")
        XCTAssertEqual(rosterPreview([message], detail: .full), "Engineering lead replied")
    }

    func testAToolWithoutOutputOrWithoutATeammateIsNotAReport() throws {
        let bare = try decode("""
        {"id":"a1","role":"bot","kind":"activity","at":1,"tool":{"name":"Scout replied","ok":true},
         "comm":{"groupId":"g","withBotId":"s","withName":"Scout","withColor":"blue"}}
        """)
        XCTAssertNil(bare.tool?.output)
        XCTAssertNil(bare.tool?.expandableOutput)
        XCTAssertFalse(bare.isTeammateReport)

        let blank = try decode("""
        {"id":"a2","role":"bot","kind":"activity","at":1,"tool":{"name":"shell","ok":true,"output":"  \\n "}}
        """)
        XCTAssertNil(blank.tool?.expandableOutput)

        let log = try decode("""
        {"id":"a3","role":"bot","kind":"activity","at":1,"tool":{"name":"shell","ok":true,"output":"ok"}}
        """)
        XCTAssertEqual(log.tool?.expandableOutput, "ok")
        XCTAssertFalse(log.isTeammateReport, "a tool log is not someone's report")
    }
}
