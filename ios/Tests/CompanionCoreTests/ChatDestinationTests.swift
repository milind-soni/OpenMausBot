// The one place a Chat becomes a MessageDestination: the mapping is the
// contract, so it is tested beside the wire types it produces.
import XCTest
@testable import CompanionCore

final class ChatDestinationTests: XCTestCase {
    private func bot(_ id: String, threadId: String) throws -> Bot {
        try JSONDecoder().decode(Bot.self, from: Data("""
        {"id":"\(id)","threadId":"\(threadId)","name":"Scout","title":"Researcher",
         "description":"","notifications":true,"color":"green","unread":false,
         "modelSelection":{"instanceId":"engine","model":"default"},"createdAt":1}
        """.utf8))
    }

    private func room(_ id: String, threadId: String) throws -> Room {
        try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"\(id)","threadId":"\(threadId)","name":"Ops","memberIds":["bot"],
         "defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1}
        """.utf8))
    }

    func testBotChatAddressesItsCurrentlySelectedThread() throws {
        let chat = Chat.bot(try bot("b1", threadId: "task-7"))
        XCTAssertEqual(chat.destination, .bot(id: "b1", threadId: "task-7"))
    }

    func testRoomChatAddressesTheSharedThread() throws {
        let chat = Chat.room(try room("ops", threadId: "ops-thread"))
        XCTAssertEqual(chat.destination, .room(id: "ops", threadId: "ops-thread"))
    }

    func testIdsPropagateDistinctlyAndCasesNeverCross() throws {
        let botChat = Chat.bot(try bot("same", threadId: "t-bot"))
        let roomChat = Chat.room(try room("same", threadId: "t-room"))
        XCTAssertEqual(botChat.destination, .bot(id: "same", threadId: "t-bot"))
        XCTAssertEqual(roomChat.destination, .room(id: "same", threadId: "t-room"))
        XCTAssertNotEqual(botChat.destination, roomChat.destination,
                          "an id shared by a bot and a room must not blur the route")
        guard case let .bot(id, threadId) = botChat.destination else {
            return XCTFail("expected a bot destination")
        }
        XCTAssertEqual(id, "same")
        XCTAssertEqual(threadId, "t-bot")
        guard case let .room(roomId, roomThreadId) = roomChat.destination else {
            return XCTFail("expected a room destination")
        }
        XCTAssertEqual(roomId, "same")
        XCTAssertEqual(roomThreadId, "t-room")
    }

    func testMovingTheEnumKeepsIdentityAndThreadProjection() throws {
        // The enum moved from the app target into the package; lock the
        // behaviors the app relied on so the move cannot drift silently.
        let botChat = Chat.bot(try bot("b1", threadId: "t1"))
        XCTAssertEqual(botChat.id, "b1")
        XCTAssertEqual(botChat.conversationID, "bot:b1:t1")
        XCTAssertEqual(botChat.threadId, "t1")
        XCTAssertEqual(Chat.bot(try bot("b1", threadId: "t1")),
                       Chat.bot(try bot("b1", threadId: "t1")))
        XCTAssertNotEqual(Chat.bot(try bot("b1", threadId: "t1")),
                          Chat.bot(try bot("b1", threadId: "t2")))
        let roomChat = Chat.room(try room("ops", threadId: "t1"))
        XCTAssertEqual(roomChat.conversationID, "room:ops:t1")
        XCTAssertEqual(Set([botChat, Chat.bot(try bot("b2", threadId: "t2"))]).count, 2)
    }
}

