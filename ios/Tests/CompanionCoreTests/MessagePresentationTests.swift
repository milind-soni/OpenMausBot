import XCTest
@testable import CompanionCore

/// The transcript reads these once per message instead of per render; they
/// must say exactly what the row bodies used to work out for themselves.
final class MessagePresentationTests: XCTestCase {
    private func message(_ text: String?, role: Message.Role = .bot, kind: Message.Kind = .text) -> Message {
        Message(id: "m1", role: role, kind: kind, at: 0, text: text)
    }

    func testAFencedDiffReplyIsAPatchNamedForItsFile() {
        let patch = GitPatch(message("```diff\ndiff --git a/Sources/App.swift b/Sources/App.swift\n+let x = 1\n```"))
        XCTAssertEqual(patch?.filename, "Sources/App.swift")
        XCTAssertEqual(patch?.diff, "diff --git a/Sources/App.swift b/Sources/App.swift\n+let x = 1")
    }

    func testRawGitDiffOutputIsAPatchAsItStands() {
        let text = "diff --git a/README.md b/README.md\n-old\n+new"
        let patch = GitPatch(message("  \(text)\n"))
        XCTAssertEqual(patch?.filename, "README.md")
        XCTAssertEqual(patch?.diff, text)
    }

    func testOnlyABotReplyThatIsWhollyADiffIsAPatch() {
        XCTAssertNil(GitPatch(message("diff --git a/x b/x", role: .user)), "your own paste stays text")
        XCTAssertNil(GitPatch(message("Here is the change:\n```diff\n+a\n```")), "prose around a fence stays Markdown")
        XCTAssertNil(GitPatch(message(nil)))
    }

    func testAnEmptyFencedDiffStillNamesItself() {
        XCTAssertEqual(GitPatch(message("```diff\n```"))?.filename, "Git patch")
    }

    func testVisibleTextDropsAttachmentTagsAndKeepsTheWords() {
        let presentation = MessagePresentation(message(
            "Please look.\n\n<attached-file path=\"/tmp/a.pdf\" name=\"a.pdf\" />",
            role: .user
        ))
        XCTAssertEqual(presentation.visibleText, "Please look.")
        XCTAssertEqual(presentation.attached.attachments.map(\.name), ["a.pdf"])
        XCTAssertNil(presentation.patch)
        XCTAssertNil(presentation.webhook)
    }

    func testAWebhookShowsItsTaskNotItsEnvelope() {
        let text = """
        [AUTHENTICATED WEBHOOK TASK]
        Triage the build failure.
        [/AUTHENTICATED WEBHOOK TASK]
        [UNTRUSTED WEBHOOK EVENT DATA]
        header

        {"ok":false}
        [/UNTRUSTED WEBHOOK EVENT DATA]
        """
        let presentation = MessagePresentation(message(text, role: .user))
        XCTAssertEqual(presentation.webhook?.task, "Triage the build failure.")
        XCTAssertEqual(presentation.visibleText, "Triage the build failure.")
        XCTAssertNil(MessagePresentation(message(text, role: .bot)).webhook, "only a delivery you received is a webhook")
    }

    func testMatchesTheParsersItReplaces() {
        let source = Message(id: "m2", role: .user, kind: .text, at: 0, text: "<pasted-text index=\"1\">\nhello\n</pasted-text>")
        let presentation = MessagePresentation(source)
        XCTAssertEqual(presentation.attached, AttachedMessageContent.parse(source.text ?? ""))
        XCTAssertEqual(presentation.webhook, source.webhookContent)
    }
}
