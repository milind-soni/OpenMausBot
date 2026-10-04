import XCTest

/// Runs against the bundled RosterPreview fleet: no paired computer, and the
/// preview has no API client, so nothing typed here can be sent anywhere.
final class MentionPickerUITests: XCTestCase {
    /// Typing @ in a room offers @everyone and the room's members (never a
    /// bot outside it), narrows as you type, and a tap writes the exact tag
    /// the harness routes on (MOCA-75).
    @MainActor
    func testTypingAtInARoomOffersItsMembersAndATapWritesTheTag() {
        let app = launchPreview()
        let room = app.buttons["chat-row.roster-design-crit"].firstMatch
        XCTAssertTrue(room.waitForExistence(timeout: 10))
        room.tap()
        dismissAlert(in: app)

        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("ask @")

        XCTAssertTrue(app.buttons["mention-__everyone__"].waitForExistence(timeout: 5), "@everyone is offered in a room")
        XCTAssertTrue(app.buttons["mention-roster-pixel"].exists)
        XCTAssertTrue(app.buttons["mention-roster-quill"].exists)
        XCTAssertFalse(app.buttons["mention-roster-atlas"].exists, "Atlas is not in this room")
        recordScreenshot("Mention picker after typing @", in: app)

        input.typeText("qu")
        XCTAssertTrue(app.buttons["mention-roster-quill"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["mention-roster-pixel"].exists, "the list narrows to what was typed")

        app.buttons["mention-roster-quill"].tap()
        XCTAssertEqual(input.value as? String, "ask @Quill ")
        XCTAssertFalse(app.buttons["mention-roster-quill"].exists, "a completed tag closes the picker")
        recordScreenshot("Draft after picking Quill", in: app)
    }

    @MainActor
    private func launchPreview() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = [
            "-store-preview", "-roster-preview",
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
        dismissAlert(in: app)
        if app.buttons["Back"].waitForExistence(timeout: 2) { app.buttons["Back"].tap() }
        return app
    }

    /// The preview answers no room routes, so opening one raises the app's
    /// error alert; it is not what this test is about.
    @MainActor
    private func dismissAlert(in app: XCUIApplication) {
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons["OK"].tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: alert)
            waitForExpectations(timeout: 5)
        }
    }

    @MainActor
    private func recordScreenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
