import Foundation
import XCTest
@testable import CompanionCore

private final class VoiceProviderRequestStub: URLProtocol {
    static var responseBody = Data()
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

final class VoiceProviderClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        VoiceProviderRequestStub.capturedRequest = nil
        VoiceProviderRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceProviderRequestStub.self]
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

    func testSetVoiceProviderWritesTheEngineAndNothingElse() async throws {
        VoiceProviderRequestStub.responseBody = Self.chatterboxStatus

        let status = try await client.setVoiceProvider(.chatterbox)

        XCTAssertEqual(status.voiceProvider, .chatterbox)
        let request = try XCTUnwrap(VoiceProviderRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/config")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        let body = try XCTUnwrap(Self.jsonBody())
        XCTAssertEqual(body.keys.sorted(), ["tts"])
        let tts = try XCTUnwrap(body["tts"] as? [String: Any])
        // A provider is a setting, not a secret; the write must not carry
        // credentials it has no business touching.
        XCTAssertEqual(tts.keys.sorted(), ["provider"])
        XCTAssertEqual(tts["provider"] as? String, "chatterbox")
    }

    func testSetFishVoiceProviderUsesItsExactWireValue() async throws {
        VoiceProviderRequestStub.responseBody = Self.fishStatus

        let status = try await client.setVoiceProvider(.fish)

        XCTAssertEqual(status.voiceProvider, .fish)
        let body = try XCTUnwrap(Self.jsonBody())
        let tts = try XCTUnwrap(body["tts"] as? [String: Any])
        XCTAssertEqual(tts.keys.sorted(), ["provider"])
        XCTAssertEqual(tts["provider"] as? String, "fish")
    }

    func testWalkieNeverSendsAnotherProvidersVoiceIdToElevenLabs() throws {
        let fish = try JSONDecoder().decode(ConfigStatus.self, from: Self.fishStatus)
        let eleven = try JSONDecoder().decode(
            ConfigStatus.self,
            from: Data(#"{"tts":{"configured":true,"provider":"elevenlabs"}}"#.utf8)
        )

        XCTAssertNil(fish.walkieAgentVoice("fish-voice"))
        XCTAssertEqual(eleven.walkieAgentVoice("eleven-voice"), "eleven-voice")
    }

    func testSaveChatterboxServerCommitsAddressAndModelTogether() async throws {
        VoiceProviderRequestStub.responseBody = Self.chatterboxStatus

        let status = try await client.saveChatterboxServer(
            baseURL: "http://127.0.0.1:4123",
            model: "chatterbox-turbo"
        )

        XCTAssertEqual(status.tts?.baseUrl, "http://127.0.0.1:4123")
        XCTAssertEqual(status.tts?.model, "chatterbox-turbo")
        let request = try XCTUnwrap(VoiceProviderRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/config")
        let body = try XCTUnwrap(Self.jsonBody())
        let tts = try XCTUnwrap(body["tts"] as? [String: Any])
        XCTAssertEqual(tts.keys.sorted(), ["baseUrl", "model"])
        XCTAssertEqual(tts["baseUrl"] as? String, "http://127.0.0.1:4123")
        XCTAssertEqual(tts["model"] as? String, "chatterbox-turbo")
    }

    private static func jsonBody() throws -> [String: Any] {
        let data = try XCTUnwrap(VoiceProviderRequestStub.capturedBody)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static let chatterboxStatus = Data(
        #"{"tts":{"configured":true,"ready":true,"provider":"chatterbox","baseUrl":"http://127.0.0.1:4123","model":"chatterbox-turbo"}}"#.utf8
    )
    private static let fishStatus = Data(
        #"{"tts":{"configured":true,"ready":true,"provider":"fish","voice":"fish-voice"}}"#.utf8
    )
}
