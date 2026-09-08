import Foundation
import XCTest
@testable import CompanionCore

private final class ActivityRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = request.httpBody ?? Self.readBody(from: request)
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
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// The activity log and team memory calls: the paths and queries the sidecar
/// allowlist expects, and the bodies the harness routes parse.
final class ActivityClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ActivityRequestStub.responseBody = Data()
        ActivityRequestStub.statusCode = 200
        ActivityRequestStub.capturedRequest = nil
        ActivityRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ActivityRequestStub.self]
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

    private func body() throws -> [String: Any] {
        let data = try XCTUnwrap(ActivityRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testReadsTheActivityLogWithALimit() async throws {
        ActivityRequestStub.responseBody = Data(#"{"rows":[{"at":"2026-09-07T09:00:00.000Z","threadId":"t1","tool":"GMAIL_SEND_EMAIL","app":"Gmail","label":"Send email","summary":"to finance@","outcome":"waiting"}]}"#.utf8)

        let rows = try await client.activity(botId: "bot_1", limit: 50)

        let url = try XCTUnwrap(ActivityRequestStub.capturedRequest?.url)
        XCTAssertEqual(url.path, "/api/bots/bot_1/activity")
        XCTAssertEqual(url.query, "limit=50")
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].app, "Gmail")
        XCTAssertEqual(rows[0].outcome, "waiting")
    }

    func testRefusesABotIdThatIsNotARouteId() async {
        do {
            _ = try await client.activity(botId: "../secrets")
            XCTFail("a path-shaped id must never reach the wire")
        } catch {
            XCTAssertNil(ActivityRequestStub.capturedRequest)
        }
    }

    func testReadsTeamMemoryForTheGeneralSection() async throws {
        ActivityRequestStub.responseBody = Data(#"{"section":"","label":"General","entries":[]}"#.utf8)

        let page = try await client.teamMemory(section: "")

        let url = try XCTUnwrap(ActivityRequestStub.capturedRequest?.url)
        XCTAssertEqual(url.path, "/api/team-memory")
        // the harness requires the parameter even when it is empty
        XCTAssertEqual(url.query, "section=")
        XCTAssertEqual(page.label, "General")
    }

    func testRemembersAProposalWithAnAcceptPatch() async throws {
        ActivityRequestStub.responseBody = Data(#"{"entries":[]}"#.utf8)

        _ = try await client.answerTeamMemory(section: "Work", id: "entry_1", remember: true)

        let request = try XCTUnwrap(ActivityRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/team-memory/entry_1")
        XCTAssertEqual(request.url?.query, "section=Work")
        XCTAssertEqual(try body()["accept"] as? Bool, true)
    }

    func testSkipsAProposalWithADelete() async throws {
        ActivityRequestStub.responseBody = Data(#"{"entries":[]}"#.utf8)

        _ = try await client.answerTeamMemory(section: "", id: "entry_1", remember: false)

        let request = try XCTUnwrap(ActivityRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/team-memory/entry_1")
    }

    func testAddsAnEntryByHand() async throws {
        ActivityRequestStub.responseBody = Data(#"{"entries":[{"id":"e1","kind":"term","name":"MCHQ","detail":"MissionControlHQ","aliases":[],"status":"accepted","source":{"botId":"","botName":"you","threadId":"","at":1},"updatedAt":1}]}"#.utf8)

        let entries = try await client.addTeamMemory(section: "", kind: "term", name: "MCHQ", detail: "MissionControlHQ")

        let request = try XCTUnwrap(ActivityRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/team-memory")
        XCTAssertEqual(try body()["kind"] as? String, "term")
        XCTAssertEqual(entries.first?.name, "MCHQ")
    }
}
