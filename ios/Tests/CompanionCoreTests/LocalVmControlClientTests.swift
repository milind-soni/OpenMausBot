// Taking a bot's computer, joining its Local VM's relayed desktop, and the
// WebSocket request that carries it.
import XCTest
@testable import CompanionCore

private final class LocalVmControlStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?
    static var statusCode = 200
    static var responseBody = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = request.httpBody ?? request.httpBodyStream.map { stream in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            return data
        }
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

final class LocalVmControlClientTests: XCTestCase {
    private var session: URLSession!
    private let relayID = String(repeating: "a", count: 32)

    override func setUp() {
        super.setUp()
        LocalVmControlStub.capturedRequest = nil
        LocalVmControlStub.capturedBody = nil
        LocalVmControlStub.statusCode = 200
        LocalVmControlStub.responseBody = Data()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LocalVmControlStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session?.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    private func client(host: String = "127.0.0.1") -> CompanionClient {
        CompanionClient(connection: Connection(name: "Test", host: host, port: 8810), token: "paired-token", session: session)
    }

    func testTakesAndHandsBackUnderALease() async throws {
        let lease = "phone-lease-0123456789"
        LocalVmControlStub.responseBody = Data(#"{"held":true,"helpReason":null,"owned":true,"acquired":true}"#.utf8)
        let state = try await client().computerControl(botId: "bot_1", take: true, leaseId: lease)
        XCTAssertEqual(state, ComputerControlState(held: true, owned: true))
        let request = try XCTUnwrap(LocalVmControlStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/bots/bot_1/computer/control")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(LocalVmControlStub.capturedBody)) as? [String: String])
        XCTAssertEqual(body, ["action": "take", "controlLeaseId": lease])

        LocalVmControlStub.responseBody = Data(#"{"held":false,"helpReason":null,"released":true}"#.utf8)
        _ = try await client().computerControl(botId: "bot_1", take: false, leaseId: lease)
        let released = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(LocalVmControlStub.capturedBody)) as? [String: String])
        XCTAssertEqual(released["action"], "release")
    }

    func testClosesTheViewerAsAJsonMutation() async throws {
        LocalVmControlStub.responseBody = Data(#"{"closed":true}"#.utf8)
        try await client().closeViewer(botId: "bot_1")
        let request = try XCTUnwrap(LocalVmControlStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/bots/bot_1/computer/viewer-close")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(LocalVmControlStub.capturedBody, Data("{}".utf8))
    }

    func testRefusesALeaseTheHarnessWouldReject() async {
        do {
            _ = try await client().computerControl(botId: "bot_1", take: true, leaseId: "short")
            XCTFail("expected a bad URL")
        } catch {
            guard case APIError.badURL = error else { return XCTFail("\(error)") }
        }
    }

    func testJoinsTheThreadsLocalVmAndBuildsItsAuthenticatedSocket() async throws {
        LocalVmControlStub.responseBody = try JSONSerialization.data(withJSONObject: [
            "joinUrl": "/vps-viewer/\(relayID)/vnc.html#autoconnect=true&resize=scale&password=vm-secret&path=vps-viewer%2F\(relayID)%2Fwebsockify",
        ])
        let viewer = try await client().localVmViewer(botId: "bot_1", threadId: "th-2", leaseId: "phone-lease-0123456789")
        let request = try XCTUnwrap(LocalVmControlStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/bots/bot_1/local-computer/join")
        XCTAssertEqual(request.url?.query, "threadId=th-2&controlLeaseId=phone-lease-0123456789")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(viewer.socketPath, "vps-viewer/\(relayID)/websockify")
        XCTAssertEqual(viewer.password, "vm-secret")

        let socket = try client().viewerSocketRequest(viewer)
        XCTAssertEqual(socket.url?.absoluteString, "ws://127.0.0.1:8810/vps-viewer/\(relayID)/websockify")
        XCTAssertEqual(socket.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        XCTAssertEqual(socket.value(forHTTPHeaderField: "Sec-WebSocket-Protocol"), "binary")
    }

    func testJoinsThroughTheServersOwnProxyWhenPairedDirectly() async throws {
        let lease = "phone-lease-0123456789"
        LocalVmControlStub.responseBody = try JSONSerialization.data(withJSONObject: [
            "socketPath": "api/desktop-viewer/local/shared/websockify?botId=bot_1&threadId=th-2&controlLeaseId=\(lease)",
            "password": "vm-secret",
        ])
        let viewer = try await client(host: "bot.tail0a93.ts.net").localVmViewer(botId: "bot_1", threadId: "th-2", leaseId: lease)
        XCTAssertEqual(viewer.socketPath, "api/desktop-viewer/local/shared/websockify")
        XCTAssertEqual(viewer.socketQuery, ["botId": "bot_1", "threadId": "th-2", "controlLeaseId": lease])
        XCTAssertEqual(viewer.password, "vm-secret")
        XCTAssertFalse(viewer.relayed)

        let socket = try client(host: "bot.tail0a93.ts.net").viewerSocketRequest(viewer)
        XCTAssertEqual(
            socket.url?.absoluteString,
            "ws://bot.tail0a93.ts.net:8810/api/desktop-viewer/local/shared/websockify?botId=bot_1&controlLeaseId=\(lease)&threadId=th-2"
        )
        XCTAssertEqual(socket.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        // The server's proxy negotiates no subprotocol; asking for one would fail the handshake.
        XCTAssertNil(socket.value(forHTTPHeaderField: "Sec-WebSocket-Protocol"))
    }

    func testAcceptsOnlyTheServersDesktopProxyShape() {
        let lease = "phone-lease-0123456789"
        let bound = "botId=bot_1&controlLeaseId=\(lease)"
        for raw in [
            "http://127.0.0.1:45679/vnc.html#password=vm-secret",
            "https://desktop.example/api/desktop-viewer/local/shared/websockify?\(bound)",
            "//evil.example/api/desktop-viewer/local/shared/websockify?\(bound)",
            "api/desktop-viewer/local/shared/websockify",
            "api/desktop-viewer/local/shared/websockify?botId=bot_1",
            "api/desktop-viewer/local/shared/websockify?\(bound)&host=evil.example",
            "api/desktop-viewer/local/shared/websockify?\(bound)&botId=bot_2",
            "api/desktop-viewer/local/shared/websockify?\(bound)&threadId=",
            "api/desktop-viewer/local/127.0.0.1:22/websockify?\(bound)",
            "api/desktop-viewer/vps/bot_1/websockify?\(bound)",
            "api/desktop-viewer/local/shared?\(bound)",
            "api/desktop-viewer/local/shared/websockify?\(bound)#password=x",
        ] {
            XCTAssertNil(LocalVmViewerSession.parseDirect(raw), raw)
        }
        let hash = String(repeating: "0", count: 64)
        for target in ["shared", "bot-\(hash)", "pool-3"] {
            let parsed = LocalVmViewerSession.parseDirect("api/desktop-viewer/local/\(target)/websockify?\(bound)")
            XCTAssertEqual(parsed?.0, "api/desktop-viewer/local/\(target)/websockify")
            XCTAssertEqual(parsed?.1, ["botId": "bot_1", "controlLeaseId": lease])
        }
        XCTAssertEqual(
            LocalVmViewerSession.parseDirect("api/desktop-viewer/local/pool-3/websockify?\(bound)&threadId=th-2")?.1,
            ["botId": "bot_1", "threadId": "th-2", "controlLeaseId": lease]
        )
    }

    func testAcceptsOnlyTheSidecarsRelayShape() {
        for raw in [
            "http://127.0.0.1:45679/vnc.html#password=vm-secret",
            "https://desktop.example/vps-viewer/\(relayID)/vnc.html",
            "//evil.example/vps-viewer/\(relayID)/vnc.html",
            "/vps-viewer/short/vnc.html#password=x",
            "/vps-viewer/\(relayID)/vnc.html#path=vps-viewer%2F\(String(repeating: "b", count: 32))%2Fwebsockify",
            "/other/\(relayID)/vnc.html",
        ] {
            XCTAssertNil(LocalVmViewerSession.parse(raw), raw)
        }
        XCTAssertEqual(LocalVmViewerSession.parse("/vps-viewer/\(relayID)/vnc.html")?.0, "vps-viewer/\(relayID)/websockify")
    }
}
