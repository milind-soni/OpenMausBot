import XCTest

/// Synthetic fleet only: no account, network, microphone or message sends.
final class ResponsivenessUITests: XCTestCase {
    /// Seconds one action may take while the fixture lands 400 token frames a
    /// second across twenty threads. XCUITest's own typing and waiting are
    /// most of it: on an iPhone 17 Pro / iOS 26.5 simulator, on a Mac with a
    /// load average over 100 from other builds, typing a 16–20 character
    /// draft took 1.4–3.9 s and a switch-away-and-back with a second draft
    /// 10–18 s. A main thread that cannot keep up makes XCUITest wait for
    /// idle on every keystroke, which is what these catch; the ceilings are
    /// about three and two times the slowest run.
    private static let typingBudget: TimeInterval = 12
    private static let switchingBudget: TimeInterval = 30

    /// Message rows the open chat may redraw while you type into it and the
    /// fleet streams, over the typing and two seconds after. Nothing in its
    /// settled transcript changes, so the answer should be none. Before rows
    /// compared as values, every 50 ms publish redrew every row of the open
    /// chat: 79–98 for the fixture's one-row chat over this window, and
    /// 1,314 for Gmail's six over its first 220 publishes (launched directly).
    private static let rowRedrawBudget = 50

    @MainActor
    func testShortChatTypingAndThreadSwitchingDuringBusyFleet() {
        let app = launchBusyFleet()
        let threads = app.buttons["threads-toggle.preview-pepper"]
        XCTAssertTrue(threads.waitForExistence(timeout: 10))
        threads.tap()
        app.buttons["thread.preview-gmail"].tap()

        let progress = app.staticTexts["busy-fleet-progress"]
        let redraws = app.staticTexts["transcript-row-redraws"]
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        XCTAssertTrue(redraws.waitForExistence(timeout: 10))
        let before = cursorSequence(progress)
        let input = app.descendants(matching: .any)["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        waitForRowsToSettle(redraws)
        let redrawsBefore = counter(redraws)
        let typingStarted = Date()
        input.tap()
        input.typeText("Busy Gmail draft")
        XCTAssertEqual(input.value as? String, "Busy Gmail draft")
        let typing = record("Typed Gmail draft", started: typingStarted, progress: progress)
        pause(2)
        let gmailRedraws = counter(redraws) - redrawsBefore
        noteRedraws(gmailRedraws, while: "typing into Gmail and for 2 s after, other threads streaming")

        let switchingStarted = Date()
        selectThread("preview-icloud", title: "Triage iCloud", in: app)
        XCTAssertNotEqual(input.value as? String, "Busy Gmail draft")
        input.tap()
        input.typeText("Busy iCloud draft")
        XCTAssertEqual(input.value as? String, "Busy iCloud draft")
        selectThread("preview-gmail", title: "Triage Gmail", in: app)
        XCTAssertEqual(input.value as? String, "Busy Gmail draft")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "I’m reviewing Gmail here"
        )).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "I am reviewing iCloud here"
        )).firstMatch.exists)
        let switching = record("Switched iCloud and returned with Gmail draft", started: switchingStarted, progress: progress)
        let after = cursorSequence(progress)
        XCTAssertGreaterThan(after, before, "The flood must advance during the actions")
        XCTAssertLessThan(after, 36_000, "The actions must finish while the flood is still active")
        XCTAssertLessThan(typing, Self.typingBudget, "Typing a short draft took \(typing)s during the flood")
        XCTAssertLessThan(switching, Self.switchingBudget, "Switching threads took \(switching)s during the flood")
        XCTAssertLessThan(
            gmailRedraws, Self.rowRedrawBudget,
            "Typing and other threads' tokens must not redraw this chat's rows"
        )
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Short chat draft during synthetic busy fleet"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    /// The thread that is streaming, not a quiet one: a busy fixture bot's
    /// chat with its live reply growing every batch, typed into while the
    /// other nineteen threads stream too. (Each fixture thread stores fifty
    /// messages without parent links, so its branch, and the chat, is the
    /// newest one: one settled row under the live reply.)
    @MainActor
    func testTypingIntoTheStreamingThreadDuringBusyFleet() {
        let app = launchBusyFleet(detail: "full")
        let botId = openBusyFixtureChat(in: app)
        let number = botId.split(separator: "-").last.map(String.init) ?? "0"
        let lastMessage = app.descendants(matching: .any)["message-busy-\(number)-49"]
        XCTAssertTrue(lastMessage.waitForExistence(timeout: 10), "The fixture chat's settled message is on screen")

        let progress = app.staticTexts["busy-fleet-progress"]
        let redraws = app.staticTexts["transcript-row-redraws"]
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        XCTAssertTrue(redraws.waitForExistence(timeout: 10))
        let input = app.descendants(matching: .any)["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        // Let the opening land before counting: the page's first draw is
        // not what this measures.
        waitForRowsToSettle(redraws)

        let redrawsBefore = counter(redraws)
        let before = cursorSequence(progress)
        let typingStarted = Date()
        input.tap()
        input.typeText("Busy streaming draft")
        XCTAssertEqual(input.value as? String, "Busy streaming draft")
        let typing = record("Typed into the streaming thread", started: typingStarted, progress: progress)
        // And keep reading with the draft in place while the fleet streams.
        pause(2)
        let redrawsAfter = counter(redraws)
        let after = cursorSequence(progress)
        noteRedraws(redrawsAfter - redrawsBefore, while: "typing into the streaming thread and for 2 s after (cursor \(before) → \(after))")

        XCTAssertGreaterThan(after - before, 100, "The flood must keep landing during the measurement")
        XCTAssertLessThan(after, 36_000, "The actions must finish while the flood is still active")
        XCTAssertLessThan(typing, Self.typingBudget, "Typing into the streaming thread took \(typing)s")
        XCTAssertLessThan(
            redrawsAfter - redrawsBefore, Self.rowRedrawBudget,
            "Typing and other threads' tokens must not redraw this chat's settled rows"
        )
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Draft in a streaming chat during synthetic busy fleet"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    /// A reader who scrolls back while a reply streams stays where they
    /// scrolled. The transcript used to scroll to the live reply on every
    /// batch, twenty times a second, whoever was reading what.
    @MainActor
    func testReadingBackIsNotPulledDownWhileTheReplyStreams() {
        let app = launchBusyFleet(detail: "full")
        let botId = openBusyFixtureChat(in: app)
        let number = botId.split(separator: "-").last.map(String.init) ?? "0"
        let settled = app.descendants(matching: .any)["message-busy-\(number)-49"]
        XCTAssertTrue(settled.waitForExistence(timeout: 10))
        let progress = app.staticTexts["busy-fleet-progress"]
        XCTAssertTrue(progress.waitForExistence(timeout: 10))
        // Let the live reply grow well past a screen: about 3,000 characters
        // of it once the fleet has sent 12,000 frames.
        let deadline = Date().addingTimeInterval(60)
        while cursorSequence(progress) < 12_000, Date() < deadline { pause(0.5) }
        XCTAssertGreaterThanOrEqual(cursorSequence(progress), 12_000)

        let transcript = app.scrollViews.containing(.any, identifier: "message-busy-\(number)-49").firstMatch
        let jump = app.buttons["Jump to latest messages"]
        for _ in 0..<3 where !jump.exists {
            transcript.swipeDown()
        }
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "Scrolled back far enough to be offered the end")
        let before = cursorSequence(progress)
        pause(2)
        XCTAssertGreaterThan(cursorSequence(progress) - before, 100, "The reply kept streaming meanwhile")
        XCTAssertTrue(jump.exists, "The reader was pulled back to the live reply")

        jump.tap()
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: jump)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "Jump to latest lands on the end")
        // Back at the end, the stream is followed again.
        pause(2)
        XCTAssertFalse(jump.exists, "At the end, the transcript follows the reply")
    }

    @MainActor
    /// `detail` is the Activity setting. The phone's default, Hidden, sends a
    /// working bot's reply to the status line; Full streams it as a bubble
    /// in the transcript, which is the case these tests are about.
    private func launchBusyFleet(detail: String? = nil) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        addTeardownBlock { app.terminate() }
        app.terminate()
        app.launchArguments = [
            "-store-preview", "-threads-preview", "-busy-fleet-preview",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.prefs.rosterDensity", "comfortable",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"
        ] + (detail.map { ["-companion.prefs.activityDetail", $0] } ?? [])
        app.launch()
        // A first launch can come up before the preview store is read;
        // StopButtonUITests meets the same thing the same way.
        if app.buttons["Connect computer"].waitForExistence(timeout: 3) {
            app.terminate()
            app.launch()
        }
        // The app reopens the last chat; start from the roster either way.
        if app.buttons["Back"].waitForExistence(timeout: 2) { app.buttons["Back"].tap() }
        return app
    }

    /// The fixture bots sort below the preview's own; scroll until one shows.
    @MainActor
    private func openBusyFixtureChat(in app: XCUIApplication) -> String {
        let roster = app.descendants(matching: .any)["roster-list"]
        XCTAssertTrue(roster.waitForExistence(timeout: 10))
        for _ in 0..<15 {
            for number in 0..<20 {
                let row = app.buttons["chat-row.busy-preview-\(number)"]
                if row.exists, row.isHittable {
                    row.tap()
                    return "busy-preview-\(number)"
                }
            }
            roster.swipeUp()
        }
        XCTFail("No busy fixture bot reached on the roster")
        return "busy-preview-0"
    }

    @MainActor
    private func cursorSequence(_ progress: XCUIElement) -> Int {
        let cursor = progress.value as? String ?? ""
        let sequence = Int(cursor.split(separator: ":").last ?? "")
        XCTAssertNotNil(sequence, "The fixture cursor must be readable: \(cursor)")
        return sequence ?? 0
    }

    @MainActor
    private func counter(_ element: XCUIElement) -> Int {
        let value = element.value as? String ?? ""
        XCTAssertNotNil(Int(value), "The redraw counter must be readable: \(value)")
        return Int(value) ?? 0
    }

    /// Waits until the redraw counter stops climbing: the chat's first draw
    /// is done. Under XCUITest, SwiftUI sometimes goes on redrawing a
    /// just-opened chat's rows for several seconds without asking their `==`
    /// (5 of 17 runs while this test was written); launched directly, the
    /// same chat settled within a second in every run, so the likely cause
    /// is XCUITest's accessibility polling. A chat that never settles still
    /// fails the redraw check below.
    @MainActor
    private func waitForRowsToSettle(_ redraws: XCUIElement) {
        var last = counter(redraws)
        for _ in 0..<20 {
            pause(1)
            let now = counter(redraws)
            if now == last { return }
            last = now
        }
    }

    @MainActor
    private func noteRedraws(_ count: Int, while action: String) {
        let note = XCTAttachment(string: "Message rows redrawn \(action): \(count)")
        note.name = "Row redraws"
        note.lifetime = .keepAlways
        add(note)
    }

    @MainActor
    private func pause(_ seconds: TimeInterval) {
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "time passes")], timeout: seconds)
    }

    @MainActor
    private func selectThread(_ id: String, title: String, in app: XCUIApplication) {
        app.buttons["thread-switcher"].tap()
        let thread = app.buttons["thread-\(id)"]
        XCTAssertTrue(thread.waitForExistence(timeout: 10))
        thread.tap()
        let titleArrived = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Switch thread: \(title)"),
            object: app.buttons["thread-switcher"]
        )
        XCTAssertEqual(XCTWaiter.wait(for: [titleArrived], timeout: 10), .completed)
    }

    @MainActor
    @discardableResult
    private func record(_ action: String, started: Date, progress: XCUIElement) -> TimeInterval {
        let elapsed = Date().timeIntervalSince(started)
        let note = XCTAttachment(string: "\(action): \(elapsed)s; cursor=\(progress.value as? String ?? "missing")")
        note.name = action
        note.lifetime = .keepAlways
        add(note)
        return elapsed
    }
}
