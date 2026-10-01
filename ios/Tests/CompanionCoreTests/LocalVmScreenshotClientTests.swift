// An on-demand still of a bot's Local VM: the route the phone asks, and the
// data URL it is willing to turn into an image.
import XCTest
@testable import CompanionCore

private final class LocalVmScreenshotStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var statusCode = 200
    static var responseBody = Data()

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

final class LocalVmScreenshotClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

    override func setUp() {
        super.setUp()
        LocalVmScreenshotStub.capturedRequest = nil
        LocalVmScreenshotStub.statusCode = 200
        LocalVmScreenshotStub.responseBody = Data()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LocalVmScreenshotStub.self]
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

    private func body(image: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["image": image])
    }

    func testAsksForTheThreadsLocalVmAndDecodesThePicture() async throws {
        LocalVmScreenshotStub.responseBody = try body(image: "data:image/png;base64,\(png.base64EncodedString())")

        let shot = try await client.localVmScreenshot(botId: "bot_1", threadId: "th-2")

        let request = try XCTUnwrap(LocalVmScreenshotStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/bots/bot_1/local-computer/screenshot")
        XCTAssertEqual(request.url?.query, "threadId=th-2")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        XCTAssertEqual(shot.data, png)
        XCTAssertEqual(shot.mime, "image/png")
    }

    func testAcceptsAJpegStill() throws {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 1, 2])
        let shot = try JSONDecoder().decode(
            LocalVmScreenshot.self,
            from: try body(image: "data:image/jpeg;base64,\(jpeg.base64EncodedString())")
        )
        XCTAssertEqual(shot.data, jpeg)
        XCTAssertEqual(shot.mime, "image/jpeg")
    }

    func testRefusesAnythingButABase64PngOrJpeg() throws {
        for image in [
            "data:image/svg+xml;base64,\(Data("<svg/>".utf8).base64EncodedString())",
            "data:text/html;base64,\(Data("<b>".utf8).base64EncodedString())",
            "data:image/png;base64,not base64!",
            "data:image/png;base64,",
            "https://example.com/screen.png",
            png.base64EncodedString()
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(LocalVmScreenshot.self, from: try body(image: image)), image)
        }
    }

    func testSurfacesTheSidecarRefusalWhenComputerAccessIsOff() async throws {
        LocalVmScreenshotStub.statusCode = 403
        LocalVmScreenshotStub.responseBody = Data(#"{"error":"computer access is off for this device"}"#.utf8)

        do {
            _ = try await client.localVmScreenshot(botId: "bot_1", threadId: "th-2")
            XCTFail("expected a 403")
        } catch let APIError.status(code, message) {
            XCTAssertEqual(code, 403)
            XCTAssertEqual(message, "computer access is off for this device")
        }
    }

    func testRefusesIdsThatWouldChangeTheRoute() async {
        for (botId, threadId) in [("../config", "th"), ("bot", "th?x=1"), ("", "th")] {
            do {
                _ = try await client.localVmScreenshot(botId: botId, threadId: threadId)
                XCTFail("expected a bad URL for \(botId) / \(threadId)")
            } catch {
                guard case APIError.badURL = error else { return XCTFail("\(error)") }
            }
        }
        XCTAssertNil(LocalVmScreenshotStub.capturedRequest)
    }
}
