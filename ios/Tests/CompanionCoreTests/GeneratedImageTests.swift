import Foundation
import XCTest
@testable import CompanionCore

final class GeneratedImageTests: XCTestCase {
    func testGeneratedImagesSurviveMessageDecodeAndCacheRoundTrip() throws {
        let source = #"{"id":"reply","role":"bot","kind":"text","at":1,"text":"Screenshot attached","attachments":[{"kind":"image","path":"/tmp/screenshot.png","mime":"image/png"}]}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(source.utf8))
        let stored = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as! [String: Any]
        let attachments = stored["attachments"] as? [[String: String]]
        XCTAssertEqual(attachments?.first?["path"], "/tmp/screenshot.png")
    }

    func testImageOnlyPatchPreservesImagesAndIgnoresFutureKinds() throws {
        let source = #"{"id":"reply","role":"bot","kind":"text","at":1,"attachments":[{"kind":"video"},{"kind":"image","path":"/tmp/screen 100%.png","mime":"image/png"},{"kind":"image","path":"/tmp/screen 100%.png"},{"kind":"image","path":" "}]}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(source.utf8))
        var state = CompanionState()
        state.apply(.message(threadId: "thread", message: Message(id: "reply", role: .bot, kind: .text, at: 1)))
        state.apply(.messagePatch(threadId: "thread", message: message))
        let patched = try XCTUnwrap(state.transcript(forThread: "thread").first)
        XCTAssertEqual(patched.generatedImages, [DisplayedMessageAttachment(kind: .image, path: "/tmp/screen 100%.png", name: "screen 100%.png")])
        XCTAssertNil(patched.text)
    }

    func testLegacyTextHasNoGeneratedImages() throws {
        let message = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"old","role":"bot","kind":"text","at":1,"text":"Still visible"}"#.utf8))
        XCTAssertTrue(message.generatedImages.isEmpty)
        XCTAssertEqual(message.text, "Still visible")
    }
}
