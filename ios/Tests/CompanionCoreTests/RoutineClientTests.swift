import Foundation
import XCTest
@testable import CompanionCore

private final class RoutineRequestStub: URLProtocol {
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
        client?.urlProtocol(self, didLoad: Self.response)
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

    private static let response = Data(#"""
    {
      "routine": {
        "id":"routine-1","name":"Pulse","prompt":"Check status","botId":"bot-1",
        "runOn":"astra","enabled":true,
        "schedule":{"type":"interval","everyMinutes":5,"anchorAt":1788384600000},
        "durationMinutes":30,"timeoutMinutes":30,
        "nextRunAt":1788384900000,"createdAt":1,"updatedAt":1
      }
    }
    """#.utf8)
}

final class RoutineClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        RoutineRequestStub.capturedRequest = nil
        RoutineRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RoutineRequestStub.self]
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

    func testCreatesAnIntervalRoutineWithItsAnchorAndSafetyTimeout() async throws {
        let anchor = Date(timeIntervalSince1970: 1_788_384_600)
        let created = try await client.createRoutine(RoutineInput(
            name: "Pulse",
            prompt: "Check status",
            botId: "bot-1",
            schedule: .interval(everyMinutes: 5, anchorAt: anchor),
            durationMinutes: 30,
            timeoutMinutes: 30
        ))

        let request = try XCTUnwrap(RoutineRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/routines")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")

        let data = try XCTUnwrap(RoutineRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let schedule = try XCTUnwrap(body["schedule"] as? [String: Any])
        XCTAssertEqual(schedule["type"] as? String, "interval")
        XCTAssertEqual(schedule["everyMinutes"] as? Int, 5)
        XCTAssertEqual((schedule["anchorAt"] as? NSNumber)?.int64Value, 1_788_384_600_000)
        XCTAssertNil(schedule["at"])
        XCTAssertNil(schedule["time"])
        XCTAssertNil(schedule["weekdays"])
        XCTAssertEqual(body["durationMinutes"] as? Int, 30)
        XCTAssertEqual(body["timeoutMinutes"] as? Int, 30)
        XCTAssertEqual(created.timeoutMinutes, 30)
        XCTAssertEqual(created.schedule.type, .interval)
    }

    func testOmitsAnUnchangedRunLimitFromPatch() async throws {
        let unchangedTimeout: Int? = nil
        _ = try await client.updateRoutine(id: "routine-1", input: RoutineInput(
            name: "Pulse",
            prompt: "Check status",
            botId: "bot-1",
            schedule: .interval(everyMinutes: 15, anchorAt: Date()),
            timeoutMinutes: unchangedTimeout
        ))

        let data = try XCTUnwrap(RoutineRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(body["timeoutMinutes"])
    }

    func testSendsNullToRemoveAnOptionalRunLimit() async throws {
        _ = try await client.updateRoutine(id: "routine-1", input: RoutineInput(
            name: "Pulse",
            prompt: "Check status",
            botId: "bot-1",
            schedule: .interval(everyMinutes: 15, anchorAt: Date()),
            clearTimeout: true
        ))

        let data = try XCTUnwrap(RoutineRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(body["timeoutMinutes"] is NSNull)
    }
}
