import XCTest

final class VoiceNoteUITests: XCTestCase {
    @MainActor
    func testVoiceNotePlaysPausesAndReplays() {
        let app = XCUIApplication()
        app.terminate()
        app.launchArguments = ["-store-preview", "-threads-preview", "-voice-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        let toggle = app.buttons["threads-toggle.preview-pepper"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        app.buttons["thread.preview-gmail"].tap()

        let time = app.staticTexts["voice-note-time"]
        XCTAssertTrue(scrollTo(time, app: app), "voice note clock never appeared")
        record("Voice note in transcript", app)
        XCTAssertEqual(time.label, "0:00 / 0:06")

        // Play: the clock leaves zero once the clip is audible.
        let play = app.buttons["voice-note-play"]
        XCTAssertTrue(play.waitForExistence(timeout: 5))
        play.tap()
        let moved = NSPredicate(format: "label != %@", "0:00 / 0:06")
        expectation(for: moved, evaluatedWith: time)
        waitForExpectations(timeout: 10)
        record("Voice note playing", app)

        // Pause: the clip is long enough that a hold means the label cannot
        // change — with seconds still to run, continued playback would keep
        // advancing the clock instead of freezing it.
        let held = time.label
        XCTAssertTrue(held != "0:00 / 0:06")
        play.tap()
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertEqual(time.label, held)
        record("Voice note paused", app)

        // Resume: the clip runs to the end, then rewinds so play works again.
        play.tap()
        let rewound = NSPredicate(format: "label == %@", "0:00 / 0:06")
        expectation(for: rewound, evaluatedWith: time)
        waitForExpectations(timeout: 15)
        record("Voice note finished and rewound", app)
    }

    @MainActor
    private func scrollTo(_ element: XCUIElement, app: XCUIApplication, maxSwipes: Int = 8) -> Bool {
        for _ in 0..<maxSwipes {
            if element.exists { return true }
            app.swipeUp(velocity: .fast)
        }
        return element.exists
    }

    @MainActor
    private func record(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
