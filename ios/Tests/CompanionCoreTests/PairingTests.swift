import Foundation
import XCTest
@testable import CompanionCore

private final class PairingRequestStub: URLProtocol {
    enum Action {
        case response(Int, Data)
        case delayedResponse(TimeInterval, Int, Data)
        case failure(URLError.Code)
    }

    static let lock = NSLock()
    static var requests: [URLRequest] = []
    static var action: (URLRequest) -> Action = { _ in .failure(.cannotConnectToHost) }
    private var delayed: DispatchWorkItem?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let action = Self.action(request)
        Self.lock.unlock()

        switch action {
        case let .failure(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case let .response(status, body):
            respond(status: status, body: body)
        case let .delayedResponse(delay, status, body):
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.delayed?.isCancelled == false else { return }
                self.respond(status: status, body: body)
            }
            delayed = work
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    override func stopLoading() {
        delayed?.cancel()
        delayed = nil
    }

    private func respond(status: Int, body: Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func reset(_ handler: @escaping (URLRequest) -> Action) {
        lock.lock()
        requests = []
        action = handler
        lock.unlock()
    }

    static func captured() -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}

final class PairingTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingRequestStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    func testProtectedInviteNeverProbesOrRedeemsOnLANOrBonjour() async throws {
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" {
                return request.url?.host == "192.168.1.42"
                    ? .response(200, Self.health)
                    : .failure(.cannotFindHost)
            }
            return .response(201, Self.paired)
        }
        let connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "astra-aa.local"]
        )

        await XCTAssertThrowsErrorAsync(
            try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                session: session
            )
        ) { error in
            XCTAssertEqual(
                (error as? PairingRouteError)?.attemptedHosts,
                ["http://mac.tail1234.ts.net:8810"]
            )
        }

        let requests = PairingRequestStub.captured()
        XCTAssertEqual(requests.map(\.url?.host), ["mac.tail1234.ts.net"])
        XCTAssertTrue(requests.allSatisfy { $0.url?.path == "/api/health" })
    }

    func testAQuickLANResponseDoesNotOutrankThePreferredTailnetRoute() async throws {
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" {
                return request.url?.host == "mac.tail1234.ts.net"
                    ? .delayedResponse(0.08, 200, Self.health)
                    : .response(200, Self.health)
            }
            return .response(201, Self.paired)
        }
        let connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["192.168.1.42"]
        )

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: connection,
            credential: Self.credential,
            deviceName: "iPhone",
            session: session
        )

        XCTAssertEqual(outcome.connection.host, "mac.tail1234.ts.net")
        XCTAssertEqual(
            PairingRequestStub.captured().filter { $0.url?.path == "/api/pair" }.first?.url?.host,
            "mac.tail1234.ts.net"
        )
        XCTAssertFalse(PairingRequestStub.captured().contains { $0.url?.host == "192.168.1.42" })
    }

    func testTransportFailureRetriesAProtectedFallbackWithTheSameRequestID() async throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let tailnet = try XCTUnwrap(CompanionEndpoint(
            url: "http://mac.tail1234.ts.net:8810",
            kind: .tailnet,
            priority: 100
        ))
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" { return .response(200, Self.health) }
            return request.url?.host == "mac.companion.example"
                ? .failure(.networkConnectionLost)
                : .response(201, Self.paired)
        }
        let connection = Connection(
            name: "Mac",
            host: hosted.host,
            port: hosted.port,
            activeEndpoint: hosted,
            endpoints: [hosted, tailnet]
        )
        let requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec"

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: connection,
            credential: Self.credential,
            deviceName: "iPhone",
            pairRequestId: requestId,
            session: session
        )

        XCTAssertEqual(outcome.connection.activeEndpoint, tailnet)
        let pairRequests = PairingRequestStub.captured().filter { $0.url?.path == "/api/pair" }
        XCTAssertEqual(pairRequests.map(\.url?.host), ["mac.companion.example", "mac.tail1234.ts.net"])
        let ids = try pairRequests.map { request in
            let data = try XCTUnwrap(PairingRequestStub.body(of: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return body["pairRequestId"] as? String
        }
        XCTAssertEqual(ids, [requestId, requestId])
    }

    func testHostedRouteFailureNeverFallsBackToDirectHTTP() async throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" {
                return request.url?.scheme == "https"
                    ? .failure(.cannotConnectToHost)
                    : .response(200, Self.health)
            }
            return .response(201, Self.paired)
        }
        let connection = Connection(
            name: "Mac",
            host: "192.168.1.42",
            port: 8810,
            activeEndpoint: hosted,
            endpoints: [lan, hosted]
        )

        await XCTAssertThrowsErrorAsync(
            try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                session: session
            )
        ) { error in
            XCTAssertEqual(
                (error as? PairingRouteError)?.attemptedHosts,
                ["https://mac.companion.example"]
            )
        }
        let requests = PairingRequestStub.captured()
        XCTAssertEqual(requests.count, 1)
        XCTAssertTrue(requests.allSatisfy {
            $0.url?.scheme == "https" && $0.url?.host == "mac.companion.example" && $0.url?.path == "/api/health"
        })
    }

    func testHostedGatewayFailureRetriesPairingOverTailnetButNeverLAN() async throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let lan = try XCTUnwrap(CompanionEndpoint(
            url: "http://192.168.1.42:8810",
            kind: .lan,
            priority: 200
        ))
        let tailnet = try XCTUnwrap(CompanionEndpoint(
            url: "http://mac.tail1234.ts.net:8810",
            kind: .tailnet,
            priority: 100
        ))
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" { return .response(200, Self.health) }
            return request.url?.scheme == "https"
                ? .response(502, Data())
                : .response(201, Self.paired)
        }
        let connection = Connection(
            name: "Mac",
            host: hosted.host,
            port: hosted.port,
            activeEndpoint: hosted,
            endpoints: [hosted, tailnet, lan]
        )
        let requestId = "d350b2ac-7f92-4f30-bf80-21e040c1494b"

        let outcome = try await CompanionClient.pairFirstReachable(
            connection: connection,
            credential: Self.credential,
            deviceName: "iPhone",
            pairRequestId: requestId,
            session: session
        )

        XCTAssertEqual(outcome.connection.activeEndpoint, tailnet)
        let pairRequests = PairingRequestStub.captured().filter { $0.url?.path == "/api/pair" }
        XCTAssertEqual(pairRequests.map(\.url?.scheme), ["https", "http"])
        XCTAssertEqual(pairRequests.map(\.url?.host), ["mac.companion.example", "mac.tail1234.ts.net"])
        XCTAssertFalse(PairingRequestStub.captured().contains { $0.url?.host == "192.168.1.42" })
        let ids = try pairRequests.map { request in
            let data = try XCTUnwrap(PairingRequestStub.body(of: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return body["pairRequestId"] as? String
        }
        XCTAssertEqual(ids, [requestId, requestId])
    }

    func testRetryCanReuseTheLogicalRequestIDAfterTheOnlyRouteDropsItsResponse() async throws {
        var pairAttempts = 0
        PairingRequestStub.reset { request in
            if request.url?.path == "/api/health" { return .response(200, Self.health) }
            pairAttempts += 1
            return pairAttempts == 1 ? .failure(.networkConnectionLost) : .response(201, Self.paired)
        }
        let connection = Connection(name: "Mac", host: "192.168.1.42", port: 8810)
        let requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec"

        await XCTAssertThrowsErrorAsync(
            try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                pairRequestId: requestId,
                session: session
            )
        ) { error in
            XCTAssertTrue(error is PairingRouteError)
        }
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: connection,
            credential: Self.credential,
            deviceName: "iPhone",
            pairRequestId: requestId,
            session: session
        )

        XCTAssertEqual(outcome.response.token, "omb_device")
        let pairRequests = PairingRequestStub.captured().filter { $0.url?.path == "/api/pair" }
        XCTAssertEqual(pairRequests.count, 2)
        let ids = try pairRequests.map { request in
            let data = try XCTUnwrap(PairingRequestStub.body(of: request))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return body["pairRequestId"] as? String
        }
        XCTAssertEqual(ids, [requestId, requestId])
    }

    func testAllFailedProbesLeaveTheCredentialUnspent() async throws {
        PairingRequestStub.reset { _ in .failure(.timedOut) }
        let connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["192.168.1.42"]
        )

        do {
            _ = try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                session: session
            )
            XCTFail("pairing should fail when no route answers")
        } catch let error as PairingRouteError {
            XCTAssertEqual(error.attemptedHosts, [
                "http://mac.tail1234.ts.net:8810",
            ])
        }
        XCTAssertTrue(PairingRequestStub.captured().allSatisfy { $0.url?.path == "/api/health" })
    }

    func testRejectsAServiceThatDoesNotIdentifyAsAstra() async throws {
        PairingRequestStub.reset { _ in .response(200, Data(#"{"app":"something-else"}"#.utf8)) }
        let connection = Connection(name: "Mac", host: "192.168.1.42", port: 8810)

        await XCTAssertThrowsErrorAsync(
            try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                session: session
            )
        ) { error in
            XCTAssertTrue(error is PairingRouteError)
        }
        XCTAssertFalse(PairingRequestStub.captured().contains { $0.url?.path == "/api/pair" })
    }

    func testPairingRejectionIsNotSentToAnotherRoute() async throws {
        PairingRequestStub.reset { request in
            request.url?.path == "/api/health"
                ? .response(200, Self.health)
                : .response(401, Data(#"{"error":"pairing expired"}"#.utf8))
        }
        let connection = Connection(
            name: "Mac",
            host: "192.168.1.42",
            port: 8810,
            hosts: ["astra-aa.local"]
        )

        do {
            _ = try await CompanionClient.pairFirstReachable(
                connection: connection,
                credential: Self.credential,
                deviceName: "iPhone",
                session: session
            )
            XCTFail("an expired credential should be rejected")
        } catch let APIError.status(code, message) {
            XCTAssertEqual(code, 401)
            XCTAssertEqual(message, "pairing expired")
        }
        XCTAssertEqual(PairingRequestStub.captured().filter { $0.url?.path == "/api/pair" }.count, 1)
    }

    func testExplicitManualLANConnectionStillPairs() async throws {
        PairingRequestStub.reset { request in
            request.url?.path == "/api/health"
                ? .response(200, Self.health)
                : .response(201, Self.paired)
        }
        let connection = Connection(name: "Mac", host: "192.168.1.42", port: 8810)
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: connection,
            credential: "004209",
            deviceName: "iPhone",
            session: session
        )

        XCTAssertEqual(outcome.connection.host, "192.168.1.42")
        XCTAssertEqual(outcome.response.token, "omb_device")
        XCTAssertTrue(PairingRequestStub.captured().allSatisfy { $0.url?.host == "192.168.1.42" })
    }

    private static let credential = "omb_pair_" + String(repeating: "a", count: 43)
    private static let health = Data(#"{"app":"astra","pid":42,"static":true}"#.utf8)
    private static let paired = Data(
        #"{"token":"omb_device","device":{"id":"d","name":"iPhone","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["192.168.1.42"]}"#.utf8
    )
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in }
) async {
    do {
        _ = try await expression()
        XCTFail("expected expression to throw")
    } catch {
        errorHandler(error)
    }
}
