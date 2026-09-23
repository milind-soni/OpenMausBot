import XCTest
@testable import CompanionCore

final class BotThreadSelectionTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        suite = "BotThreadSelectionTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    private var bot: Bot {
        Bot(id: "bot", threadId: "default", name: "Scout", title: "Researcher",
            description: "", notifications: true, color: "green", unread: false,
            modelSelection: ModelSelection(instanceId: "engine", model: "default"), createdAt: 1,
            tasks: [BotTask(threadId: "default", title: "Default", createdAt: 1),
                    BotTask(threadId: "chosen", title: "Chosen", createdAt: 1)])
    }

    func testSelectionSurvivesNewStoreAndStaysLocalToComputerAndBot() throws {
        let store = BotThreadSelection(defaults: defaults)
        let selected = try XCTUnwrap(bot.projected(forThread: "chosen"))
        store.rememberThread(.bot(selected), connectionID: "computer-one")
        let restored = BotThreadSelection(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(restored.restoringThread(.bot(bot), connectionID: "computer-one").threadId, "chosen")
        XCTAssertEqual(restored.restoringThread(.bot(bot), connectionID: "computer-two").threadId, "default")
        XCTAssertEqual(restored.restoringThread(.bot(bot), connectionID: nil).threadId, "default")
        var other = bot
        other.id = "other"
        XCTAssertEqual(restored.restoringThread(.bot(other), connectionID: "computer-one").threadId, "default")
        XCTAssertEqual(bot.threadId, "default")
    }

    func testDeletedSelectionFallsBackToAvailableDefault() throws {
        let store = BotThreadSelection(defaults: defaults)
        store.rememberThread(.bot(try XCTUnwrap(bot.projected(forThread: "chosen"))), connectionID: "computer")
        var live = bot
        live.tasks = [BotTask(threadId: "default", title: "Default", createdAt: 1)]
        XCTAssertEqual(store.restoringThread(.bot(live), connectionID: "computer").threadId, "default")
    }

    func testRoomSelectionRemainsShared() throws {
        let room = try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"bot","threadId":"room-thread","name":"Ops","memberIds":["bot"],
         "defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1}
        """.utf8))
        let store = BotThreadSelection(defaults: defaults)
        store.rememberThread(.bot(try XCTUnwrap(bot.projected(forThread: "chosen"))), connectionID: "computer")
        store.rememberThread(.room(room), connectionID: "computer")
        XCTAssertEqual(store.restoringThread(.room(room), connectionID: "computer").threadId, "room-thread")
        XCTAssertEqual(store.restoringThread(.bot(bot), connectionID: "computer").threadId, "chosen")
    }
}
