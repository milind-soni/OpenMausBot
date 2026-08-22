import XCTest
@testable import CompanionCore

final class ConnectionTests: XCTestCase {
    func testParsesHostnamesAndPorts() {
        let implicit = Connection.parse("macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.host, "macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.port, 8810)

        let explicit = Connection.parse("http://192.168.1.42:9910/")
        XCTAssertEqual(explicit?.host, "192.168.1.42")
        XCTAssertEqual(explicit?.port, 9910)
    }

    func testParsesIPv6WithAndWithoutAnExplicitPort() {
        let bare = Connection.parse("2001:db8::1")
        XCTAssertEqual(bare?.host, "[2001:db8::1]")
        XCTAssertEqual(bare?.port, 8810)
        XCTAssertEqual(bare?.baseURL?.absoluteString, "http://[2001:db8::1]:8810")

        let explicit = Connection.parse("[2001:db8::1]:9910")
        XCTAssertEqual(explicit?.host, "[2001:db8::1]")
        XCTAssertEqual(explicit?.port, 9910)
        XCTAssertEqual(explicit?.baseURL?.absoluteString, "http://[2001:db8::1]:9910")
    }

    func testRetainsTheScopeZoneOnLinkLocalIPv6() {
        let connection = Connection.parse("[fe80::1%en0]:8810")
        XCTAssertEqual(connection?.host, "[fe80::1%en0]")
        XCTAssertEqual(connection?.baseURL?.absoluteString, "http://[fe80::1%25en0]:8810")
    }

    func testDropsTheInterfaceScopeFromAResolvedIPv4Address() {
        // NWEndpoint.Host prints a resolved IPv4 with the interface it came
        // in on ("192.168.1.3%en0"). A zone means nothing for IPv4 and
        // URLComponents refuses it as a host — which turned Bonjour discovery
        // in the Simulator into "That address doesn't look right".
        let discovered = Connection(name: "Mac", host: "192.168.1.3%en0", port: 8810)
        XCTAssertEqual(discovered.host, "192.168.1.3")
        XCTAssertEqual(discovered.baseURL?.absoluteString, "http://192.168.1.3:8810")
        // an IPv6 zone is still kept — link-local needs it
        XCTAssertEqual(Connection(name: "Mac", host: "fe80::1%en0", port: 8810).host, "[fe80::1%en0]")
    }

    func testAnOlderSavedIPv6ConnectionIsNormalizedWhenUsed() throws {
        let data = Data(#"{"id":"saved","name":"Mac","host":"::1","port":8810}"#.utf8)
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertEqual(saved.baseURL?.absoluteString, "http://[::1]:8810")
    }

    func testRejectsAmbiguousOrUnsafeAddresses() {
        XCTAssertNil(Connection.parse("host:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:70000"))
        XCTAssertNil(Connection.parse("host/path"))
        XCTAssertNil(Connection.parse("host name"))
    }

    func testParsesADesktopPairingInvite() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&token=\(token)&code=004209&name=Milind%27s%20Mac"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.host, "macbook.tail1234.ts.net")
        XCTAssertEqual(invite.connection.port, 8810)
        XCTAssertEqual(invite.connection.name, "Milind's Mac")
        XCTAssertEqual(invite.credential, token)
    }

    func testParsesAnOlderCodeOnlyPairingInvite() throws {
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209"))
        XCTAssertEqual(PairingInvite.parse(url)?.credential, "004209")
    }

    func testCarriesTheFallbackHostsFromTheInvite() throws {
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&code=004209" +
            "&hosts=macbook.tail1234.ts.net,192.168.1.42,openmausbot-aa.local"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.hosts, ["macbook.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"])
    }

    func testDropsUnusableFallbackHostsWithoutRefusingTheInvite() throws {
        // Fallbacks are advisory: a bad one costs a single failed dial when
        // its turn comes, so it is filtered rather than fatal.
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=mac.local&code=004209&hosts=%20192.168.1.42%20,,bad%2Fslash,has%20space"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.hosts, ["192.168.1.42"])

        // and an invite with no usable candidate keeps the single address
        let empty = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209&hosts=bad%2Fslash"))
        XCTAssertNil(PairingInvite.parse(empty)?.connection.hosts)
    }

    func testASavedConnectionWithoutFallbacksStillDecodes() throws {
        // Exactly what UserDefaults holds for anyone who paired before
        // fallback hosts existed — `hosts` must stay optional forever.
        let data = Data(#"{"id":"saved","name":"Mac","host":"mac.tail1234.ts.net","port":8810}"#.utf8)
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertNil(saved.hosts)
        XCTAssertEqual(saved.orderedHosts, ["mac.tail1234.ts.net"])
    }

    func testAPairResponseWithAndWithoutHostsDecodes() throws {
        let older = Data(#"{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(PairResponse.self, from: older).hosts)

        let newer = Data(#"{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["a.ts.net","192.168.1.42"]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(PairResponse.self, from: newer).hosts, ["a.ts.net", "192.168.1.42"])
    }

    func testRejectsAnUntrustedOrMalformedPairingInvite() throws {
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "https://example.com/pair?address=mac.local&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=12345"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=weak"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&token=weak&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=host%2Fpath&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "openmausbot://pair?address=one.local&address=two.local&code=123456"))))
    }

    func testAcceptsOnlyAnHTTPSCloudDesktopSession() throws {
        let valid = Data(#"{"joinUrl":"https://desktop.example/session/fresh","state":"ready"}"#.utf8)
        let session = try JSONDecoder().decode(CloudDesktopSession.self, from: valid)
        XCTAssertEqual(session.url.absoluteString, "https://desktop.example/session/fresh")

        for value in [
            "http://desktop.example/session",
            "javascript:alert(1)",
            "not a URL"
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["joinUrl": value])
            XCTAssertThrowsError(try JSONDecoder().decode(CloudDesktopSession.self, from: data))
        }
    }
}
