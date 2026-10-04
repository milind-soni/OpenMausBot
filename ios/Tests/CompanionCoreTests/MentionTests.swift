// The composer's @mention picker, against the desktop's rules
// (`src/components/Composer.tsx`, `src/lib/mentions.ts`): the same words
// open it, the same names fill it, and a pick writes the same text the
// harness routes on.
import XCTest
@testable import CompanionCore

final class MentionTests: XCTestCase {
    private let pool = [
        MentionChoice(id: MentionChoice.everyoneID, name: "everyone", color: nil),
        MentionChoice(id: "a", name: "Atlas", color: "blue"),
        MentionChoice(id: "s", name: "Six", color: "green"),
        MentionChoice(id: "n", name: "New Bot", color: "pink"),
    ]

    func testAnAtThatStartsAWordOpensAQuery() {
        XCTAssertEqual(ComposerMention.query(in: "@"), "")
        XCTAssertEqual(ComposerMention.query(in: "hey @at"), "at")
        XCTAssertEqual(ComposerMention.query(in: "line one\n@Six"), "Six")
        XCTAssertEqual(ComposerMention.query(in: "@New Bot"), "New Bot")
    }

    func testAnAtInsideAWordOrAFinishedTagDoesNot() {
        XCTAssertNil(ComposerMention.query(in: "hello"))
        XCTAssertNil(ComposerMention.query(in: "mail me at ada@example"), "user@host is not a tag")
        XCTAssertNil(ComposerMention.query(in: "@Atlas look at this\nand that"))
        XCTAssertNil(ComposerMention.query(in: "@" + String(repeating: "x", count: 25)))
    }

    func testChoicesFilterCaseInsensitivelyAndCloseOnACompletedTag() {
        XCTAssertEqual(ComposerMention.choices(from: pool, query: ""), pool)
        XCTAssertEqual(ComposerMention.choices(from: pool, query: "si").map(\.name), ["Six"])
        XCTAssertEqual(ComposerMention.choices(from: pool, query: "BOT").map(\.name), ["New Bot"])
        XCTAssertEqual(ComposerMention.choices(from: pool, query: "Six "), [])
        XCTAssertEqual(ComposerMention.choices(from: pool, query: "zzz"), [])
    }

    func testPickingReplacesTheQueryWithTheTagAndASpace() {
        let atlas = pool[1]
        XCTAssertEqual(ComposerMention.complete("ask @at", with: atlas), "ask @Atlas ")
        XCTAssertEqual(ComposerMention.complete("@", with: pool[3]), "@New Bot ")
        XCTAssertNil(ComposerMention.complete("no tag here", with: atlas))
        // The completed draft no longer offers the same bot again.
        let done = ComposerMention.complete("ask @at", with: atlas)!
        XCTAssertEqual(ComposerMention.choices(for: done, pool: pool), [])
    }

    func testARoomOffersEveryoneAndItsVisibleMembers() throws {
        let room = try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"r","threadId":"rt","name":"Team","memberIds":["b2","b1","gone","b3"],
         "defaultResponder":{"kind":"mentions"},"bulletin":"","unread":false,"createdAt":1}
        """.utf8))
        let bots = [bot("b1", "Atlas"), bot("b2", "Six"), bot("b3", "Ghost", hidden: true), bot("b4", "Outsider")]
        XCTAssertEqual(
            ComposerMention.pool(for: .room(room), bots: bots).map(\.name),
            ["everyone", "Six", "Atlas"],
            "members in room order; hidden, missing and non-members left out"
        )

        var dm = room
        dm.dm = true
        XCTAssertEqual(ComposerMention.pool(for: .room(dm), bots: bots).map(\.name), ["Six", "Atlas"])
    }

    func testABotChatOffersEveryOtherVisibleBot() {
        let bots = [bot("b1", "Atlas"), bot("b2", "Six"), bot("b3", "Ghost", hidden: true)]
        XCTAssertEqual(ComposerMention.pool(for: .bot(bots[0]), bots: bots).map(\.name), ["Six"])
    }

    private func bot(_ id: String, _ name: String, hidden: Bool = false) -> Bot {
        var bot = Bot(
            id: id, threadId: "t-\(id)", name: name, title: "",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1
        )
        bot.hidden = hidden
        return bot
    }
}
