import XCTest

/// Runs against the bundled StorePreview fleet: no paired computer, and the
/// preview has no API client, so nothing here can reach a real bot.
final class StopButtonUITests: XCTestCase {
    /// The desktop puts Stop in the composer while a turn runs; the phone
    /// hid it under + (MOCA-148). A working bot shows it, an idle one not.
    @MainActor
    func testTheComposerOffersStopOnlyWhileTheBotIsWorking() {
        let app = launchPreview()

        open("Forge", in: app)
        XCTAssertTrue(app.buttons["composer-stop"].waitForExistence(timeout: 5), "Forge is working in the preview")
        recordScreenshot("Stop beside the composer while Forge works", in: app)

        app.buttons["Back"].tap()
        open("Pixel", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["composer-stop"].exists, "an idle bot has nothing to stop")
    }

    @MainActor
    private func open(_ name: String, in app: XCUIApplication) {
        let row = app.staticTexts[name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "\(name) on the roster")
        let input = app.descendants(matching: .any)["message-input"]
        // The preview's pending approval raises the island over the roster
        // for its first seconds, and a tap then lands on the island.
        for _ in 0..<3 where !input.exists {
            row.tap()
            _ = input.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(input.exists, "\(name)'s chat opened")
    }

    @MainActor
    private func launchPreview() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = [
            "-store-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        app.launch()
        if app.buttons["Connect computer"].exists {
            app.terminate()
            app.launch()
        }
        // The app reopens the last chat; start from the roster either way.
        if app.buttons["Back"].waitForExistence(timeout: 2) { app.buttons["Back"].tap() }
        return app
    }

    @MainActor
    private func recordScreenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
