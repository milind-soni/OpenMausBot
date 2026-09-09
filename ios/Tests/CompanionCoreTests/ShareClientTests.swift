import Foundation
import XCTest
@testable import CompanionCore

private final class ShareRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var responseHeaders = ["Content-Type": "application/json"]
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
            headerFields: Self.responseHeaders
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

final class ShareClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ShareRequestStub.responseBody = Data()
        ShareRequestStub.statusCode = 200
        ShareRequestStub.responseHeaders = ["Content-Type": "application/json"]
        ShareRequestStub.capturedRequest = nil
        ShareRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ShareRequestStub.self]
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

    func testComposesSharedContentAndEscapesUploadedPaths() throws {
        let url = try XCTUnwrap(URL(string: "https://example.com/story"))

        let message = SharedMessageComposer.compose(
            instruction: "  Summarize this  ",
            text: ["  A useful excerpt.\n", "A useful excerpt.", "  "],
            urls: [url, url],
            attachments: [
                SharedAttachmentReference(
                    path: "/tmp/a&\"b.png",
                    kind: .image,
                    displayName: "Launch & hero.png"
                ),
                SharedAttachmentReference(
                    path: "/tmp/notes<final>.pdf",
                    kind: .file,
                    displayName: "Project notes.pdf"
                ),
            ]
        )

        XCTAssertEqual(message, """
        Summarize this

        A useful excerpt.

        https://example.com/story

        <attached-image path="/tmp/a&amp;&quot;b.png" name="Launch &amp; hero.png" />

        <attached-file path="/tmp/notes&lt;final&gt;.pdf" name="Project notes.pdf" />
        """)
    }

    func testComposesLegacyUnnamedImageTagWhenNoDisplayNameIsAvailable() {
        let message = SharedMessageComposer.compose(
            instruction: "",
            text: [],
            urls: [],
            attachments: [SharedAttachmentReference(path: "/tmp/image.png", kind: .image)]
        )

        XCTAssertEqual(message, #"<attached-image path="/tmp/image.png" />"#)
    }

    func testRawImageUploadKeepsBytesOutOfJSONAndReturnsMacPath() async throws {
        ShareRequestStub.statusCode = 201
        ShareRequestStub.responseBody = Data(#"{"path":"/Users/test/.openmausbot/attachments/image.png","mime":"image/png","bytes":4}"#.utf8)
        let bytes = Data([0x89, 0x50, 0x4E, 0x47])

        let uploadId = "7DB8737D-85B9-4BE5-A3D8-FA8D74EBA52B"
        let path = try await client.uploadImage(
            data: bytes,
            mime: "IMAGE/PNG",
            uploadId: uploadId
        )

        XCTAssertEqual(path, "/Users/test/.openmausbot/attachments/image.png")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/attachments")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(ShareRequestStub.capturedRequest?.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "uploadId" })?.value,
            uploadId
        )
        XCTAssertEqual(ShareRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"), "image/png")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        XCTAssertEqual(ShareRequestStub.capturedBody, bytes)
    }

    func testRawFileUploadEncodesDisplayNameAndReturnsMacPath() async throws {
        ShareRequestStub.statusCode = 201
        ShareRequestStub.responseBody = Data(#"{"path":"/Users/test/.openmausbot/files/id.pdf","name":"Q3 plan.pdf","mime":"application/pdf","bytes":3}"#.utf8)
        let bytes = Data([1, 2, 3])

        let uploadId = "7DB8737D-85B9-4BE5-A3D8-FA8D74EBA52B"
        let uploaded = try await client.uploadFile(
            data: bytes,
            name: "../Q3 plan.pdf",
            mime: "application/pdf",
            uploadId: uploadId
        )

        XCTAssertEqual(uploaded.path, "/Users/test/.openmausbot/files/id.pdf")
        XCTAssertEqual(uploaded.name, "Q3 plan.pdf")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/files")
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(ShareRequestStub.capturedRequest?.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "name" })?.value,
            "Q3 plan.pdf"
        )
        XCTAssertEqual(
            URLComponents(url: try XCTUnwrap(ShareRequestStub.capturedRequest?.url), resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "uploadId" })?.value,
            uploadId
        )
        XCTAssertEqual(ShareRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(ShareRequestStub.capturedBody, bytes)
    }

    func testFileUploadRejectsAnUnsafeReturnedDisplayName() async {
        ShareRequestStub.statusCode = 201
        ShareRequestStub.responseBody = Data(
            #"{"path":"/Users/test/.openmausbot/attachments/id.pdf","name":"../secret.pdf","mime":"application/pdf","bytes":3}"#.utf8
        )

        do {
            _ = try await client.uploadFile(
                data: Data([1, 2, 3]),
                name: "notes.pdf",
                mime: "application/pdf"
            )
            XCTFail("expected returned filename rejection")
        } catch {
            XCTAssertNotNil(ShareRequestStub.capturedRequest)
        }
    }

    func testOversizedFileIsRejectedBeforeNetworking() async {
        let bytes = Data(repeating: 0, count: CompanionClient.maximumFileUploadBytes + 1)

        do {
            _ = try await client.uploadFile(data: bytes, name: "large.zip", mime: "application/zip")
            XCTFail("expected local size rejection")
        } catch {
            XCTAssertNil(ShareRequestStub.capturedRequest)
        }
    }

    func testMalformedUploadIDIsRejectedBeforeNetworking() async {
        do {
            _ = try await client.uploadImage(
                data: Data([1, 2, 3]),
                mime: "image/png",
                uploadId: "not-an-upload-id"
            )
            XCTFail("expected local upload id rejection")
        } catch APIError.badURL {
            XCTAssertNil(ShareRequestStub.capturedRequest)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRetrySafeSendPinsBotThreadAndLogicalSendID() async throws {
        try await client.send(
            text: "Review this",
            to: .bot(id: "bot-1", threadId: "task_1"),
            sendId: "8E50CD29-DBB2-4D76-971B-112DD962C9FA"
        )

        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/bots/bot-1/messages")
        let data = try XCTUnwrap(ShareRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(body, [
            "text": "Review this",
            "threadId": "task_1",
            "sendId": "8E50CD29-DBB2-4D76-971B-112DD962C9FA",
        ])
    }

    func testRetrySafeSendRoutesRoomsWithoutGuessingFromThread() async throws {
        try await client.send(
            text: "Share this",
            to: .room(id: "room_1", threadId: "room-task"),
            sendId: "share_1234567890123456"
        )

        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/groups/room_1/messages")
    }

    func testImageCapabilityInventoryFailsClosedWhenMissing() async throws {
        ShareRequestStub.responseBody = Data(#"{"instances":[{"instanceId":"vision","capabilities":{"images":true}},{"instanceId":"text","capabilities":{"images":false}},{"instanceId":"legacy"}]}"#.utf8)

        let capable = try await client.imageCapableInstanceIDs()

        XCTAssertEqual(capable, Set(["vision"]))
        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/instances")
    }

    func testRetrySafeSendRejectsUnsafeRouteComponentsBeforeNetworking() async {
        do {
            try await client.send(
                text: "No",
                to: .bot(id: "../config", threadId: "task"),
                sendId: "share_1234567890123456"
            )
            XCTFail("expected unsafe route rejection")
        } catch APIError.badURL {
            XCTAssertNil(ShareRequestStub.capturedRequest)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRequestTimeoutCanBeShortenedForAnExtensionLifetime() async throws {
        let shortClient = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session,
            requestTimeout: 7
        )

        try await shortClient.send(text: "hello", toBot: "bot-1")

        XCTAssertEqual(ShareRequestStub.capturedRequest?.timeoutInterval, 7)
    }

    func testAuthenticatedFileDownloadPostsPathAndSanitizesResponseMetadata() async throws {
        ShareRequestStub.responseBody = Data("# Report".utf8)
        ShareRequestStub.responseHeaders = [
            "Content-Type": "Text/Markdown; charset=utf-8",
            "Content-Disposition": "attachment; filename*=UTF-8''Quarter%20Report.md",
        ]

        let file = try await client.downloadFile(
            threadId: "thread-1",
            messageId: "message-1",
            path: "/Users/test/Documents/report.md"
        )

        XCTAssertEqual(ShareRequestStub.capturedRequest?.url?.path, "/api/threads/thread-1/messages/message-1/file")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.httpMethod, "POST")
        XCTAssertEqual(ShareRequestStub.capturedRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        let body = try XCTUnwrap(ShareRequestStub.capturedBody)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: body) as? [String: String],
            ["path": "/Users/test/Documents/report.md"]
        )
        XCTAssertEqual(file.data, Data("# Report".utf8))
        XCTAssertEqual(file.filename, "Quarter Report.md")
        XCTAssertEqual(file.contentType, "text/markdown")
        XCTAssertNil(file.localURL)
    }

    func testFileDownloadStripsPathAndControlsFromResponseFilename() async throws {
        ShareRequestStub.responseBody = Data([1])
        ShareRequestStub.responseHeaders = [
            "Content-Type": "not a mime",
            "Content-Disposition": "attachment; filename=\"../secret\u{202E}.txt\"",
        ]

        let file = try await client.downloadFile(
            threadId: "thread-1",
            messageId: "message-1",
            path: "/Users/test/fallback.txt"
        )

        XCTAssertEqual(file.filename, "secret .txt")
        XCTAssertEqual(file.contentType, "application/octet-stream")
    }

    func testFileDownloadBoundsUnicodeFilenameByUTF8BytesAndKeepsExtension() async throws {
        ShareRequestStub.responseBody = Data([1])
        let encodedEmoji = String(repeating: "%F0%9F%93%84", count: 100)
        ShareRequestStub.responseHeaders = [
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename*=UTF-8''\(encodedEmoji).pdf",
        ]

        let file = try await client.downloadFile(
            threadId: "thread-1",
            messageId: "message-1",
            path: "/Users/test/fallback.pdf"
        )

        XCTAssertLessThanOrEqual(file.filename.utf8.count, 180)
        XCTAssertTrue(file.filename.hasSuffix(".pdf"))
    }

    func testFileDownloadRejectsUnsafeRequestBeforeNetworking() async {
        do {
            _ = try await client.downloadFile(
                threadId: "../thread",
                messageId: "message-1",
                path: "relative/report.md"
            )
            XCTFail("expected local route rejection")
        } catch APIError.badURL {
            XCTAssertNil(ShareRequestStub.capturedRequest)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testFileDownloadAllowsScopedRelativeMarkdownTargets() async throws {
        ShareRequestStub.responseBody = Data("# Report".utf8)
        ShareRequestStub.responseHeaders = [
            "Content-Type": "text/markdown",
            "Content-Disposition": "attachment; filename=report.md",
        ]

        _ = try await client.downloadFile(
            threadId: "thread-1",
            messageId: "message-1",
            path: "docs/Quarter%20Report.md?download=1#latest"
        )

        let body = try XCTUnwrap(ShareRequestStub.capturedBody)
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: body) as? [String: String],
            ["path": "docs/Quarter Report.md"]
        )
    }

    func testFileDownloadRejectsOversizedDeclaredResponse() async {
        ShareRequestStub.responseBody = Data([1])
        ShareRequestStub.responseHeaders = [
            "Content-Type": "text/plain",
            "Content-Length": String(CompanionClient.maximumFileDownloadBytes + 1),
        ]

        do {
            _ = try await client.downloadFile(
                threadId: "thread-1",
                messageId: "message-1",
                path: "/Users/test/large.txt"
            )
            XCTFail("expected declared size rejection")
        } catch {
            XCTAssertNotNil(ShareRequestStub.capturedRequest)
        }
    }
}
