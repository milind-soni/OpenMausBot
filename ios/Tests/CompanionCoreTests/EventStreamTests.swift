// The event stream against a real URLSession.
//
// This file exists because of two bugs that shipped past every other test
// here, both in the few lines between "URLSession has bytes" and "the app
// has frames":
//
//   1. `request.timeoutInterval = .greatestFiniteMagnitude` — reads as
//      "never time out", actually produces a request that opens and then
//      delivers nothing.
//   2. Keeping only the line iterator and letting `URLSession.AsyncBytes`
//      go out of scope — AsyncBytes cancels its data task when released,
//      so the connection died after the first frame.
//   3. Reading with `bytes.lines`, which folds consecutive newlines into
//      one separator and so never reports the blank line that terminates
//      an SSE event. Zero frames, no error, connection healthy at both
//      ends.
//
// Both need a real URLSession to reproduce: the parser tests pass either
// way, because the parser was never wrong. A stub protocol that delivers
// chunks *over time* is the smallest thing that catches this class — the
// symptom of both bugs is a stream that stops early.
import XCTest
@testable import CompanionCore

/// A fake origin server that dribbles out an SSE response.
///
/// "Has this request been torn down?" is deliberately **per instance**, not
/// static. URLSession calls `stopLoading()` asynchronously, so a previous
/// test's teardown can land in the middle of the next one — which, when this
/// flag was shared, silently truncated the next test's stream and turned a
/// clean failure into an out-of-range crash.
final class StreamingStub: URLProtocol {
    /// Chunks to deliver, in order, with a small gap between them.
    static var chunks: [String] = []
    static var status = 200
    /// How many requests have been torn down — the cancellation assertion,
    /// counted rather than flagged so it cannot be reset by a straggler.
    static var stopCount = 0

    private let stopped = Stopped()

    /// A tiny box, because `stopLoading()` may be called from another thread
    /// than the one delivering chunks.
    final class Stopped {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool {
            lock.lock(); defer { lock.unlock() }
            return value
        }
        func set() {
            lock.lock(); defer { lock.unlock() }
            value = true
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)

        // Strong `self` on purpose. URLSession does not promise to keep a
        // protocol instance alive past `startLoading()` returning, and with a
        // weak capture this block woke up to a nil self and delivered nothing
        // — every test after the first one saw an empty stream. The instance
        // is the thing doing the work, so it holds itself up until done.
        let stopped = self.stopped
        DispatchQueue.global().async {
            for chunk in Self.chunks {
                // a real connection that has been cancelled delivers no more
                if stopped.isSet { return }
                self.client?.urlProtocol(self, didLoad: Data(chunk.utf8))
                Thread.sleep(forTimeInterval: 0.03)
            }
            if !stopped.isSet { self.client?.urlProtocolDidFinishLoading(self) }
        }
    }

    override func stopLoading() {
        stopped.set()
        Self.stopCount += 1
    }
}

final class EventStreamTests: XCTestCase {
    var session: URLSession!

    override func setUp() {
        super.setUp()
        StreamingStub.chunks = []
        StreamingStub.status = 200
        StreamingStub.stopCount = 0
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StreamingStub.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        // a URLSession keeps itself alive until told otherwise, and a live
        // one from a finished test has no business still holding a request
        session?.invalidateAndCancel()
        session = nil
        super.tearDown()
    }

    private var request: URLRequest {
        URLRequest(url: URL(string: "http://127.0.0.1:8800/api/events")!)
    }

    private func collect(limit: Int) async throws -> [StreamFrame] {
        var frames: [StreamFrame] = []
        for try await frame in eventStream(request: request, session: session) {
            frames.append(frame)
            if frames.count >= limit { break }
        }
        return frames
    }

    func testDeliversEveryFrameAsItArrives() async throws {
        // the shape the harness writes: hello, then frames over time
        StreamingStub.chunks = [
            "data: {\"kind\":\"hello\",\"cursor\":\"abc12345:0\",\"resumed\":false}\n\n",
            ": keepalive\n\n",
            "id: abc12345:1\ndata: {\"kind\":\"bot\",\"seq\":1,\"bot\":{\"id\":\"b1\",\"threadId\":\"t1\",\"name\":\"Scout\",\"title\":\"\",\"description\":\"\",\"notifications\":true,\"color\":\"green\",\"unread\":false,\"modelSelection\":{\"instanceId\":\"i\",\"model\":\"m\"},\"createdAt\":1}}\n\n",
            "id: abc12345:2\ndata: {\"kind\":\"message\",\"seq\":2,\"threadId\":\"t1\",\"message\":{\"id\":\"m1\",\"role\":\"user\",\"kind\":\"text\",\"at\":1,\"text\":\"hi\"}}\n\n",
        ]

        let frames = try await collect(limit: 3)

        // Three frames arriving in three separate reads is the whole
        // assertion: a cancelled-after-first-frame stream yields one. Guard
        // rather than index — a short stream is the failure under test, and
        // it should read as one instead of trapping.
        guard frames.count == 3 else {
            return XCTFail("expected 3 frames, got \(frames.count) — the stream stopped early")
        }
        guard case .hello = frames[0].frame else { return XCTFail("expected hello first") }
        guard case .bot = frames[1].frame else { return XCTFail("expected bot") }
        guard case .message = frames[2].frame else { return XCTFail("expected message") }
        XCTAssertEqual(frames[2].seq, 2)
    }

    func testSurvivesAFrameSplitAcrossReads() async throws {
        // TCP does not respect frame boundaries, and neither should we
        StreamingStub.chunks = [
            "data: {\"kind\":\"hel",
            "lo\",\"cursor\":\"abc12345:0\",\"resumed\":true}",
            "\n\n",
        ]
        let frames = try await collect(limit: 1)
        guard case let .hello(cursor, resumed) = frames.first?.frame else {
            return XCTFail("expected a hello reassembled from three reads")
        }
        XCTAssertEqual(cursor, "abc12345:0")
        XCTAssertTrue(resumed)
    }

    func testReportsAnUnauthorizedStreamRatherThanEndingQuietly() async {
        StreamingStub.status = 401
        StreamingStub.chunks = ["{\"error\":\"pair this device\"}"]
        do {
            _ = try await collect(limit: 1)
            XCTFail("a 401 must surface, not look like an empty stream")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
        } catch {
            XCTFail("expected an APIError, got \(error)")
        }
    }

    func testCancellingTheConsumerTearsDownTheRequest() async throws {
        StreamingStub.chunks = [
            "data: {\"kind\":\"hello\",\"cursor\":\"abc12345:0\",\"resumed\":false}\n\n",
            "data: {\"kind\":\"config\",\"seq\":1}\n\n",
            "data: {\"kind\":\"config\",\"seq\":2}\n\n",
        ]
        // Assert the frame arrived, not just that teardown happened: this
        // test passed for three rounds while the stream delivered nothing at
        // all, because it only ever checked the teardown half.
        let frames = try await collect(limit: 1)
        XCTAssertEqual(frames.count, 1, "the stream should have delivered its first frame")
        // give the teardown a moment to propagate through URLSession
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertGreaterThan(StreamingStub.stopCount, 0, "leaving the stream should cancel the request")
    }
}
