import Foundation
import XCTest
@testable import CompanionCore

private final class SnoozeRequestStub: URLProtocol {
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
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
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

final class SnoozeClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        SnoozeRequestStub.capturedRequest = nil
        SnoozeRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SnoozeRequestStub.self]
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

    func testSnoozePresetsTravelAsNumbersOnTheThreadPatch() async throws {
        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: 0)
        XCTAssertEqual(try Self.body()["snoozedUntil"] as? Double, 0, "0 is the until-activity sentinel, a real value")

        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: 1_760_000_000_000)
        XCTAssertEqual(try Self.body()["snoozedUntil"] as? Double, 1_760_000_000_000)

        let request = try XCTUnwrap(SnoozeRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/scout/tasks/thread-1")
    }

    func testWakingTravelsAsNullNotAnOmittedField() async throws {
        try await client.snoozeTask(botId: "scout", threadId: "thread-1", snoozedUntil: nil)

        // The server treats an omitted field as "leave it alone"; only JSON
        // null means "stop snoozing", so the key must be present.
        let body = try XCTUnwrap(Self.body())
        XCTAssertEqual(body.keys.sorted(), ["snoozedUntil"])
        XCTAssertTrue(body["snoozedUntil"] is NSNull)
    }

    private static func body() throws -> [String: Any] {
        let data = try XCTUnwrap(SnoozeRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
