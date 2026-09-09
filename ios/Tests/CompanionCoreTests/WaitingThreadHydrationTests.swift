import Foundation
import XCTest
@testable import CompanionCore

private final class WaitingThreadStub: URLProtocol {
    static var responses: [String: (Int, Data)] = [:]
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let (status, body) = Self.responses[request.url!.path] ?? (404, Data())
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class WaitingThreadHydrationTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        WaitingThreadStub.requests = []
        WaitingThreadStub.responses = [
            "/api/bots": (200, Data(Self.fleetJSON.utf8)),
            "/api/threads/thread-a/messages": (200, Data(Self.pendingPage.utf8)),
        ]
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WaitingThreadStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Fixture", host: "127.0.0.1", port: 8810),
            token: "fixture-token", session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testColdHydrationFindsBackgroundApprovalWithoutOpeningItsThread() async throws {
        let snapshot = try await client.fleetForHydration(messages: 50)
        var state = CompanionState()
        state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads)
        XCTAssertEqual(state.bot("bot-1")?.threadId, "thread-b")
        XCTAssertEqual(state.pendingApprovals.map(\.threadId), ["thread-a"])
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["approval-a"])
        XCTAssertEqual(WaitingThreadStub.requests.map { $0.url!.path }, [
            "/api/bots", "/api/threads/thread-a/messages",
        ], "Only the waiting background thread needs a bounded page, not every task.")
        let pageRequest = try XCTUnwrap(WaitingThreadStub.requests.last)
        XCTAssertEqual(pageRequest.httpMethod, "GET")
        XCTAssertEqual(pageRequest.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
        XCTAssertEqual(URLComponents(url: pageRequest.url!, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "limit", value: "50")])
        XCTAssertEqual(state.hasMore["thread-a"], true)
        XCTAssertEqual(state.activeLeafIds["thread-a"], "approval-a")
    }

    func testAnotherDeviceAnswersWhileTheBackgroundPageIsLoading() async throws {
        WaitingThreadStub.responses["/api/threads/thread-a/messages"] = (200, Data(
            Self.pendingPage.replacingOccurrences(of: "\"tool\":\"Bash\"", with: "\"tool\":\"Bash\",\"answered\":\"Allow\"").utf8
        ))
        let snapshot = try await client.fleetForHydration()
        var state = CompanionState()
        state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads)
        XCTAssertTrue(state.pendingApprovals.isEmpty, "The fresh page, not the older activity label, decides whether a card is actionable.")
    }

    func testLateSnapshotCannotOverwriteAnApprovalResolvedByTheLiveStream() async throws {
        let snapshot = try await client.fleetForHydration()
        var state = CompanionState()
        state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads)
        state.resetCursor("stream:1")
        let expectedCursor = state.cursor

        // A notification refresh captured this page before the live stream
        // answered the request. Its slower response must not revive the card.
        var resolved = try XCTUnwrap(state.pendingApprovals.first?.message)
        resolved.card?.answered = "Allow"
        state.apply(.messagePatch(threadId: "thread-a", message: resolved))
        state.advance(to: 2)
        XCTAssertFalse(state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads,
                                     ifCursorMatches: expectedCursor))

        XCTAssertEqual(state.cursor, "stream:2")
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        XCTAssertEqual(state.transcript(forThread: "thread-a").last?.card?.answered, "Allow")

        // A bounded retry against the new cursor may now commit the fresh,
        // answered page without losing or replaying the stream's progress.
        WaitingThreadStub.responses["/api/threads/thread-a/messages"] = (200, Data(
            Self.pendingPage.replacingOccurrences(of: "\"tool\":\"Bash\"", with: "\"tool\":\"Bash\",\"answered\":\"Allow\"").utf8
        ))
        let retryCursor = state.cursor
        let fresh = try await client.fleetForHydration()
        XCTAssertTrue(state.hydrate(fresh.fleet, waitingThreads: fresh.waitingThreads,
                                    ifCursorMatches: retryCursor))
        XCTAssertEqual(state.cursor, "stream:2")
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        XCTAssertEqual(state.transcript(forThread: "thread-a").last?.card?.answered, "Allow")
    }

    func testColdSnapshotAcceptsANilCursorButCannotOverwriteANewerHello() async throws {
        let snapshot = try await client.fleetForHydration()
        var state = CompanionState()
        XCTAssertTrue(state.hydrate(snapshot.fleet, waitingThreads: snapshot.waitingThreads,
                                   ifCursorMatches: nil))
        state.resetCursor("stream:0")
        XCTAssertFalse(state.hydrate(Fleet(bots: [], groups: []), ifCursorMatches: nil))
        XCTAssertEqual(state.pendingApprovals.map(\.threadId), ["thread-a"])
        XCTAssertEqual(state.cursor, "stream:0")
    }

    func testReconnectDoesNotKeepAStaleBackgroundApproval() async throws {
        let first = try await client.fleetForHydration()
        var state = CompanionState()
        state.hydrate(first.fleet, waitingThreads: first.waitingThreads)
        XCTAssertEqual(state.pendingApprovals.count, 1)

        WaitingThreadStub.requests = []
        WaitingThreadStub.responses["/api/bots"] = (200, Data(
            Self.fleetJSON.replacingOccurrences(of: "waiting-on-you", with: "idle").utf8
        ))
        let refreshed = try await client.fleetForHydration()
        state.hydrate(refreshed.fleet, waitingThreads: refreshed.waitingThreads)
        XCTAssertTrue(state.pendingApprovals.isEmpty)
        XCTAssertNil(state.messages["thread-a"])
        XCTAssertEqual(WaitingThreadStub.requests.map { $0.url!.path }, ["/api/bots"])
    }

    func testPageFailureDoesNotCommitAPartialSnapshotOrAdvanceTheCursor() async throws {
        let first = try await client.fleetForHydration()
        var state = CompanionState()
        state.hydrate(first.fleet, waitingThreads: first.waitingThreads)
        state.resetCursor("before-refresh")
        WaitingThreadStub.responses["/api/threads/thread-a/messages"] = (503, Data(#"{"error":"offline"}"#.utf8))
        do {
            let refreshed = try await client.fleetForHydration()
            state.hydrate(refreshed.fleet, waitingThreads: refreshed.waitingThreads)
            state.resetCursor("incomplete-refresh")
            XCTFail("A missing pending page must not look like a successful empty inbox.")
        } catch APIError.status(let code, _) {
            XCTAssertEqual(code, 503)
        }
        XCTAssertEqual(state.cursor, "before-refresh")
        XCTAssertEqual(state.pendingApprovals.map(\.message.id), ["approval-a"])
    }

    func testOlderComputersWithoutTaskActivityStillHydrate() async throws {
        WaitingThreadStub.responses["/api/bots"] = (200, Data(
            Self.fleetJSON.replacingOccurrences(of: ",\"activity\":\"waiting-on-you\"", with: "").utf8
        ))
        let snapshot = try await client.fleetForHydration()
        XCTAssertEqual(snapshot.fleet.bots.count, 1)
        XCTAssertTrue(snapshot.waitingThreads.isEmpty)
        XCTAssertEqual(WaitingThreadStub.requests.map { $0.url!.path }, ["/api/bots"])
    }

    func testCancelledHydrationDoesNotStartRequests() async throws {
        let client = try XCTUnwrap(client)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.fleetForHydration()
        }
        do {
            _ = try await task.value
            XCTFail("Cancelled refresh must not publish another computer's state.")
        } catch is CancellationError {}
        XCTAssertTrue(WaitingThreadStub.requests.isEmpty)
    }

    private static let fleetJSON = #"""
    {"bots":[{
      "id":"bot-1","threadId":"thread-b","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue","unread":true,
      "modelSelection":{"instanceId":"codex","model":"default"},"createdAt":1,"busy":true,
      "tasks":[
        {"threadId":"thread-a","title":"A","createdAt":1,"activity":"waiting-on-you","busy":true},
        {"threadId":"thread-b","title":"B","createdAt":2,"activity":"working","busy":true},
        {"threadId":"thread-idle","title":"Idle","createdAt":3,"activity":"idle","busy":false},
        {"threadId":"thread-running","title":"Running","createdAt":4,"activity":"working","busy":true}
      ],
      "messages":[{"id":"selected","role":"user","kind":"text","at":1,"text":"Current thread"}]
    }],"groups":[]}
    """#

    private static let pendingPage = #"""
    {"messages":[
      {"id":"root-a","role":"user","kind":"text","at":1,"text":"Run task A"},
      {"id":"approval-a","role":"bot","kind":"options","parentId":"root-a","at":2,
       "card":{"title":"Approval needed","subtitle":"Run task A","options":["Allow","Deny"],"requestId":"request-a","tool":"Bash"}}
    ],"hasMore":true,"activeLeafId":"approval-a"}
    """#
}
