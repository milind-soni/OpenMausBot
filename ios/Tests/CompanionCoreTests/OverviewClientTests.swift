import Foundation
import XCTest
@testable import CompanionCore

private final class OverviewRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
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
}

final class OverviewClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        OverviewRequestStub.responseBody = Data()
        OverviewRequestStub.statusCode = 200
        OverviewRequestStub.capturedRequest = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OverviewRequestStub.self]
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

    func testFetchesABotOverview() async throws {
        OverviewRequestStub.responseBody = Data(#"""
        {
          "who": {"name": "Kiwi", "title": "Tracker", "blurb": "Files bugs.", "soulLead": "File bugs."},
          "does": ["Every 5 minutes: Triage Discord."],
          "reaches": ["Picks a computer automatically."],
          "wont": ["Won't run commands without asking you first."],
          "recent": [{"at": 1788603055630, "summary": "soul: 0 → 29 bytes"}]
        }
        """#.utf8)

        let overview = try await client.overview(botId: "bot-1")

        XCTAssertEqual(OverviewRequestStub.capturedRequest?.url?.path, "/api/bots/bot-1/overview")
        XCTAssertEqual(OverviewRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(
            OverviewRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        XCTAssertEqual(overview.who.name, "Kiwi")
    }

    func testRejectsAnUnsafeBotID() async {
        do {
            _ = try await client.overview(botId: "bad/slash")
            XCTFail("expected badURL")
        } catch APIError.badURL {
            // Expected: reject before sending a request with an unsafe path.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertNil(OverviewRequestStub.capturedRequest)
    }
}
