import XCTest

/// Bundled offline fleet only; no API client or paired user data.
final class TranscriptPresentationUITests: XCTestCase {
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

    @MainActor
    func testHiddenSuppressesLiveReasoning() {
        let app = launchPreview(detail: "hidden", reasoning: true)
        XCTAssertTrue(app.buttons["assistant-turn.preview-turn"].waitForExistence(timeout: 5))
        XCTAssertFalse(contains("Thinking…", in: app))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Pepper is working")).firstMatch.exists)
    }

    @MainActor
    func testFullKeepsLiveReasoningAvailable() {
        let app = launchPreview(detail: "full", reasoning: true)
        XCTAssertTrue(app.staticTexts["Thinking…"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["assistant-turn.preview-turn"].exists)
    }

    @MainActor
    private func launchPreview(detail: String, reasoning: Bool = false, focused: Bool = false, receipts: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "-store-preview", "-chat-presentation-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.prefs.activityDetail", detail,
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        if reasoning { app.launchArguments.append("-chat-reasoning-preview") }
        if focused { app.launchArguments.append("-chat-focus-preview") }
        if receipts { app.launchArguments.append("-chat-compaction-preview") }
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
