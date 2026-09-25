// The Claude Code update offer: the error chip's `claudeUpdate` flag, and the
// route that runs Claude's updater on the computer for one engine instance.
import XCTest
@testable import CompanionCore

private final class ClaudeUpdateStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?
    static var statusCode = 200
    static var responseBody = Data(#"{"ok":true,"version":"2.1.30 (Claude Code)"}"#.utf8)

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

final class ClaudeUpdateClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ClaudeUpdateStub.capturedRequest = nil
        ClaudeUpdateStub.capturedBody = nil
        ClaudeUpdateStub.statusCode = 200
        ClaudeUpdateStub.responseBody = Data(#"{"ok":true,"version":"2.1.30 (Claude Code)"}"#.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ClaudeUpdateStub.self]
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

    func testDecodesTheClaudeUpdateFlagOnAnErrorChip() throws {
        let json = """
        {"id":"m1","role":"bot","kind":"activity","at":1,
         "tool":{"name":"error: Claude Code is too old for this model","ok":false,"setup":true,"claudeUpdate":true}}
        """
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.kind, .activity)
        XCTAssertEqual(message.tool?.claudeUpdate, true)
        XCTAssertEqual(message.tool?.setup, true)
        XCTAssertEqual(message.tool?.ok, false)
    }

    func testAnErrorChipWithoutTheFlagDecodesAsNoUpdateOffer() throws {
        let json = #"{"id":"m2","role":"bot","kind":"activity","at":1,"tool":{"name":"error: rate limited","ok":false}}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertNil(message.tool?.claudeUpdate)
        let tool = try JSONDecoder().decode(ToolActivity.self, from: Data(#"{"name":"Read","ok":true}"#.utf8))
        XCTAssertNil(tool.claudeUpdate)
    }

    func testUpdatePostsAnEmptyJSONBodyToTheInstanceRouteAndReturnsTheVersion() async throws {
        let version = try await client.updateClaude(instanceId: "claude-code.main_1")

        XCTAssertEqual(version, "2.1.30 (Claude Code)")
        let request = try XCTUnwrap(ClaudeUpdateStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/instances/claude-code.main_1/claude-update")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 180)
        let body = try XCTUnwrap(ClaudeUpdateStub.capturedBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertTrue(object.isEmpty)
    }

    func testTheHarnessRefusalComesThroughAsItsOwnMessage() async {
        ClaudeUpdateStub.statusCode = 409
        ClaudeUpdateStub.responseBody = Data(
            #"{"error":"wait for running Claude tasks to finish before updating"}"#.utf8
        )
        do {
            _ = try await client.updateClaude(instanceId: "claude-code")
            XCTFail("expected the refusal to throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, "wait for running Claude tasks to finish before updating")
        }
    }

    func testRejectsAnInstanceIdThatWouldLeaveItsRouteSegment() async {
        ClaudeUpdateStub.capturedRequest = nil
        for bad in ["", "..", "a/b", "a b", "claude?x=1"] {
            do {
                _ = try await client.updateClaude(instanceId: bad)
                XCTFail("expected \(bad) to be refused")
            } catch APIError.badURL {
            } catch {
                XCTFail("unexpected error for \(bad): \(error)")
            }
        }
        XCTAssertNil(ClaudeUpdateStub.capturedRequest)
    }
}
