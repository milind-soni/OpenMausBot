import Foundation
import XCTest
@testable import CompanionCore

private final class BotModelRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class BotModelClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        BotModelRequestStub.capturedRequest = nil
        BotModelRequestStub.capturedBody = nil
        BotModelRequestStub.responseBody = Self.botResponse(effort: "high")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BotModelRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testUpdatesModelAndReasoningThroughTheNarrowRoute() async throws {
        let updated = try await client.updateModel(
            botId: "bot-1",
            selection: ModelSelection(instanceId: "codex", model: "gpt-5", effort: "high")
        )

        let request = try XCTUnwrap(BotModelRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/model")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        let data = try XCTUnwrap(BotModelRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(body, ["instanceId": "codex", "model": "gpt-5", "effort": "high"])
        XCTAssertEqual(updated.modelSelection.effort, "high")
    }

    func testEngineDefaultOmitsEffortRatherThanSendingNull() async throws {
        BotModelRequestStub.responseBody = Self.botResponse(effort: nil)

        let updated = try await client.updateModel(
            botId: "bot-1",
            selection: ModelSelection(instanceId: "codex", model: "gpt-5")
        )

        let data = try XCTUnwrap(BotModelRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(body, ["instanceId": "codex", "model": "gpt-5"])
        XCTAssertNil(updated.modelSelection.effort)
    }

    func testThreadModelWriteStaysPinnedWhenTheServerSelectsAnotherThread() async throws {
        BotModelRequestStub.responseBody = Data(#"""
        {"bot":{
          "id":"bot-1","threadId":"thread-b","name":"Scout","title":"Researcher",
          "description":"Finds evidence.","notifications":true,"color":"blue","unread":true,
          "modelSelection":{"instanceId":"codex","model":"profile-default"},"createdAt":1,
          "projects":[{"id":"project-1","name":"Website"}],
          "tasks":[
            {"threadId":"thread-a","title":"A","createdAt":1,"projectId":"project-1",
             "modelSelection":{"instanceId":"codex","model":"gpt-5","effort":"high"},"busy":false},
            {"threadId":"thread-b","title":"B","createdAt":2,"busy":true}
          ]
        }}
        """#.utf8)
        let updated = try await client.updateModel(
            botId: "bot-1",
            selection: ModelSelection(instanceId: "codex", model: "gpt-5", effort: "high"),
            threadId: "thread-a"
        )
        XCTAssertEqual(BotModelRequestStub.capturedRequest?.url?.path, "/api/bots/bot-1/tasks/thread-a")
        let data = try XCTUnwrap(BotModelRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["requireAvailableModel"] as? Bool, true)
        XCTAssertEqual(body["modelSelection"] as? [String: String], ["instanceId": "codex", "model": "gpt-5", "effort": "high"])
        XCTAssertEqual(updated.threadId, "thread-b", "the response is still the canonical profile")
        XCTAssertEqual(updated.modelSelection.model, "profile-default")
        XCTAssertEqual(updated.projected(forThread: "thread-a")?.currentTaskModelSelection.effort, "high")
        XCTAssertEqual(updated.projected(forThread: "thread-a")?.busy, false)
        XCTAssertEqual(updated.tasks?.first?.projectId, "project-1")
    }

    func testThreadModelWriteRejectsUnsafeThreadBeforeNetworking() async throws {
        do {
            _ = try await client.updateModel(botId: "bot-1", selection: ModelSelection(instanceId: "codex", model: "gpt-5"), threadId: "../other")
            XCTFail("expected unsafe route rejection")
        } catch APIError.badURL {
            XCTAssertNil(BotModelRequestStub.capturedRequest)
        }
    }

    func testRejectsUnsafeBotIDsBeforeNetworking() async throws {
        do {
            _ = try await client.updateModel(
                botId: "../another-bot",
                selection: ModelSelection(instanceId: "codex", model: "gpt-5")
            )
            XCTFail("expected unsafe route rejection")
        } catch APIError.badURL {
            XCTAssertNil(BotModelRequestStub.capturedRequest)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testDecodesOptionalEffortAndInstanceEffortLevels() throws {
        let data = Data(#"""
        {"instances":[{
          "instanceId":"codex","driverKind":"codexAgent","displayName":"Codex",
          "snapshot":{"state":"available"},
          "models":{"default":"gpt-5","options":[{"id":"gpt-5","label":"GPT-5"}]},
          "capabilities":{"effortLevels":["low","medium","high"]}
        }]}
        """#.utf8)

        let instance = try XCTUnwrap(JSONDecoder().decode(InstanceList.self, from: data).instances.first)
        XCTAssertEqual(instance.capabilities?.effortLevels, ["low", "medium", "high"])

        let old = try JSONDecoder().decode(
            ModelSelection.self,
            from: Data(#"{"instanceId":"claude","model":"sonnet"}"#.utf8)
        )
        XCTAssertNil(old.effort)
    }

    private static func botResponse(effort: String?) -> Data {
        let effortField = effort.map { ",\"effort\":\"\($0)\"" } ?? ""
        return Data("""
        {"bot":{
          "id":"bot-1","threadId":"thread-1","name":"Scout","title":"Researcher",
          "description":"Finds evidence.","notifications":true,"color":"blue","unread":false,
          "modelSelection":{"instanceId":"codex","model":"gpt-5"\(effortField)},"createdAt":1
        }}
        """.utf8)
    }
}
