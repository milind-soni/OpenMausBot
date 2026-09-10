import Foundation
import XCTest
@testable import CompanionCore

/// Pairing with a server directly (`openmausbot serve`, the Docker stack):
/// the `https://host/pair#code=…` link, `POST /api/auth/pair`, and the
/// connection that comes out of it.
private final class ServerRequestStub: URLProtocol {
    static let lock = NSLock()
    static var requests: [URLRequest] = []
    static var action: (URLRequest) -> (Int, Data) = { _ in (500, Data()) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let (status, body) = Self.action(request)
        Self.lock.unlock()
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

    override func stopLoading() {}

    static func reset(_ handler: @escaping (URLRequest) -> (Int, Data)) {
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

    static func body(of request: URLRequest) -> [String: Any]? {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                result.append(buffer, count: count)
            }
            data = result
        }
        guard let data else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

final class ServerPairingTests: XCTestCase {
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ServerRequestStub.self]
        session = URLSession(configuration: configuration)
    }

    private func fixture(_ name: String) throws -> Data {
        // `.copy("Fixtures")` keeps the directory; a stale local build may flatten it
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: name, withExtension: "json")
        )
        return try Data(contentsOf: url)
    }

    func testTheServersLinkBecomesAHostedInviteWithTheNormalizedCode() throws {
        let invite = try XCTUnwrap(PairingInvite.parse(XCTUnwrap(URL(string: "https://c-7f3a9c.openmausbot.com/pair#code=abcd-efgh-jklm"))))
        XCTAssertEqual(invite.credential, "ABCDEFGHJKLM")
        XCTAssertEqual(invite.connection.activeEndpoint?.kind, .hosted)
        XCTAssertEqual(invite.connection.activeEndpoint?.url, "https://c-7f3a9c.openmausbot.com")
        XCTAssertEqual(invite.connection.host, "c-7f3a9c.openmausbot.com")

        // a port survives; a plain-http LAN link infers the local kind
        let withPort = try XCTUnwrap(PairingInvite.parse(XCTUnwrap(URL(string: "https://mini.example:8443/pair#code=ABCDEFGHJKLM"))))
        XCTAssertEqual(withPort.connection.activeEndpoint?.url, "https://mini.example:8443")
        let lan = try XCTUnwrap(PairingInvite.parse(XCTUnwrap(URL(string: "http://192.168.1.20:8799/pair#code=ABCD-EFGH-JKLM"))))
        XCTAssertEqual(lan.connection.activeEndpoint?.kind, .lan)
    }

    func testOnlyAWellFormedServerLinkIsAccepted() throws {
        for bad in [
            "https://mini.example/pair", // no code
            "https://mini.example/pair#code=ABCD-EFGH", // too short
            "https://mini.example/pair#code=123456789012", // digits only is not a server code
            "https://mini.example/other#code=ABCDEFGHJKLM", // wrong path
            "https://mini.example/pair?code=ABCDEFGHJKLM", // in the query, not the fragment
            "https://mini.example/pair#code=ABCDEFGHJKLM&code=ABCDEFGHJKLM", // duplicated
            "ftp://mini.example/pair#code=ABCDEFGHJKLM",
        ] {
            XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: bad))), bad)
        }
        // the companion's own invites still parse
        XCTAssertNotNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=192.168.1.9:8810&code=123456"))))
    }

    func testServerCodesAreDistinguishedFromCompanionCredentialsByShape() {
        XCTAssertEqual(PairingInvite.normalizedServerCode(" abcd-efgh-jklm "), "ABCDEFGHJKLM")
        XCTAssertNil(PairingInvite.normalizedServerCode("123456"))
        XCTAssertNil(PairingInvite.normalizedServerCode("omb_pair_" + String(repeating: "a", count: 43)))
        XCTAssertNil(PairingInvite.normalizedServerCode("ABCDEFGHJKL"))
    }

    func testPairingPostsTheCodeWithoutACookieAndKeepsTheBearer() async throws {
        let body = try fixture("auth-pair-response")
        ServerRequestStub.reset { _ in (200, body) }
        let connection = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        let paired = try await CompanionClient.pairWithServer(
            connection: connection,
            code: "ABCDEFGHJKLM",
            label: "Milind's iPhone",
            attemptId: "attempt-1",
            session: session
        )
        XCTAssertEqual(paired.token, "omb_sess_Zk3vJq8mN2xR7tL9wP4yH6bC1dF5gA0sE8uK2iO7")
        XCTAssertEqual(paired.session.scopes, ["client"])
        XCTAssertFalse(paired.session.isAdmin)
        XCTAssertEqual(paired.environment.environmentId, "env_7f3a9c")
        XCTAssertEqual(paired.environment.label, "cab mini")

        let request = try XCTUnwrap(ServerRequestStub.captured().first)
        XCTAssertEqual(request.url?.absoluteString, "https://c-7f3a9c.openmausbot.com/api/auth/pair")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let sent = try XCTUnwrap(ServerRequestStub.body(of: request))
        XCTAssertEqual(sent["code"] as? String, "ABCDEFGHJKLM")
        XCTAssertEqual(sent["label"] as? String, "Milind's iPhone")
        XCTAssertEqual(sent["attemptId"] as? String, "attempt-1")
        XCTAssertNil(sent["cookie"], "the token is the app's; never ask for a browser cookie")
    }

    func testARefusedCodeSurfacesTheServersOwnMessage() async throws {
        ServerRequestStub.reset { _ in (401, Data(#"{"error":"that code is not valid or has expired"}"#.utf8)) }
        let connection = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        do {
            _ = try await CompanionClient.pairWithServer(connection: connection, code: "ABCDEFGHJKLM", label: "phone", session: session)
            XCTFail("expected a refusal")
        } catch let error as APIError {
            guard case let .status(code, message) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(code, 401)
            XCTAssertEqual(message, "that code is not valid or has expired")
        }
    }

    func testTheDescriptorIsReadableWithoutASession() async throws {
        let body = try fixture("environment")
        ServerRequestStub.reset { _ in (200, body) }
        let connection = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        let environment = try await CompanionClient(connection: connection, token: nil, session: session).environment()
        XCTAssertEqual(environment, ServerEnvironment(environmentId: "env_7f3a9c", label: "cab mini", platform: "linux", version: "0.1.55"))
        XCTAssertEqual(ServerRequestStub.captured().first?.url?.path, "/.well-known/openmausbot/environment")
    }

    func testConnectionsSavedBeforeServerPairingStillDecodeAsCompanionOnes() throws {
        let legacy = Data(#"{"id":"c1","name":"Ada's computer","host":"192.168.1.9","port":8810}"#.utf8)
        let decoded = try JSONDecoder().decode(Connection.self, from: legacy)
        XCTAssertFalse(decoded.pairedWithServer)
        var server = decoded
        server.serverEnvironmentId = "env_7f3a9c"
        XCTAssertTrue(server.pairedWithServer)
        let round = try JSONDecoder().decode(Connection.self, from: JSONEncoder().encode(server))
        XCTAssertEqual(round.serverEnvironmentId, "env_7f3a9c")
    }

    func testCodeNormalizationMatchesTheServers() throws {
        // what the server does before comparing: uppercase, strip, 0→O, 1→I
        XCTAssertEqual(PairingInvite.normalizePairingCode(" abcd-efgh jklm "), "ABCDEFGHJKLM")
        XCTAssertEqual(PairingInvite.normalizePairingCode("ab0d-1fgh-jklm"), "ABODIFGHJKLM")
        XCTAssertEqual(PairingInvite.normalizedServerCode("2345-6789-abcd"), "23456789ABCD")
        // the alphabet has neither O nor I, so a code with 0, 1, O or I can
        // only be a mistake: refused here, before an attempt is spent
        XCTAssertNil(PairingInvite.normalizedServerCode("ab0d-1fgh-jklm"))
        XCTAssertNil(PairingInvite.normalizedServerCode("ABCD-EFGH-JKLO"))
        XCTAssertNil(PairingInvite.normalizedServerCode("ABCDEFGHJKLMN")) // thirteen
        // in a link too, whatever case the link came in
        let invite = PairingInvite.parse(try XCTUnwrap(URL(string: "HTTPS://Mini.Example:8443/pair#code=abcd-efgh-jklm")))
        XCTAssertEqual(invite?.credential, "ABCDEFGHJKLM")
        XCTAssertEqual(invite?.connection.activeEndpoint?.url, "https://mini.example:8443")
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "https://mini.example/pair#code=ab0d-1fgh-jklm"))))
    }

    func testEveryRefusalCarriesTheServersStatusAndMessage() async throws {
        let connection = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        for (status, message) in [
            (415, "send the pairing code as JSON (content-type: application/json)"),
            (429, "too many failed pairing attempts from your address; try again in 60s"),
            (400, "bad request"),
        ] {
            ServerRequestStub.reset { _ in (status, Data(#"{"error":"\#(message)"}"#.utf8)) }
            do {
                _ = try await CompanionClient.pairWithServer(connection: connection, code: "ABCDEFGHJKLM", label: "phone", session: session)
                XCTFail("expected HTTP \(status) to be refused")
            } catch let error as APIError {
                guard case let .status(code, text) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(code, status)
                XCTAssertEqual(text, message)
                XCTAssertEqual(error.localizedDescription, message)
                XCTAssertFalse(error.isUnauthorized, "only a 401 sends the person back to pairing")
            }
            // 415 is what the server answers when this header is missing
            let request = try XCTUnwrap(ServerRequestStub.captured().first)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        }
    }

    func testOnlyAnAdminScopedServerSessionMayAdminister() throws {
        let companion = Connection(name: "Ada's computer", host: "192.168.1.9", port: 8810)
        XCTAssertTrue(companion.canAdminister, "the sidecar applies its own policy to each request")

        var chatOnly = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        chatOnly.serverEnvironmentId = "env_7f3a9c"
        chatOnly.serverScopes = ["client"]
        XCTAssertFalse(chatOnly.canAdminister)

        var owner = chatOnly
        owner.serverScopes = ["admin", "client"]
        XCTAssertTrue(owner.canAdminister)
        let round = try JSONDecoder().decode(Connection.self, from: JSONEncoder().encode(owner))
        XCTAssertEqual(round.serverScopes, ["admin", "client"])
        XCTAssertTrue(round.canAdminister)

        // saved by a build that paired with servers but recorded no scopes:
        // it treated every such pairing as chat-only, and so does this one
        let earlier = Data(#"{"id":"s1","name":"cab mini","host":"c-7f3a9c.openmausbot.com","port":443,"serverEnvironmentId":"env_7f3a9c"}"#.utf8)
        let decoded = try JSONDecoder().decode(Connection.self, from: earlier)
        XCTAssertTrue(decoded.pairedWithServer)
        XCTAssertNil(decoded.serverScopes)
        XCTAssertFalse(decoded.canAdminister)

        // the pair response is where the scopes come from
        let admin = try JSONDecoder().decode(ServerPairResponse.self, from: Data(#"""
        {"token":"omb_sess_x","session":{"id":"s","label":"iPhone","scopes":["admin","client"],"createdAt":1,"expiresAt":2},
         "environment":{"environmentId":"env","label":"mini","platform":"darwin","version":"0.1.66",
                        "capabilities":{"remoteSessions":true,"selfUpdate":"desktop-managed"}}}
        """#.utf8))
        XCTAssertTrue(admin.session.isAdmin)
        XCTAssertEqual(admin.session.scopes, ["admin", "client"])
    }

    func testAServerConnectionsStreamCarriesTheBearerAndResumesFromTheCursor() async throws {
        ServerRequestStub.reset { _ in (401, Data(#"{"error":"session revoked"}"#.utf8)) }
        var connection = try XCTUnwrap(Connection.parse("https://c-7f3a9c.openmausbot.com"))
        connection.serverEnvironmentId = "env_7f3a9c"
        connection.serverScopes = ["client"]
        let client = CompanionClient(connection: connection, token: "omb_sess_Zk3v", session: session)
        do {
            for try await _ in try client.events(since: "abc12345:7", streamingSession: session) {}
            XCTFail("a revoked session must surface as unauthorized, not as an empty stream")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
        }
        let request = try XCTUnwrap(ServerRequestStub.captured().first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omb_sess_Zk3v")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "c-7f3a9c.openmausbot.com")
        XCTAssertEqual(components.path, "/api/events")
        XCTAssertEqual(components.queryItems?.first { $0.name == "since" }?.value, "abc12345:7")
        XCTAssertEqual(components.queryItems?.first { $0.name == "screens" }?.value, "off")
    }
}
