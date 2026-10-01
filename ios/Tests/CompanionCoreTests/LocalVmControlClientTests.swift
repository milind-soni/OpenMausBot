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
