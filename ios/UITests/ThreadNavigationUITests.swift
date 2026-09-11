import XCTest

/// Runs exclusively against the bundled ThreadPreview fleet. No account,
/// paired computer, message sends, or server mutations are involved.
final class ThreadNavigationUITests: XCTestCase {
    @MainActor
    func testRosterShowsFolderThreadsAndSwitchesLocally() {
        let app = launchPreview()
        openGmail(in: app)
        assertThread("Triage Gmail", in: app)

        app.buttons["thread-switcher"].tap()
        let iCloud = app.buttons["thread-preview-icloud"]
        XCTAssertTrue(iCloud.waitForExistence(timeout: 5))
        XCTAssertTrue(iCloud.label.contains("Unread"))
        XCTAssertTrue(app.buttons["thread-preview-weekend"].label.contains("Queued"))
        XCTAssertFalse(app.buttons["thread-preview-routine"].exists)
        recordScreenshot("Thread picker with folder and runtime states", in: app)
        iCloud.tap()
        assertThread("Triage iCloud", in: app)

        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 5))
        app.buttons["thread.preview-gmail"].tap()
        assertThread("Triage Gmail", in: app)
    }

    @MainActor
    func testHomeSearchFindsSiblingTitlesAndFolders() {
        let app = launchPreview()
        app.buttons["threads-toggle.preview-pepper"].tap()
        app.buttons["Search"].tap()
        let search = app.textFields["Search threads"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("iCloud")
        recordScreenshot("Home search for iCloud", in: app)

        XCTAssertTrue(app.buttons["thread.preview-icloud"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["thread.preview-gmail"].exists)
        XCTAssertFalse(app.buttons["thread.preview-weekend"].exists)

        app.buttons["Cancel"].tap()
        app.buttons["Search"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Email")
        XCTAssertTrue(app.buttons["thread.preview-gmail"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["thread.preview-icloud"].exists)
        XCTAssertFalse(app.buttons["thread.preview-weekend"].exists)
        XCTAssertFalse(app.buttons["thread.preview-routine"].exists)
        recordScreenshot("Home search for Email folder", in: app)

        app.buttons["thread.preview-icloud"].tap()
        assertThread("Triage iCloud", in: app)
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].exists)
        XCTAssertEqual(app.buttons["threads-toggle.preview-pepper"].value as? String, "Expanded, 3 threads")
    }

    @MainActor
    func testSwitchingThreadsKeepsSeparateUnsentDrafts() {
        let app = launchPreview()
        openGmail(in: app)
        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Gmail draft only")

        selectThread("preview-icloud", title: "Triage iCloud", in: app)
        XCTAssertNotEqual(input.value as? String, "Gmail draft only")
        input.tap()
        input.typeText("iCloud draft only")

        selectThread("preview-gmail", title: "Triage Gmail", in: app)
        XCTAssertEqual(input.value as? String, "Gmail draft only")
        selectThread("preview-icloud", title: "Triage iCloud", in: app)
        XCTAssertEqual(input.value as? String, "iCloud draft only")
        recordScreenshot("Restored iCloud draft after switching threads", in: app)
    }

    @MainActor
    func testFailedCreationKeepsThreadPickerOpenWithError() {
        let app = launchPreview()
        openGmail(in: app)
        app.buttons["thread-switcher"].tap()
        let create = app.buttons["new-thread"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        // The preview deliberately has no API client, so this cannot write
        // anywhere and exercises the failure path deterministically.
        create.tap()
        let error = app.descendants(matching: .any).matching(identifier: "thread-action-error").firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertTrue(error.label.contains("Couldn't create the thread"))
        XCTAssertTrue(create.exists)
        XCTAssertTrue(create.isEnabled)
        XCTAssertTrue(app.buttons["thread-preview-gmail"].exists)
        recordScreenshot("Failed creation keeps thread picker open", in: app)
        app.buttons["Done"].tap()
        assertThread("Triage Gmail", in: app)
    }

    @MainActor
    func testUpdatesKeepSiblingThreadsSeparate() {
        let app = launchPreview()
        app.buttons["updates-button"].tap()
        let gmail = app.buttons["update-preview-gmail"]
        let iCloud = app.buttons["update-preview-icloud"]
        let weekend = app.buttons["update-preview-weekend"]
        XCTAssertTrue(gmail.waitForExistence(timeout: 5))
        XCTAssertTrue(iCloud.exists)
        XCTAssertTrue(weekend.exists)
        XCTAssertTrue(gmail.label.contains("Triage Gmail"))
        XCTAssertTrue(iCloud.label.contains("Triage iCloud"))
        XCTAssertTrue(weekend.label.contains("Plan weekend"))
        XCTAssertFalse(app.buttons["update-preview-routine"].exists)
        XCTAssertTrue(app.staticTexts["3 active"].exists)
        if !iCloud.isHittable { app.swipeUp() }
        recordScreenshot("Separate updates for sibling threads", in: app)
        iCloud.tap()
        assertThread("Triage iCloud", in: app)
    }

    @MainActor
    private func launchPreview() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        // Xcode may prelaunch the app after installing an updated build.
        // Restart it so Session initializes with the offline fixture flags.
        app.terminate()
        app.launchArguments = [
            "-store-preview", "-threads-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ]
        app.launch()
        // Simulator installation can restore an unpaired, prewarmed scene
        // without the preview arguments once. Restart only that wrong route;
        // a missing thread in an already-loaded fixture must still fail.
        if app.buttons["Connect computer"].exists {
            app.terminate()
            app.launch()
        }
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func openGmail(in app: XCUIApplication) {
        let toggle = app.buttons["threads-toggle.preview-pepper"]
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "Expanded, 3 threads")
        let gmail = app.buttons["thread.preview-gmail"]
        XCTAssertTrue(gmail.waitForExistence(timeout: 5))
        XCTAssertTrue(gmail.label.contains("Working"))
        XCTAssertTrue(app.buttons["thread.preview-icloud"].label.contains("Unread"))
        XCTAssertTrue(app.buttons["thread.preview-weekend"].label.contains("Queued"))
        XCTAssertFalse(app.buttons["thread.preview-routine"].exists)
        recordScreenshot("Expanded home threads with Email folder", in: app)
        gmail.tap()
    }

    @MainActor
    private func selectThread(_ id: String, title: String, in app: XCUIApplication) {
        app.buttons["thread-switcher"].tap()
        let row = app.buttons["thread-\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        assertThread(title, in: app)
    }

    @MainActor
    private func assertThread(_ title: String, in app: XCUIApplication) {
        let header = app.buttons["thread-switcher"]
        let expected = NSPredicate(format: "label == %@", "Switch thread: \(title)")
        let appeared = XCTNSPredicateExpectation(predicate: expected, object: header)
        XCTAssertEqual(XCTWaiter.wait(for: [appeared], timeout: 5), .completed)
    }

    @MainActor
    private func recordScreenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
