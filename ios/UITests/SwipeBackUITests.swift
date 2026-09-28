import XCTest

/// The system edge-swipe back gesture on the conversation screen, against the
/// bundled ThreadPreview fleet exactly like ThreadNavigationUITests: no
/// account, no paired computer, no server mutations.
final class SwipeBackUITests: XCTestCase {
    @MainActor
    func testEdgeSwipePopsConversationBackToHome() {
        let app = launchPreview()
        openConversation(in: app)
        recordScreenshot("Conversation before edge swipe", in: app)

        edgeSwipeUntilPopped(in: app)

        // The roster's thread toggle only exists on Home, so this is the
        // proof the swipe performed a pop rather than a sideways scroll.
        XCTAssertTrue(
            app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 10),
            "an edge swipe on a conversation should pop back to Home"
        )
        recordScreenshot("Home after edge swipe", in: app)
    }

    @MainActor
    func testSwipeAwayFromTheLeftEdgeDoesNotPopAndTranscriptStillScrolls() {
        let app = launchPreview()
        openConversation(in: app)

        // A drag that starts mid-screen is not a back swipe; the recognizer
        // only owns the left bezel zone.
        let center = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let right = app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        center.press(forDuration: 0.05, thenDragTo: right)

        assertOnThread("Triage Gmail", in: app)
        assertGone(app.buttons["threads-toggle.preview-pepper"], in: app)

        // Vertical scrolling in the transcript keeps working.
        app.swipeUp()
        assertOnThread("Triage Gmail", in: app)
    }

    @MainActor
    func testBackToBackSwipePopsKeepTheStackHealthy() {
        let app = launchPreview()

        // Two full cycles. The second one matters as much as the first: the
        // recognizer's delegate stays armed while the stack sits at its root,
        // and the classic failure of re-arming this gesture is a stack that
        // no longer pushes or pops. (A raw edge drag started on the roster
        // itself lands on real content — rows that open threads — so the
        // root guard is proven by cycling, not by dragging across Home.)
        openConversation(in: app)
        edgeSwipeUntilPopped(in: app)
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 10))

        openConversation(in: app)
        edgeSwipeUntilPopped(in: app)
        XCTAssertTrue(
            app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 10),
            "the second swipe pop should land on Home exactly like the first"
        )
        recordScreenshot("Home after two back-to-back swipe pops", in: app)
    }

    // MARK: - Harness (same shape as ThreadNavigationUITests)

    /// The system recognizer is a screen-edge pan: the drag has to start
    /// inside the left bezel zone to be seen as a back swipe at all, travel
    /// far enough to carry the interactive transition past its cancel
    /// threshold, and release cleanly. Synthesized drags occasionally lose
    /// that race on a loaded runner, so one deliberate retry is attempted —
    /// the same accommodation launchPreview already makes for a prewarmed
    /// simulator scene. Without the fix in the app, every attempt fails and
    /// the caller's assertion still goes red.
    @MainActor
    private func edgeSwipeUntilPopped(in app: XCUIApplication) {
        let header = app.buttons["thread-switcher"]
        for _ in 0..<2 {
            edgeSwipe(in: app)
            if !header.waitForExistence(timeout: 3) { return }
        }
    }

    @MainActor
    private func edgeSwipe(in app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.008, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5))
        start.press(forDuration: 0.25, thenDragTo: end, withVelocity: XCUIGestureVelocity(400), thenHoldForDuration: 0.2)
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
        // without the preview arguments once. Restart only that wrong route.
        if app.buttons["Connect computer"].exists {
            app.terminate()
            app.launch()
        }
        XCTAssertTrue(app.buttons["threads-toggle.preview-pepper"].waitForExistence(timeout: 10))
        return app
    }

    @MainActor
    private func openConversation(in app: XCUIApplication) {
        // On a fresh launch the bot row is collapsed, so expand it first.
        // After a swipe pop the roster still carries that expanded state —
        // tapping the toggle again would collapse it — and the bot row
        // itself reopens the remembered thread, the same route
        // ThreadNavigationUITests takes after tapping Back.
        let gmail = app.buttons["thread.preview-gmail"]
        if gmail.waitForExistence(timeout: 2) {
            gmail.tap()
        } else {
            let toggle = app.buttons["threads-toggle.preview-pepper"]
            toggle.tap()
            XCTAssertTrue(gmail.waitForExistence(timeout: 5))
            gmail.tap()
        }
        assertOnThread("Triage Gmail", in: app)
    }

    @MainActor
    private func assertOnThread(_ title: String, in app: XCUIApplication) {
        let header = app.buttons["thread-switcher"]
        let expected = NSPredicate(format: "label == %@", "Switch thread: \(title)")
        let appeared = XCTNSPredicateExpectation(predicate: expected, object: header)
        // Thread headers settle late on a loaded CI runner, matching the
        // timeouts ThreadNavigationUITests already carries.
        XCTAssertEqual(XCTWaiter.wait(for: [appeared], timeout: 10), .completed)
    }

    @MainActor
    private func assertGone(_ element: XCUIElement, in app: XCUIApplication) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: element
        )
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 2), .completed)
    }

    @MainActor
    private func recordScreenshot(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
