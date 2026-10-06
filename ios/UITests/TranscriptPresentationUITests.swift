import XCTest

/// Bundled offline fleet only; no API client or paired user data.
final class TranscriptPresentationUITests: XCTestCase {
    @MainActor
    func testPastedNotesHideWrappersAndClaudeUpdateOffersManualRecovery() {
        let app = launchPreview(detail: "full", update: true)
        XCTAssertTrue(contains("The pasted notes stay visible.", in: app))
        XCTAssertFalse(contains("<pasted-text", in: app))
        XCTAssertFalse(contains("</pasted-text>", in: app))
        XCTAssertTrue(app.buttons["Update Claude for me"].waitForExistence(timeout: 5))
        app.buttons["I'll do it myself"].tap()
        XCTAssertTrue(app.staticTexts["claude update"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Copy command"].exists)
        screenshot("Pasted notes and manual Claude update recovery", in: app)
    }

    @MainActor
    func testCompactionOpensItsSummaryWithoutShowingDigest() {
        let app = launchPreview(detail: "full", receipts: true)
        let chip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Context compacted")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertFalse(contains("Digest must stay hidden", in: app))
        chip.tap()
        XCTAssertTrue(app.staticTexts["Earlier context preserved for the next turn."].waitForExistence(timeout: 3))
        screenshot("Compaction summary opened", in: app)
    }

    @MainActor
    func testSearchTargetRevealsIntermediateReply() {
        let app = launchPreview(detail: "hidden", focused: true)
        let target = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I found the failing check.")).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        XCTAssertTrue(target.isHittable)
        screenshot("Focused search result expands narration", in: app)
    }

    @MainActor
    func testHiddenFoldsNarrationAndWebhookPayloadCanBeExpanded() {
        let app = launchPreview(detail: "hidden")
        let fold = app.buttons["assistant-turn.preview-turn"]
        XCTAssertTrue(fold.waitForExistence(timeout: 5))
        XCTAssertEqual(fold.label, "Worked for 4s")
        XCTAssertTrue(app.staticTexts["The build failed because a dependency is missing."].exists)
        XCTAssertFalse(contains("Let me inspect", in: app))
        XCTAssertTrue(app.staticTexts["Triage the build failure."].exists)
        XCTAssertFalse(contains("AUTHENTICATED WEBHOOK", in: app))
        XCTAssertFalse(contains("Delivery ID", in: app))
        XCTAssertFalse(app.staticTexts["webhook-payload"].exists)
        // Pepper is still marked busy, but the turn's final reply is in:
        // nothing left to type.
        XCTAssertFalse(app.descendants(matching: .any)["typing-indicator"].exists, "a finished reply ends the typing")
        screenshot("Compact transcript with Hidden activity", in: app)

        fold.tap()
        XCTAssertTrue(contains("Let me inspect the build logs.", in: app))
        XCTAssertTrue(contains("I found the failing check.", in: app))
        screenshot("Expanded narration uses a single final bubble tail", in: app)
        fold.tap()
        XCTAssertFalse(contains("Let me inspect", in: app))

        app.buttons["Event payload"].tap()
        XCTAssertTrue(app.staticTexts["webhook-payload"].waitForExistence(timeout: 3))
        XCTAssertTrue(contains("checkout", in: app))
        screenshot("Webhook payload expanded on demand", in: app)
    }

    /// At Hidden a working bot's in-between messages are one grey status
    /// line above the composer, not bubbles (Omkar, 2026-10-03).
    @MainActor
    func testHiddenShowsLiveNarrationAsOneStatusLine() {
        let app = launchPreview(detail: "hidden", live: true)
        let line = app.descendants(matching: .any)["live-status-line"]
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertTrue(line.label.contains("The build failed because a dependency is missing."), line.label)
        XCTAssertFalse(contains("Let me inspect", in: app))
        XCTAssertFalse(app.buttons["assistant-turn.preview-turn"].exists, "nothing folds before the turn ends")
        // The dots say the bot is working; the line says what at.
        assertTypingBubbleInView(app)
        screenshot("Hidden: live narration as one status line", in: app)
    }

    /// The moment after a send: your message lands, then the turn starts and
    /// the bot's typing bubble appears under it, on screen above the composer.
    @MainActor
    func testTypingBubbleAppearsUnderYourMessageWhenTheTurnStarts() {
        for detail in ["hidden", "full"] {
            let app = launchPreview(detail: detail, typing: true)
            let sent = app.staticTexts["Can you check the Android build too?"]
            XCTAssertTrue(sent.waitForExistence(timeout: 5), detail)
            let typing = assertTypingBubbleInView(app)
            XCTAssertGreaterThanOrEqual(typing.frame.minY, sent.frame.maxY, "the bubble sits under your message (\(detail))")
            XCTAssertFalse(app.descendants(matching: .any)["live-status-line"].exists, "nothing said yet, so no status line (\(detail))")
            screenshot("Typing bubble after a send (\(detail))", in: app)
            app.terminate()
        }
    }

    @MainActor
    func testFullKeepsLiveNarrationAsBubbles() {
        let app = launchPreview(detail: "full", live: true)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Let me inspect the build logs.")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["live-status-line"].exists)
        screenshot("Full: live narration stays as bubbles", in: app)
    }

    @MainActor
    func testHiddenSuppressesLiveReasoning() {
        let app = launchPreview(detail: "hidden", reasoning: true)
        XCTAssertTrue(app.buttons["assistant-turn.preview-turn"].waitForExistence(timeout: 5))
        XCTAssertFalse(contains("Thinking…", in: app))
        // Thinking hidden, the bubble still says the bot is on it.
        assertTypingBubbleInView(app)
    }

    @MainActor
    func testFullKeepsLiveReasoningAvailable() {
        let app = launchPreview(detail: "full", reasoning: true)
        XCTAssertTrue(app.staticTexts["Thinking…"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["assistant-turn.preview-turn"].exists)
    }

    /// The typing bubble is on screen, not merely in the tree: XCUITest
    /// reports an element scrolled out of sight as existing, so this asks
    /// for hittable, and for the bubble to end above the composer.
    @MainActor
    @discardableResult
    private func assertTypingBubbleInView(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let typing = app.descendants(matching: .any)["typing-indicator"]
        XCTAssertTrue(typing.waitForExistence(timeout: 5), "no typing bubble", file: file, line: line)
        XCTAssertEqual(typing.label, "Pepper is typing", file: file, line: line)
        let inView = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: typing)
        wait(for: [inView], timeout: 5)
        let composer = app.descendants(matching: .any)["message-input"]
        XCTAssertTrue(composer.exists, "no composer", file: file, line: line)
        XCTAssertLessThanOrEqual(typing.frame.maxY, composer.frame.minY, "the typing bubble runs under the composer", file: file, line: line)
        return typing
    }

    @MainActor
    private func launchPreview(detail: String, reasoning: Bool = false, focused: Bool = false, receipts: Bool = false, update: Bool = false, live: Bool = false, typing: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-chat-presentation-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.prefs.activityDetail", detail,
            // These tests open Pepper through its "Threads" row. The update
            // fixture gives Pepper one thread, which only the comfortable
            // density lists; the roster itself is RosterDensityUITests' job.
            "-companion.prefs.rosterDensity", "comfortable",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        if reasoning { app.launchArguments.append("-chat-reasoning-preview") }
        if focused { app.launchArguments.append("-chat-focus-preview") }
        if receipts { app.launchArguments.append("-chat-compaction-preview") }
        if update { app.launchArguments.append("-chat-update-preview") }
        if live { app.launchArguments.append("-chat-live-narration-preview") }
        if typing { app.launchArguments.append("-chat-typing-preview") }
        app.launch()
        let threads = app.buttons["threads-toggle.preview-pepper"]
        XCTAssertTrue(threads.waitForExistence(timeout: 10))
        threads.tap()
        app.buttons["thread.preview-gmail"].tap()
        return app
    }

    @MainActor
    private func contains(_ text: String, in app: XCUIApplication) -> Bool {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
    }

    @MainActor
    private func screenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
