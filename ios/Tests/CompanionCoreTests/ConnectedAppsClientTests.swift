import Foundation
import XCTest
@testable import CompanionCore

private final class ConnectorRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

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

final class ConnectedAppsClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ConnectorRequestStub.responseBody = Data()
        ConnectorRequestStub.statusCode = 200
        ConnectorRequestStub.capturedRequest = nil
        ConnectorRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ConnectorRequestStub.self]
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

    func testLoadsCompleteAccountInventoryRatherThanInferringItFromTheCatalog() async throws {
        ConnectorRequestStub.responseBody = Data(#"{"configured":true,"services":{"slack":{"connected":true,"accounts":[{"id":"ca_work","alias":"Work","status":"ACTIVE"},{"id":"ca_client","alias":"Client","status":"ACTIVE"}]}}}"#.utf8)

        let statuses = try await client.allConnectorStatuses()

        XCTAssertEqual(ConnectorRequestStub.capturedRequest?.url?.path, "/api/connectors/connected")
        XCTAssertEqual(statuses.services["slack"]?.accounts?.map(\.alias), ["Work", "Client"])
        XCTAssertEqual(
            ConnectorRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
    }

    func testAuthorizesAnotherAccountWithAnExplicitAlias() async throws {
        ConnectorRequestStub.responseBody = Data(#"{"url":"https://auth.example/connect"}"#.utf8)

        let url = try await client.authorizeConnector(slug: "google-calendar", alias: "  Personal  ")

        XCTAssertEqual(url.absoluteString, "https://auth.example/connect")
        XCTAssertEqual(ConnectorRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(ConnectorRequestStub.capturedRequest?.url?.path, "/api/connectors/google-calendar/authorize")
        let body = try XCTUnwrap(ConnectorRequestStub.capturedBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object, ["alias": "Personal"])
    }

    func testOmitsAWhitespaceOnlyAlias() async throws {
        ConnectorRequestStub.responseBody = Data(#"{"url":"https://auth.example/connect"}"#.utf8)

        _ = try await client.authorizeConnector(slug: "gmail", alias: "   \n  ")

        XCTAssertNil(ConnectorRequestStub.capturedBody)
    }

    func testRejectsUnsafeToolkitComponentsAndAuthorizationURLsLocally() async {
        await assertBadURL { _ = try await self.client.authorizeConnector(slug: "café", alias: nil) }
        await assertBadURL { _ = try await self.client.authorizeConnector(slug: "bad/slash", alias: nil) }
        XCTAssertNil(ConnectorRequestStub.capturedRequest)

        ConnectorRequestStub.responseBody = Data(#"{"url":"http://auth.example/connect"}"#.utf8)
        await assertBadURL { _ = try await self.client.authorizeConnector(slug: "gmail", alias: nil) }
    }

    private func assertBadURL(
        _ operation: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await operation()
            XCTFail("expected badURL", file: file, line: line)
        } catch APIError.badURL {
            // Expected: reject before sending paired credentials or opening it.
        } catch {
            XCTFail("unexpected error: \(error)", file: file, line: line)
        }
    }
}
