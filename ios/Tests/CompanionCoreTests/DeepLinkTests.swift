// The openmausbot:// scheme's vocabulary. Pairing was its only word;
// these tests pin it exactly as ConnectionTests shaped it, beside the
// chat route home-screen widgets will emit.
import XCTest
@testable import CompanionCore

final class DeepLinkTests: XCTestCase {
    func testParsesADesktopPairingInvite() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=macbook.tail1234.ts.net%3A8810&token=\(token)&code=004209&name=Milind%27s%20Mac"))
        guard case let .pairing(invite) = CompanionDeepLink.parse(url) else {
            return XCTFail("expected a pairing link")
        }
        XCTAssertEqual(invite.connection.host, "macbook.tail1234.ts.net")
        XCTAssertEqual(invite.connection.port, 8810)
        XCTAssertEqual(invite.connection.name, "Milind's Mac")
        XCTAssertEqual(invite.credential, token)
    }

    // Oct 3: an Android phone showed "Miguel's+computer", and iOS read the same link the
    // same way. Desktops before Oct 2026 wrote it with URLSearchParams, which encodes a space
    // as "+"; every builder writes a real "+" as %2B.
    func testAPlusInAPairingInviteIsASpaceAndAnEncodedPlusIsAPlus() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "openmausbot://pair?address=192.168.1.34%3A8810&token=\(token)&name=Miguel%27s+computer"))
        guard case let .pairing(invite) = CompanionDeepLink.parse(url) else {
            return XCTFail("expected a pairing link")
        }
        XCTAssertEqual(invite.connection.name, "Miguel's computer")

        let plus = try XCTUnwrap(URL(string: "openmausbot://pair?address=mac.local&code=004209&name=C%2B%2B+box"))
        XCTAssertEqual(PairingInvite.parse(plus)?.connection.name, "C++ box")
    }

    func testParsesAServerPairLink() throws {
        let url = try XCTUnwrap(URL(string: "https://bot.example/pair#code=ABCD-EFGH-JKLM"))
        guard case let .pairing(invite) = CompanionDeepLink.parse(url) else {
            return XCTFail("expected a server pairing link")
        }
        XCTAssertEqual(invite.connection.host, "bot.example")
        XCTAssertEqual(invite.credential, "ABCDEFGHJKLM")
    }

    func testParsesAChatLink() throws {
        let url = try XCTUnwrap(URL(string: "openmausbot://chat/t-9f2c"))
        XCTAssertEqual(CompanionDeepLink.parse(url), .chat(threadId: "t-9f2c"))
    }

    func testDecodesAPercentEncodedChatId() throws {
        let url = try XCTUnwrap(URL(string: "openmausbot://chat/task%20one"))
        XCTAssertEqual(CompanionDeepLink.parse(url), .chat(threadId: "task one"))
    }

    func testJunkAndIncompleteLinksAreIgnored() throws {
        let junk = [
            URL(string: "openmausbot://chat"), // no id
            URL(string: "openmausbot://chat/"), // empty id
            URL(string: "openmausbot://chat/a/b"), // more than the id
            URL(string: "openmausbot://chat/abc%2Fdef"), // an id smuggling a path separator
            URL(string: "openmausbot://other/t-1"), // a host we never emit
            URL(string: "https://example.com/about"), // a web page, not a link
            URL(string: "mausbot://chat/t-1"), // wrong scheme
        ].compactMap { $0 }
        for url in junk {
            XCTAssertNil(CompanionDeepLink.parse(url), url.absoluteString)
        }
    }

    /// MOCA-248: links the desktop emits for itself — a thread reference out
    /// of chat markdown, Cloud's "Open in the app" — used to raise "That
    /// pairing invitation is not valid". They are not this app's to open.
    func testTheDesktopsOwnLinksAreIgnoredNotRefused() throws {
        let desktop = [
            URL(string: "openmausbot://thread/t-9f2c?bot=b-1"),
            URL(string: "openmausbot://cloud"),
            URL(string: "openmausbot://organization"),
            URL(string: "openmausbot://install?url=https://github.com/x/y"),
        ].compactMap { $0 }
        XCTAssertEqual(desktop.count, 4)
        for url in desktop {
            XCTAssertNil(CompanionDeepLink.parse(url), url.absoluteString)
        }
    }

    /// A pair link that does not parse is still someone trying to pair, so it
    /// is told apart from a link the app does not know.
    func testAPairLinkThatDoesNotParseIsAnInvalidPairing() throws {
        let broken = [
            URL(string: "openmausbot://pair"), // nothing in it
            URL(string: "openmausbot://pair?address=macbook.local%3A8810"), // no credential
            URL(string: "openmausbot://pair?address=macbook.local%3A8810&token=omb_pair_short"), // a truncated token
            URL(string: "openmausbot://pair?token=omb_pair_" + String(repeating: "a", count: 43)), // no address
            URL(string: "OPENMAUSBOT://PAIR?code=12"), // any case
        ].compactMap { $0 }
        XCTAssertEqual(broken.count, 5)
        for url in broken {
            XCTAssertEqual(CompanionDeepLink.parse(url), .invalidPairing, url.absoluteString)
        }
    }
}
