import Foundation
import XCTest
@testable import CompanionCore

final class FailoverTests: XCTestCase {
    // MARK: - CandidateRotation

    func testWalksTheCandidatesInOrderAndWraps() {
        var rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"])
        XCTAssertEqual(rotation.current, "mac.tail1234.ts.net")
        XCTAssertEqual(rotation.advance(), "192.168.1.42")
        XCTAssertEqual(rotation.advance(), "openmausbot-aa.local")
        // Wraps rather than giving up: the retry loop backs off between laps,
        // and a network that comes back deserves another try at the front.
        XCTAssertEqual(rotation.advance(), "mac.tail1234.ts.net")
    }

    func testPromotesTheWorkingCandidateToTheFront() {
        var rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"])
        rotation.advance() // the tailnet name failed; the LAN address carried a stream
        XCTAssertEqual(rotation.promoted(), ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])
    }

    func testPromotionWithoutAWalkChangesNothing() {
        let rotation = CandidateRotation(hosts: ["mac.tail1234.ts.net", "192.168.1.42"])
        XCTAssertEqual(rotation.promoted(), ["mac.tail1234.ts.net", "192.168.1.42"])
    }

    func testSurvivesAnEmptyCandidateList() {
        // A real connection never produces one, but the type must not trap.
        var rotation = CandidateRotation(hosts: [])
        XCTAssertEqual(rotation.current, "")
        XCTAssertEqual(rotation.advance(), "")
        XCTAssertEqual(rotation.promoted(), [])
    }

    // MARK: - Which failures move the dial

    func testRotatesOnAddressFailuresAndNothingElse() {
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.cannotFindHost)) // -1003
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.cannotConnectToHost)) // -1004
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.timedOut)) // -1001
        XCTAssertTrue(ConnectionAdvice.shouldTryAnotherHost(.secureConnectionFailed)) // -1200

        // Offline fails on every address, and cancellation is deliberate.
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.notConnectedToInternet)) // -1009
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.cancelled))
        XCTAssertFalse(ConnectionAdvice.shouldTryAnotherHost(.networkConnectionLost))
    }

    // MARK: - The advice strings

    func testUnresolvedHostNamesTheTailnetPossibility() {
        let message = ConnectionAdvice.message(for: .cannotFindHost, host: "mac.tail1234.ts.net", port: 8810)
        XCTAssertTrue(message.contains("mac.tail1234.ts.net"))
        XCTAssertTrue(message.contains("tailnet"))
        XCTAssertTrue(message.contains("retrying automatically"))
    }

    func testRefusedConnectionPointsAtTheCompanionToggle() {
        let message = ConnectionAdvice.message(for: .cannotConnectToHost, host: "192.168.1.42", port: 8810)
        XCTAssertTrue(message.contains("port 8810"))
        XCTAssertTrue(message.contains("Settings → Companion"))
    }

    func testTimeoutBlamesTheRouteNotTheApp() {
        let message = ConnectionAdvice.message(for: .timedOut, host: "192.168.1.42", port: 8810)
        XCTAssertTrue(message.contains("No route"))
        XCTAssertTrue(message.contains("firewall"))
    }

    func testOfflineSaysOffline() {
        XCTAssertTrue(ConnectionAdvice.message(for: .notConnectedToInternet, host: "x", port: 8810)
            .contains("You're offline."))
    }

    func testAdviceNamesTheCandidateBeingTriedNext() {
        let message = ConnectionAdvice.message(
            for: .cannotFindHost,
            host: "mac.tail1234.ts.net",
            port: 8810,
            tryingNext: "192.168.1.42"
        )
        XCTAssertTrue(message.contains("Trying 192.168.1.42 next."))
    }

    // MARK: - Connection candidate helpers

    func testOrderedHostsLeadsWithTheStoredHostAndDeduplicates() {
        let connection = Connection(
            name: "Mac",
            host: "192.168.1.42",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"]
        )
        XCTAssertEqual(connection.orderedHosts, ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])
    }

    func testOrderedHostsFallsBackToTheSingleStoredHost() {
        // A connection saved before fallbacks existed still dials.
        let connection = Connection(name: "Mac", host: "mac.tail1234.ts.net", port: 8810)
        XCTAssertEqual(connection.orderedHosts, ["mac.tail1234.ts.net"])
    }

    func testDialingSwapsTheHostWithoutTouchingTheStoredOrder() {
        let connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42"]
        )
        let dialed = connection.dialing("192.168.1.42")
        XCTAssertEqual(dialed.host, "192.168.1.42")
        XCTAssertEqual(dialed.baseURL?.absoluteString, "http://192.168.1.42:8810")
        XCTAssertEqual(dialed.hosts, connection.hosts)
        XCTAssertEqual(dialed.id, connection.id) // same pairing, same keychain entry
    }

    func testPromoteReordersAndKeepsEveryCandidate() {
        var connection = Connection(
            name: "Mac",
            host: "mac.tail1234.ts.net",
            port: 8810,
            hosts: ["mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"]
        )
        connection.promote("192.168.1.42")
        XCTAssertEqual(connection.host, "192.168.1.42")
        XCTAssertEqual(connection.hosts, ["192.168.1.42", "mac.tail1234.ts.net", "openmausbot-aa.local"])

        // A hand-typed address the list has never seen joins at the front —
        // the stored fallbacks remain worth walking behind it.
        connection.promote("10.0.0.7")
        XCTAssertEqual(connection.hosts?.first, "10.0.0.7")
        XCTAssertEqual(connection.hosts?.count, 4)
    }
}
