import XCTest

/// Runs exclusively against the bundled RosterPreview fleet: a Chief of
/// Staff, a bot with three threads, one waiting on you, one working, groups
/// and named sections. No account, paired computer, or server is involved,
/// and the preview has no API client, so nothing can be sent anywhere.
final class RosterDensityUITests: XCTestCase {
    @MainActor
    func testCompactIsTheDefault() {
        let app = launchRoster(density: nil)
        let pepper = app.buttons["threads-toggle.roster-pepper"]
        XCTAssertTrue(pepper.waitForExistence(timeout: 10))
        XCTAssertEqual(pepper.value as? String, "Collapsed, 3 threads")
        // One line per bot: no last-message preview under the name.
        XCTAssertTrue(app.buttons["chat-row.roster-atlas"].exists)
        XCTAssertFalse(contains("Three reviews and one approval", in: app))
        // Groups are rows, made from the "+" on their title.
        XCTAssertTrue(app.buttons["chat-row.roster-general"].exists)
        XCTAssertTrue(app.buttons["new-group"].exists)
        // The Chief of Staff wears the crown right after its name.
        let crown = app.buttons["chat-row.roster-atlas"].descendants(matching: .any)["chief-badge"]
        XCTAssertTrue(crown.exists)
        XCTAssertEqual(crown.label, "Chief of Staff")
        recordScreenshot("Compact roster by default", in: app)
    }

    @MainActor
    func testSingleThreadBotHasNoThreadsRowAndStillStartsAThread() {
        let app = launchRoster(density: nil)
        let atlas = app.buttons["chat-row.roster-atlas"]
        XCTAssertTrue(atlas.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["threads-toggle.roster-atlas"].exists)
        XCTAssertFalse(app.buttons["threads-toggle.roster-scout"].exists)
        XCTAssertFalse(app.buttons["thread.roster-atlas-plan"].exists)

        atlas.press(forDuration: 1.2)
        let newThread = app.buttons["New thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Manage threads"].exists)
        recordScreenshot("Long press offers a new thread", in: app)
        // The preview has no client, so creating fails offline — visibly.
        newThread.tap()
        let alert = app.alerts["Something went wrong"]
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts["Couldn't create a thread. Check the connection and try again."].exists)
        alert.buttons["OK"].tap()

        // The row itself opens the bot's one thread.
        atlas.tap()
        assertThread("Weekly plan", in: app)
    }

    @MainActor
    func testMultiThreadBotListsItsThreadsUnderItsName() {
        let app = launchRoster(density: nil)
        let toggle = app.buttons["threads-toggle.roster-pepper"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["thread.roster-pepper-gmail"].exists)
        // Pepper starts near the floating bar; bring it up so its threads
        // open on screen.
        scrollToUpperHalf(toggle, in: app)

        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "Expanded, 3 threads")
        let gmail = app.buttons["thread.roster-pepper-gmail"]
        XCTAssertTrue(gmail.waitForExistence(timeout: 5))
        XCTAssertTrue(gmail.label.contains("Working"))
        XCTAssertTrue(app.buttons["thread.roster-pepper-icloud"].label.contains("Unread"))
        XCTAssertTrue(app.buttons["thread.roster-pepper-weekend"].label.contains("Queued"))
        XCTAssertFalse(app.buttons["thread.roster-pepper-routine"].exists)
        let newThread = app.buttons["new-thread.roster-pepper"]
        XCTAssertTrue(newThread.exists)
        XCTAssertTrue(newThread.label.contains("New thread"))

        // Threads start where the bot's name starts: no deeper indent.
        let name = app.buttons["chat-row.roster-pepper"].staticTexts["Pepper"]
        XCTAssertTrue(name.exists)
        XCTAssertEqual(gmail.frame.minX, name.frame.minX, accuracy: 1)
        XCTAssertEqual(newThread.frame.minX, name.frame.minX, accuracy: 1)
        // "Plan weekend" is in no folder: it sits under its own label, on
        // the name's edge, and stays when the Email folder closes.
        let unfiled = app.descendants(matching: .any)["unfiled-threads.roster-pepper"]
        XCTAssertTrue(unfiled.exists)
        XCTAssertEqual(unfiled.label, "Threads")
        XCTAssertEqual(unfiled.frame.minX, name.frame.minX, accuracy: 1)
        XCTAssertLessThan(unfiled.frame.maxY, app.buttons["thread.roster-pepper-weekend"].frame.minY + 1)
        recordScreenshot("Pepper's threads opened in place", in: app)

        let email = app.buttons["folder.roster-pepper.email"]
        email.tap()
        XCTAssertEqual(email.value as? String, "Collapsed")
        assertMissing(gmail)
        XCTAssertTrue(app.buttons["thread.roster-pepper-weekend"].exists)
        XCTAssertTrue(unfiled.exists)
        recordScreenshot("Email folder closed, unfiled thread under its label", in: app)
        email.tap()
        XCTAssertTrue(gmail.waitForExistence(timeout: 5))

        app.buttons["thread.roster-pepper-icloud"].tap()
        assertThread("Triage iCloud", in: app)
        app.buttons["Back"].tap()
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "Expanded, 3 threads")
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "Collapsed, 3 threads")
        assertMissing(app.buttons["thread.roster-pepper-gmail"])
    }

    @MainActor
    func testSettingSwitchesBackToComfortableAndIsRemembered() {
        let app = launchRoster(density: nil)
        XCTAssertTrue(app.buttons["threads-toggle.roster-pepper"].waitForExistence(timeout: 10))

        chooseDensity("Comfortable", in: app)
        // Comfortable is the original look: a Threads row under every bot,
        // the last message under each name, and groups as tiles.
        XCTAssertTrue(app.buttons["threads-toggle.roster-atlas"].waitForExistence(timeout: 5))
        XCTAssertTrue(contains("Three reviews and one approval", in: app))
        XCTAssertFalse(app.buttons["new-group"].exists)
        recordScreenshot("Comfortable roster after the switch", in: app)

        // Kept on this device across launches.
        app.terminate()
        app.launchArguments = Self.baseArguments
        app.launch()
        XCTAssertTrue(app.buttons["threads-toggle.roster-atlas"].waitForExistence(timeout: 10))

        chooseDensity("Compact", in: app)
        XCTAssertTrue(app.buttons["threads-toggle.roster-pepper"].waitForExistence(timeout: 5))
        assertMissing(app.buttons["threads-toggle.roster-atlas"])
    }

    /// The floating Updates bar must never cover the last row: scrolled to
    /// the end, the row sits wholly above the bar and takes a tap.
    @MainActor
    func testLastRowClearsTheBottomBarInBothDensities() {
        for (density, lastRow) in [("compact", "chat-row.roster-sage"), ("comfortable", "threads-toggle.roster-sage")] {
            let app = launchRoster(density: density)
            let bar = app.buttons["updates-button"]
            XCTAssertTrue(bar.waitForExistence(timeout: 10))
            let last = app.buttons[lastRow]
            // Scroll until the last row shows, then on to the list's end.
            var swipes = 0
            while !(last.exists && last.isHittable), swipes < 12 {
                app.swipeUp()
                swipes += 1
            }
            app.swipeUp()
            app.swipeUp()
            XCTAssertTrue(last.waitForExistence(timeout: 5), density)
            // let the list settle at its end before measuring
            Thread.sleep(forTimeInterval: 1)
            XCTAssertTrue(last.isHittable, density)
            XCTAssertLessThanOrEqual(last.frame.maxY, bar.frame.minY - 8, density)
            recordScreenshot("Last row above the bar, \(density)", in: app)
        }
    }

    /// The list starts where the header's glass buttons end. Its first
    /// title must start well inside it, clear of the buttons' shadow along
    /// that edge, not tucked against it.
    @MainActor
    func testFirstSectionTitleClearsTheHeaderInBothDensities() {
        for density in ["compact", "comfortable"] {
            let app = launchRoster(density: density)
            let list = app.scrollViews["roster-list"]
            let settings = app.buttons["Settings"]
            let title = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Needs attention")).firstMatch
            XCTAssertTrue(title.waitForExistence(timeout: 10), density)
            XCTAssertTrue(list.exists, density)
            XCTAssertGreaterThanOrEqual(list.frame.minY, settings.frame.maxY, density)
            XCTAssertGreaterThanOrEqual(title.frame.minY - list.frame.minY, 12, density)
            recordScreenshot("First title below the header, \(density)", in: app)
        }
    }

    // MARK: - Helpers

    private static let baseArguments = [
        "-store-preview", "-roster-preview",
        "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        "-companion.prefs.islandIntro", "never",
        "-companion.onboarding.welcomeSeen", "YES",
        "-companion.onboarding.notificationsSeen", "YES",
    ]

    /// `nil` starts from the install default: a density saved by an earlier
    /// run on this simulator is removed first.
    @MainActor
    private func launchRoster(density: String?) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = Self.baseArguments
            + (density.map { ["-companion.prefs.rosterDensity", $0] } ?? ["-reset-list-density"])
        app.launch()
        if app.buttons["Connect computer"].exists {
            app.terminate()
            app.launch()
        }
        XCTAssertTrue(app.buttons["updates-button"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func chooseDensity(_ label: String, in app: XCUIApplication) {
        app.buttons["Settings"].tap()
        let picker = app.buttons["list-density"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        let option = app.buttons[label]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        XCTAssertTrue((picker.value as? String)?.contains(label) == true || picker.label.contains(label))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["updates-button"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func scrollToUpperHalf(_ element: XCUIElement, in app: XCUIApplication) {
        var swipes = 0
        while element.frame.minY > app.frame.midY, swipes < 6 {
            app.swipeUp(velocity: .slow)
            swipes += 1
        }
    }

    @MainActor
    private func assertThread(_ title: String, in app: XCUIApplication) {
        let header = app.buttons["thread-switcher"]
        let expected = NSPredicate(format: "label == %@", "Switch thread: \(title)")
        let appeared = XCTNSPredicateExpectation(predicate: expected, object: header)
        XCTAssertEqual(XCTWaiter.wait(for: [appeared], timeout: 10), .completed)
    }

    @MainActor
    private func assertMissing(_ element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: element
        )
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    @MainActor
    private func contains(_ text: String, in app: XCUIApplication) -> Bool {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
    }

    @MainActor
    private func recordScreenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
