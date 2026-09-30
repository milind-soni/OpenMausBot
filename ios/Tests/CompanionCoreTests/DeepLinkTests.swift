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
            URL(string: "openmausbot://pair"), // a pair link with nothing in it
            URL(string: "https://example.com/about"), // a web page, not a link
            URL(string: "mausbot://chat/t-1"), // wrong scheme
        ].compactMap { $0 }
        for url in junk {
            XCTAssertNil(CompanionDeepLink.parse(url), url.absoluteString)
        }
    }
}
