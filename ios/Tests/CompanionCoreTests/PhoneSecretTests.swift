import Foundation
import XCTest
@testable import CompanionCore

private final class PhoneSecretRequestStub: URLProtocol {
    static var request: URLRequest?
    static var body: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.request = request
        Self.body = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"provided":true,"resumed":true}"#.utf8))
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

final class PhoneSecretTests: XCTestCase {
    private let publicKey = "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU"
    private let context = PhoneSecretRequestContext(
        deviceId: "paired-device-1",
        botId: "bot-1",
        threadId: "thread-1",
        messageId: "message-1",
        target: "ttsKey",
        requestKey: "credential-request-1"
    )

    func testExplainsWhenCredentialTransportIsNotProtected() {
        XCTAssertEqual(
            PhoneSecretError.insecureTransport.errorDescription,
            "Use secure phone access or Tailscale before sending a credential from this phone."
        )
    }

    func testValidatesThePairingKeyAndUsesStableCrossPlatformAAD() throws {
        XCTAssertEqual(PhoneSecretCrypto.normalizedPublicKey(publicKey), publicKey)
        XCTAssertEqual(try PhoneSecretCrypto.publicKeyId(publicKey), "taWSR_nZ7ojlH_0Z3tar6Q")
        XCTAssertEqual(
            String(decoding: try PhoneSecretCrypto.authenticatedData(
                keyId: "taWSR_nZ7ojlH_0Z3tar6Q",
                context: context
            ), as: UTF8.self),
            [
                "openmausbot-phone-credential-v1",
                "taWSR_nZ7ojlH_0Z3tar6Q",
                "paired-device-1",
                "bot-1",
                "thread-1",
                "message-1",
                "ttsKey",
                "credential-request-1",
            ].joined(separator: "\n")
        )
        XCTAssertNil(PhoneSecretCrypto.normalizedPublicKey(String(publicKey.dropLast())))
    }

    @available(macOS 14.0, *)
    func testEncryptsWithoutPuttingPlaintextInTheEnvelope() throws {
        let envelope = try PhoneSecretCrypto.encrypt(
            "swift-secret-that-must-not-leak",
            publicKey: publicKey,
            context: context
        )
        let wire = String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)

        XCTAssertEqual(envelope.version, 1)
        XCTAssertEqual(envelope.keyId, "taWSR_nZ7ojlH_0Z3tar6Q")
        XCTAssertEqual(Data(base64URLEncoded: envelope.encapsulatedKey)?.count, 65)
        XCTAssertFalse(wire.contains("swift-secret-that-must-not-leak"))
    }

    func testClientPostsOnlyTheEnvelopeToTheExactCard() async throws {
        PhoneSecretRequestStub.request = nil
        PhoneSecretRequestStub.body = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhoneSecretRequestStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
        let envelope = PhoneSecretEnvelope(
            version: 1,
            threadId: "thread-1",
            keyId: "taWSR_nZ7ojlH_0Z3tar6Q",
            deviceId: "paired-device-1",
            target: "ttsKey",
            requestKey: "credential-request-1",
            encapsulatedKey: String(repeating: "A", count: 87),
            ciphertext: String(repeating: "B", count: 32)
        )

        try await client.provideCredential(botId: "bot-1", messageId: "message-1", envelope: envelope)

        XCTAssertEqual(PhoneSecretRequestStub.request?.httpMethod, "POST")
        XCTAssertEqual(
            PhoneSecretRequestStub.request?.url?.path,
            "/api/bots/bot-1/secret-cards/message-1/provide"
        )
        XCTAssertEqual(
            PhoneSecretRequestStub.request?.value(forHTTPHeaderField: "Authorization"),
            "Bearer paired-token"
        )
        XCTAssertEqual(PhoneSecretRequestStub.request?.timeoutInterval, 115)
        let body = try XCTUnwrap(PhoneSecretRequestStub.body)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["threadId"] as? String, "thread-1")
        XCTAssertEqual(object["ciphertext"] as? String, String(repeating: "B", count: 32))
        XCTAssertNil(object["value"])
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}
