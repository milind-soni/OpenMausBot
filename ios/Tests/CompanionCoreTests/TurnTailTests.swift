// When the transcript ends with the typing bubble. The expectations are the
// desktop's (`src/lib/turn-tail.ts` and its call sites in ChatView.tsx and
// GroupView.tsx), plus the cards and streams the phone draws itself.
import XCTest
@testable import CompanionCore

final class TurnTailTests: XCTestCase {
    private func messages(_ json: String) throws -> [Message] {
        try JSONDecoder().decode([Message].self, from: Data(json.utf8))
    }

    private func bot(busy: Bool, activity: String? = nil) throws -> Chat {
        let activityField = activity.map { #","activity":"\#($0)""# } ?? ""
        return .bot(try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"scout","threadId":"t1","name":"Scout","title":"Researcher",
         "description":"","notifications":true,"color":"green","unread":false,
         "modelSelection":{"instanceId":"engine","model":"default"},"createdAt":1,
         "busy":\(busy)\(activityField)}
        """.utf8)))
    }

    private func room(speaker: String?) throws -> Chat {
        let speakerField = speaker.map { #","busyBotId":"\#($0)""# } ?? ""
        return .room(try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"ops","threadId":"ops-thread","name":"Ops","memberIds":["a","b"],
         "defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1\(speakerField)}
        """.utf8)))
    }

    private let asked = #"{"id":"ask","role":"user","kind":"text","at":1000,"text":"Check the build"}"#
    private let answered = #"{"id":"reply","role":"bot","kind":"text","at":2000,"text":"It passes."}"#

    func testAfterASendTheBusyBotShowsTyping() throws {
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: messages("[\(asked)]")))
        // An empty thread that is already working, too: the first message is
        // still on its way.
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: []))
    }

    func testAnIdleBotNeverShowsTyping() throws {
        // A queued send while nothing runs: the message waits, nobody types.
        XCTAssertFalse(try bot(busy: false).showsTyping(messages: messages("[\(asked)]")))
        XCTAssertFalse(try bot(busy: false).showsTyping(messages: messages("[\(asked)]"), streaming: true))
    }

    func testASettledReplyAtTheTailEndsTheTurnBeforeBusyClears() throws {
        // The reply lands a frame before busy flips off; the dots must not
        // pop back under it for that beat.
        XCTAssertFalse(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(answered)]")))
    }

    func testTheTurnsDigestAndLateRowsDoNotBringTheDotsBack() throws {
        let transcript = try messages("""
        [\(asked),
         {"id":"final","role":"bot","kind":"text","at":2000,"text":"Done.","turnId":"t","turnTerminal":true},
         {"id":"digest","role":"bot","kind":"digest","at":2100,"text":"[digest] · tools: shell ×1","turnId":"t"},
         {"id":"shot","role":"bot","kind":"screen","at":2200,"turnId":"t"}]
        """)
        XCTAssertFalse(try bot(busy: true).showsTyping(messages: Array(transcript.prefix(3))))
        XCTAssertFalse(try bot(busy: true).showsTyping(messages: transcript))
    }

    func testANewStepAfterAReplyShowsTypingAgain() throws {
        let transcript = try messages("""
        [\(asked),
         {"id":"note","role":"bot","kind":"text","at":2000,"text":"Let me look.","turnId":"t"},
         {"id":"step","role":"bot","kind":"activity","at":2100,"turnId":"t","tool":{"name":"Read build.log"}}]
        """)
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: transcript))
        // A wake-up turn after a finished one has a turn of its own.
        let wake = try messages("""
        [{"id":"final","role":"bot","kind":"text","at":2000,"text":"Done.","turnId":"t","turnTerminal":true},
         {"id":"later","role":"bot","kind":"activity","at":3000,"turnId":"u","tool":{"name":"Read inbox"}}]
        """)
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: wake))
    }

    func testAStreamIsAlwaysANewStep() throws {
        // Reasoning for the next step can start while the last reply is the
        // tail; the store clears streams on the frame that settles a reply.
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(answered)]"), streaming: true))
    }

    func testHiddenNarrationDoesNotCountAsTheTail() throws {
        // At Hidden the bot's in-between words are the status line, not rows;
        // the last row on screen is the person's message, and the dots say
        // the bot is still working on it.
        let transcript = try messages("""
        [\(asked),
         {"id":"note","role":"bot","kind":"text","at":2000,"text":"Let me look.","turnId":"t"}]
        """)
        XCTAssertFalse(try bot(busy: true).showsTyping(messages: transcript))
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: transcript, hiddenIds: ["note"]))
    }

    func testASteerSentMidTurnPinsTheDotsUnderIt() throws {
        let transcript = try messages("""
        [\(asked),\(answered),
         {"id":"steer","role":"user","kind":"text","at":3000,"text":"Also the tests","steered":true}]
        """)
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: transcript))
    }

    func testWaitingOnThePersonShowsNoDots() throws {
        XCTAssertFalse(try bot(busy: true, activity: "waiting-on-you").showsTyping(messages: messages("[\(asked)]")))
        XCTAssertTrue(try bot(busy: true, activity: "working").showsTyping(messages: messages("[\(asked)]")))
        XCTAssertTrue(try bot(busy: true, activity: "no-signal").showsTyping(messages: messages("[\(asked)]")))
    }

    func testAnOpenApprovalOrQuestionShowsNoDots() throws {
        let approval = #"{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Run ls?","subtitle":"","options":["Allow","Deny"],"requestId":"r1","tool":"Bash"}}"#
        let question = #"{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Which branch?","subtitle":"","options":["main","dev"],"requestId":"r2"}}"#
        for card in [approval, question] {
            XCTAssertFalse(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(card)]")))
            // Even with a stream open: the card is what the bot waits on.
            XCTAssertFalse(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(card)]"), streaming: true))
        }
        // Answered, the turn goes on and so do the dots.
        let settled = #"{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Run ls?","subtitle":"","options":["Allow","Deny"],"requestId":"r1","tool":"Bash","answered":"allow"}}"#
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(settled)]")))
    }

    func testAnOpenCredentialRequestInThisTurnShowsNoDots() throws {
        let request = #"{"id":"key","role":"bot","kind":"secret","at":2000,"secret":{"target":"openai","label":"OpenAI key"}}"#
        XCTAssertFalse(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(request)]")))
        let provided = #"{"id":"key","role":"bot","kind":"secret","at":2000,"secret":{"target":"openai","label":"OpenAI key","provided":true}}"#
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(provided)]")))
        // One the person ignored turns ago does not hold the dots off forever.
        let later = #"{"id":"next","role":"user","kind":"text","at":3000,"text":"Skip that, just summarise"}"#
        XCTAssertTrue(try bot(busy: true).showsTyping(messages: messages("[\(asked),\(request),\(later)]")))
    }

    func testStopOrAFailedTurnClearsTheDots() throws {
        // Stopped or failed, the thread is no longer busy, whatever the tail.
        let failed = #"{"id":"err","role":"bot","kind":"activity","at":2000,"tool":{"name":"error: the run ended","ok":false}}"#
        XCTAssertFalse(try bot(busy: false).showsTyping(messages: messages("[\(asked),\(failed)]")))
        XCTAssertFalse(try bot(busy: false).showsTyping(messages: messages("[\(asked)]")))
    }

    func testAnotherThreadBusyLeavesThisOneQuiet() throws {
        let profile = try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"scout","threadId":"t1","name":"Scout","title":"","description":"","notifications":true,
         "color":"green","unread":false,"modelSelection":{"instanceId":"e","model":"m"},"createdAt":1,
         "busy":true,"activity":"working",
         "tasks":[{"threadId":"t1","title":"Busy","createdAt":1,"busy":true,"activity":"working"},
                  {"threadId":"t2","title":"Quiet","createdAt":2,"busy":false,"activity":"idle"}]}
        """.utf8))
        let quiet = try XCTUnwrap(profile.projected(forThread: "t2"))
        XCTAssertFalse(Chat.bot(quiet).showsTyping(messages: try messages("[\(asked)]")))
        let working = try XCTUnwrap(profile.projected(forThread: "t1"))
        XCTAssertTrue(Chat.bot(working).showsTyping(messages: try messages("[\(asked)]")))
    }

    func testRoomsShowTypingForANewSpeakerAfterAnotherMembersReply() throws {
        let fromA = #"{"id":"a1","role":"bot","kind":"text","at":2000,"text":"Done on my side.","from":{"botId":"a","name":"Ada","color":"blue"}}"#
        let transcript = try messages("[\(asked),\(fromA)]")
        // Ada's reply settles Ada's turn…
        XCTAssertFalse(try room(speaker: "a").showsTyping(messages: transcript))
        // …but not Bo's, who has the floor now.
        XCTAssertTrue(try room(speaker: "b").showsTyping(messages: transcript))
        // Nobody has the floor: nobody is typing.
        XCTAssertFalse(try room(speaker: nil).showsTyping(messages: try messages("[\(asked)]")))
        XCTAssertTrue(try room(speaker: "a").showsTyping(messages: try messages("[\(asked)]")))
    }
}
