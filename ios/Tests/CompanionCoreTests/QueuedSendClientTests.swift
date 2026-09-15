// The cancel route, exactly as the harness speaks it: DELETE with the
// threadId pinned in the body, a drained 404 read positively on the
// harness's own wording, and any other 404 kept as a real error.
import XCTest
@testable import CompanionCore

private final class QueuedCancelStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?
    static var statusCode = 200
    static var responseBody = Data("{\"ok\":true}".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
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

final class QueuedSendClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        QueuedCancelStub.capturedRequest = nil
        QueuedCancelStub.capturedBody = nil
        QueuedCancelStub.statusCode = 200
        QueuedCancelStub.responseBody = Data("{\"ok\":true}".utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QueuedCancelStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Test", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testCancelDeletesTheBotQueueEntryWithTheThreadPinned() async throws {
        try await client.cancelQueued(queueId: "q1", to: .bot(id: "bot-1", threadId: "thread-9"))

        let request = try XCTUnwrap(QueuedCancelStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/queue/q1")
        let body = try XCTUnwrap(QueuedCancelStub.capturedBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["threadId"], "thread-9")
    }

    func testCancelDeletesTheRoomQueueEntryWithoutABody() async throws {
        try await client.cancelQueued(queueId: "q1", to: .room(id: "room-1", threadId: "thread-9"))

        let request = try XCTUnwrap(QueuedCancelStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/groups/room-1/queue/q1")
    }

    func testADrainedEntryIsTheOutcomeTheCallerWanted() async {
        QueuedCancelStub.statusCode = 404
        QueuedCancelStub.responseBody = Data("{\"error\":\"no such queued message\"}".utf8)

        do {
            try await client.cancelQueued(queueId: "q1", to: .bot(id: "bot-1", threadId: "thread-9"))
        } catch {
            XCTFail("a drained entry is success, not an error: \(error)")
        }
    }

    func testAnUnknown404IsARealErrorWithAdvice() async {
        QueuedCancelStub.statusCode = 404
        QueuedCancelStub.responseBody = Data("{\"error\":\"no route\"}".utf8)

        do {
            try await client.cancelQueued(queueId: "q1", to: .bot(id: "bot-1", threadId: "thread-9"))
            XCTFail("a 404 that is not the drained wording must not be swallowed")
        } catch let error as APIError {
            XCTAssertEqual(
                error.errorDescription,
                "This computer is too old to take back a queued message. Update OpenMausBot on it."
            )
        } catch {
            XCTFail("expected an APIError, got \(error)")
        }
    }

    func testSendReturnsTheQueuedReceipt() async throws {
        QueuedCancelStub.responseBody = Data("""
        {"ok":true,"queued":true,"queueId":"q1","threadId":"thread-9","reason":"capacity"}
        """.utf8)

        let receipt = try await client.send(text: "hello", toBot: "bot-1", threadId: "thread-9")
        XCTAssertEqual(receipt.queued, true)
        XCTAssertEqual(receipt.queueId, "q1")
        XCTAssertEqual(receipt.threadId, "thread-9")
        XCTAssertEqual(receipt.reason, "capacity")

        let request = try XCTUnwrap(QueuedCancelStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/messages")
    }
}
