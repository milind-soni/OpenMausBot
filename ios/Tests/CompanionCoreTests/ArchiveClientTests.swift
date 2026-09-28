import Foundation
import XCTest
@testable import CompanionCore

private final class ArchiveRequestStub: URLProtocol {
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

final class ArchiveClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ArchiveRequestStub.capturedRequest = nil
        ArchiveRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ArchiveRequestStub.self]
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

    func testArchivePatchesTheTaskRouteWithATimestampAndUnarchiveWithNull() async throws {
        try await client.archiveTask(botId: "bot-1", threadId: "thread-9", archivedAt: 1_728_600_000_123)
        var request = try XCTUnwrap(ArchiveRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/tasks/thread-9")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        var body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(ArchiveRequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["archivedAt"] as? Double, 1_728_600_000_123)

        ArchiveRequestStub.capturedRequest = nil
        ArchiveRequestStub.capturedBody = nil
        try await client.archiveTask(botId: "bot-1", threadId: "thread-9", archivedAt: nil)
        request = try XCTUnwrap(ArchiveRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(ArchiveRequestStub.capturedBody)) as? [String: Any])
        XCTAssertTrue(body["archivedAt"] is NSNull, "Unarchiving must send JSON null, not omit the key.")
    }
}
