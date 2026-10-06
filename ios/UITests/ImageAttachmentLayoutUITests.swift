import XCTest

/// Iris's chat in the bundled ImagePreview fleet holds one image of every
/// awkward shape — 2400×260, 1600×240, 16:9, square, 600×1300 and a phone
/// screenshot — and a reply with a wide table. A wide screenshot used to
/// widen the whole chat past the phone's edges: Back, the computer button,
/// the composer and every message were cut off on both sides. Each image must
/// now sit whole inside its bubble, on its own side, with the chat around it
/// on screen. Offline: the fixture draws each image at the size its path asks.
final class ImageAttachmentLayoutUITests: XCTestCase {
    private static let images = [
        // newest first: the chat opens on the table reply
        "wide-table-capture.png", "thin-banner.png", "square-icon.png",
        "tall-export.png", "phone-screenshot.png", "desktop-16x9.png", "wide-banner.png",
    ]
    /// Your own images sit on the right, a bot's on the left.
    private static let mine: Set<String> = ["wide-banner.png", "phone-screenshot.png"]

    @MainActor
    func testEveryImageShapeFitsInsideTheScreen() {
        // Walk every shape even after one fails: the screenshots are the point.
        continueAfterFailure = true
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = [
            "-store-preview", "-images-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.prefs.rosterDensity", "comfortable",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES",
        ]
        app.launch()
        // The app reopens the last chat; start from the roster either way.
        if app.buttons["Back"].waitForExistence(timeout: 3) { app.buttons["Back"].tap() }
        let row = app.staticTexts["Iris"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Iris on the roster")
        let input = app.descendants(matching: .any)["message-input"]
        for _ in 0..<3 where !input.exists {
            row.tap()
            _ = input.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(input.exists, "Iris's chat opened")

        let window = app.windows.firstMatch.frame
        for name in Self.images {
            let image = app.buttons["Image: \(name)"]
            XCTAssertTrue(image.waitForExistence(timeout: 5), name)
            center(image, in: app)
            let loaded = NSPredicate(format: "value == %@", "Loaded")
            expectation(for: loaded, evaluatedWith: image)
            waitForExpectations(timeout: 10)
            screenshot(name, in: app)

            let frame = image.frame
            XCTAssertGreaterThanOrEqual(frame.minX, window.minX, "\(name) starts on screen")
            XCTAssertLessThanOrEqual(frame.maxX, window.maxX, "\(name) ends on screen")
            // 300 points of picture at most, plus its one-line caption.
            XCTAssertLessThanOrEqual(frame.height, 340, "\(name) is no taller than the cap")
            if Self.mine.contains(name) {
                XCTAssertGreaterThan(frame.midX, window.midX, "\(name) is on your side")
            } else {
                XCTAssertLessThan(frame.midX, window.midX, "\(name) is on the bot's side")
            }
            assertChatOnScreen(app, window: window, while: name)
        }
    }

    /// Back, the computer and the composer are the controls a wide row cut
    /// off; the chat fits the phone when all three are wholly on screen.
    @MainActor
    private func assertChatOnScreen(_ app: XCUIApplication, window: CGRect, while name: String) {
        let computer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Watch Iris")).firstMatch
        let controls = [
            ("Back", app.buttons["Back"]),
            ("the computer button", computer),
            ("the composer", app.descendants(matching: .any)["message-input"]),
        ]
        for (label, control) in controls {
            XCTAssertTrue(control.exists, "\(label) with \(name) in view")
            guard control.exists else { continue }
            let frame = control.frame
            XCTAssertGreaterThanOrEqual(frame.minX, window.minX, "\(label) starts on screen with \(name) in view")
            XCTAssertLessThanOrEqual(frame.maxX, window.maxX, "\(label) ends on screen with \(name) in view")
        }
    }

    /// Drag the transcript until the element sits near the middle of the
    /// screen, holding at the end of each drag so it does not coast past.
    @MainActor
    private func center(_ element: XCUIElement, in app: XCUIApplication) {
        let window = app.windows.firstMatch
        for _ in 0..<8 {
            let offset = window.frame.midY - element.frame.midY
            if abs(offset) < 80 { return }
            let step = max(-window.frame.height * 0.35, min(window.frame.height * 0.35, offset))
            let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: step > 0 ? 0.35 : 0.65))
            start.press(
                forDuration: 0.05,
                thenDragTo: start.withOffset(CGVector(dx: 0, dy: step)),
                withVelocity: .slow,
                thenHoldForDuration: 0.3
            )
        }
    }

    @MainActor
    private func screenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
