import XCTest

final class GeneratedImageUITests: XCTestCase {
    @MainActor
    func testAgentImageLoadsAndOpensFullScreen() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-images-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let toggle = app.buttons["threads-toggle.preview-pepper"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        app.buttons["thread.preview-gmail"].tap()
        let image = app.buttons["Image: screenshot.png"]
        let appeared = image.waitForExistence(timeout: 5)
        record("Agent image in transcript", app)
        XCTAssertTrue(appeared)
        guard appeared else { return }
        let loaded = NSPredicate(format: "enabled == true AND value == %@", "Loaded")
        expectation(for: loaded, evaluatedWith: image)
        waitForExpectations(timeout: 10)
        image.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["Image canvas"].waitForExistence(timeout: 10))
        record("Agent image full screen", app)
        app.buttons["Done"].tap()
        XCTAssertTrue(image.waitForExistence(timeout: 5))
    }

    @MainActor
    private func record(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
