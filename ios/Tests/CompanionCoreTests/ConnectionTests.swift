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

        let hosted = Connection.parse("https://companion.example.com")
        XCTAssertEqual(hosted?.host, "companion.example.com")
        XCTAssertEqual(hosted?.port, 443)
        XCTAssertEqual(hosted?.baseURL?.absoluteString, "https://companion.example.com")

        let tailnet = Connection.parse("http://macbook.tailnet.ts.net:8810")
        XCTAssertEqual(tailnet?.activeEndpoint?.kind, .tailnet)
        XCTAssertTrue(tailnet?.activeEndpoint?.protectsCredentials == true)
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
        let secretKey = "BIPBQ12_dWnF1DZLsTZO3Vg0NGjds5-jp9h3jhjr2To7bJelczS0LM82rfXV68PmSJhz2ePosj3fL974XckCpDU"
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&token=\(token)&code=004209&name=Milind%27s%20Mac&secretKey=\(secretKey)"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.host, "macbook.tail1234.ts.net")
        XCTAssertEqual(invite.connection.port, 8810)
        XCTAssertEqual(invite.connection.name, "Milind's Mac")
        XCTAssertEqual(invite.connection.secretPublicKey, secretKey)
        XCTAssertEqual(invite.credential, token)
    }

    func testRejectsAPresentButInvalidSecureEntryKey() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let invalid = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=mac.local&token=\(token)&secretKey=not-a-p256-key"))
        XCTAssertNil(PairingInvite.parse(invalid))
    }

    func testPairingConsentShowsNormalizedOriginInsteadOfTrustingQRName() throws {
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=https%3A%2F%2FOTHER.Example%3A9443%2F" +
            "&code=004209&name=Milind%27s%20Mac"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))

        XCTAssertEqual(invite.connection.name, "Milind's Mac")
        XCTAssertEqual(invite.connection.pairingConsentOrigin, "https://other.example:9443")
        XCTAssertFalse(invite.connection.pairingConsentOrigin.contains("004209"))
    }

    func testPairingConsentNormalizesLegacyDNSAndIPv6Origins() throws {
        let tailnet = try XCTUnwrap(Connection.parse("MacBook.Tail1234.TS.NET"))
        XCTAssertEqual(
            tailnet.pairingConsentOrigin,
            "http://macbook.tail1234.ts.net:8810"
        )

        let ipv6 = try XCTUnwrap(Connection.parse("[2001:DB8::1]:9910"))
        XCTAssertEqual(ipv6.pairingConsentOrigin, "http://[2001:db8::1]:9910")
    }

    func testParsesAnOlderCodeOnlyPairingInvite() throws {
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.credential, "004209")
        XCTAssertEqual(invite.connection.allowedRouteKinds, [.bonjour, .hosted])
        XCTAssertEqual(invite.connection.allowedLocalRouteURLs, ["http://mac.local:8810"])
    }

    func testLegacyTailnetInviteDropsUnselectedLocalFallbackKinds() throws {
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&code=004209" +
            "&hosts=macbook.tail1234.ts.net,192.168.1.42,openmausbot-aa.local"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.hosts, ["macbook.tail1234.ts.net"])
        XCTAssertEqual(invite.connection.allowedRouteKinds, [.tailnet, .hosted])
        XCTAssertEqual(invite.connection.allowedLocalRouteURLs, [])
    }

    func testHostedTypedInviteCannotRetainDirectFallbacks() throws {
        let routes = [
            ["url": "http://192.168.1.42:8810", "kind": "lan", "priority": 200] as [String: Any],
            ["url": "https://mac.companion.example", "kind": "hosted", "priority": 0] as [String: Any],
            ["url": "http://mac.tail1234.ts.net:8810", "kind": "tailnet", "priority": 100] as [String: Any],
        ]
        let encoded = try Self.base64URL(JSONSerialization.data(withJSONObject: routes))
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=192.168.1.42%3A8810&token=\(token)&endpoints=\(encoded)"))

        let invite = try XCTUnwrap(PairingInvite.parse(url))

        XCTAssertEqual(invite.connection.baseURL?.absoluteString, "https://mac.companion.example")
        XCTAssertEqual(invite.connection.activeEndpoint?.kind, .hosted)
        XCTAssertEqual(invite.connection.orderedEndpoints.map(\.kind), [.hosted])
        XCTAssertEqual(invite.connection.orderedEndpoints.map(\.priority), [0])
        XCTAssertEqual(invite.connection.allowedRouteKinds, [.hosted])
        XCTAssertEqual(invite.connection.allowedLocalRouteURLs, [])
    }

    func testRejectsMalformedOrDowngradedTypedEndpoints() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        for routes in [
            [["url": "http://public.example", "kind": "hosted", "priority": 0]],
            [["url": "https://user:secret@public.example", "kind": "hosted", "priority": 0]],
            [["url": "https://public.example/path", "kind": "hosted", "priority": 0]],
        ] {
            let encoded = try Self.base64URL(JSONSerialization.data(withJSONObject: routes))
            let url = try XCTUnwrap(URL(string:
                "openmausbot://pair?address=192.168.1.42%3A8810&token=\(token)&endpoints=\(encoded)"))
            XCTAssertNil(PairingInvite.parse(url))
        }
        let invalidBase64 = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=192.168.1.42%3A8810&token=\(token)&endpoints=not-json"))
        XCTAssertNil(PairingInvite.parse(invalidBase64))
    }

    func testSanitizesFallbackHostsAndKeepsOnlyTheConfirmedLocalOrigin() throws {
        // Fallbacks are advisory: a bad one costs a single failed dial when
        // its turn comes, so it is filtered rather than fatal.
        let url = try XCTUnwrap(URL(string:
            "openmausbot://pair?address=mac.local&code=004209&hosts=%20mac.local%20,other.local,,bad%2Fslash,has%20space"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.hosts, ["mac.local"])

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
        XCTAssertNil(saved.allowedRouteKinds)
        XCTAssertNil(saved.allowedLocalRouteURLs)
        XCTAssertNil(saved.secretPublicKey)
        XCTAssertNil(saved.companionDeviceId)
        XCTAssertEqual(saved.orderedHosts, ["mac.tail1234.ts.net"])
    }

    func testRouteConsentPolicyPersistsAcrossEncoding() throws {
        var connection = try XCTUnwrap(Connection.parse("mac.tail1234.ts.net"))
        connection.establishRoutePolicyFromInvite()

        let restored = try JSONDecoder().decode(
            Connection.self,
            from: JSONEncoder().encode(connection)
        )

        XCTAssertEqual(restored.allowedRouteKinds, [.tailnet, .hosted])
        XCTAssertEqual(restored.allowedLocalRouteURLs, [])
        XCTAssertEqual(restored.automaticEndpoints.map(\.kind), [.tailnet])
    }

    func testAPairResponseWithAndWithoutHostsDecodes() throws {
        let older = Data(#"{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(PairResponse.self, from: older).hosts)

        let newer = Data(#"{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["a.ts.net","192.168.1.42"]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(PairResponse.self, from: newer).hosts, ["a.ts.net", "192.168.1.42"])

        let typed = Data(#"{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","endpoints":[{"url":"https://mac.example","kind":"hosted","priority":0}]}"#.utf8)
        let response = try JSONDecoder().decode(PairResponse.self, from: typed)
        XCTAssertEqual(response.endpoints?.first?.url, "https://mac.example")
        XCTAssertEqual(response.endpoints?.first?.kind, .hosted)
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

    private static func base64URL(_ data: Data) throws -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
