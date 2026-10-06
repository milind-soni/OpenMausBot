// The call bar, driven offline: no computer, no microphone, no WebRTC. The
// preview protocol plays the Mac and the fake media plays OpenAI; what is
// under test is that a tap on the phone icon becomes a bar with the right
// words, that mute and hang up do what they say, and that the composer's
// own microphone stays out of the way.
import XCTest

final class LiveCallUITests: XCTestCase {
    @MainActor
    func testACallStartsFromTheHeaderAndEndsFromTheBar() {
        let app = launch()
        openGmail(app)

        // A request spoken on an earlier call carries its label.
        let viaCall = app.descendants(matching: .any)["via-call-preview-gmail-user"]
        XCTAssertTrue(scrollUp(to: viaCall, app: app), "the via-call label never appeared")
        record("Via call label", app)

        let start = app.buttons["live-call-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()

        let bar = app.otherElements["live-call-bar"]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        let title = app.staticTexts["live-call-title"]
        expectation(for: NSPredicate(format: "label BEGINSWITH %@", "Live with Pepper"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
        record("Live call bar", app)

        // Captions: the person's words, then the voice's.
        let caption = app.staticTexts["live-call-caption"]
        expectation(for: NSPredicate(format: "label == %@", "Hello from the preview voice."), evaluatedWith: caption)
        waitForExpectations(timeout: 10)
        // The caption line made the bar taller; the chat's end is still above it.
        assertTheChatEndsAbove(bar, app)

        // The composer's microphone is not available during a call.
        XCTAssertFalse(app.buttons["Start dictation"].isEnabled)
        XCTAssertFalse(start.exists, "no second call from the header while one runs")

        let mute = app.buttons["live-call-mute"]
        XCTAssertEqual(mute.label, "Mute")
        mute.tap()
        XCTAssertEqual(mute.label, "Unmute")
        record("Muted", app)

        app.buttons["live-call-settings"].tap()
        XCTAssertTrue(app.staticTexts["Managed on your computer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Read replies to typed messages"].exists)
        // What a call sends to OpenAI, and what the typed-replies switch keeps out.
        XCTAssertTrue(Self.text(Self.disclosure, in: app).exists, "the sheet says what a call sends to OpenAI")
        XCTAssertTrue(app.staticTexts[Self.typedRepliesOff].exists, "the switch says what off keeps from OpenAI")
        record("Live call settings", app)
        app.buttons["Done"].tap()

        app.buttons["live-call-hangup"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bar)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(start.waitForExistence(timeout: 5), "the header offers a new call once the bar is gone")
        XCTAssertTrue(app.buttons["Start dictation"].isEnabled)
        record("After hang up", app)
    }

    /// A phone has no Live switch: its first call is where Live is turned
    /// on, so that call says first what a call sends to OpenAI, with Start
    /// call and Cancel, once per phone.
    @MainActor
    func testThePhonesFirstCallSaysWhatItSendsToOpenAIOnce() {
        let app = launch(disclosureShown: false)
        openGmail(app)
        let start = app.buttons["live-call-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()
        let note = app.alerts.firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5), "the disclosure comes before the first call")
        XCTAssertTrue(Self.text(Self.disclosure, in: note).exists)
        record("Before the first call", app)

        note.buttons["Cancel"].tap()
        XCTAssertFalse(app.otherElements["live-call-bar"].waitForExistence(timeout: 2), "Cancel starts nothing")
        start.tap()
        XCTAssertTrue(note.waitForExistence(timeout: 5), "the next try shows it again")
        note.buttons["Start call"].tap()
        let title = app.staticTexts["live-call-title"]
        expectation(for: NSPredicate(format: "label BEGINSWITH %@", "Live with Pepper"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
        app.buttons["live-call-hangup"].tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10))

        // Start call was remembered on this phone: the next launch calls at once.
        let again = launch(disclosureShown: nil)
        openGmail(again)
        startCall(again)
        XCTAssertFalse(again.alerts.firstMatch.exists)
    }

    /// A start can take seconds; the person must not have to wait it out.
    /// The preview holds the Mac's 201 back, so the bar stays on "Calling…"
    /// long enough to hang up, and the late 201 must not bring the call back.
    @MainActor
    func testACallCanBeHungUpWhileItIsStillCalling() {
        let app = launch(["-live-call-preview-slow-start"])
        openGmail(app)

        let start = app.buttons["live-call-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()

        let title = app.staticTexts["live-call-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Calling Pepper…")
        XCTAssertFalse(app.buttons["live-call-mute"].exists, "nothing to mute before the call is live")
        XCTAssertFalse(app.buttons["live-call-settings"].exists)
        let hangUp = app.buttons["live-call-hangup"]
        XCTAssertTrue(hangUp.exists, "calling offers a hang-up")
        record("Calling with a hang-up", app)

        hangUp.tap()
        let bar = app.otherElements["live-call-bar"]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bar)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(start.waitForExistence(timeout: 5), "the header offers a call again at once")

        // The held 201 lands now; the controller ends that call instead.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertFalse(bar.exists, "a late answer does not revive a call that was hung up")
        XCTAssertTrue(start.exists)
        record("After hanging up while calling", app)
    }

    /// Audio that never connects must not hold the line until the Mac's
    /// silence limit while OpenAI bills. The preview's answer goes in and
    /// nothing follows, as on a network that lets no WebRTC through: the
    /// bar waits on "Connecting…", then drops the call 20 s on and says why,
    /// and Try again makes a new call.
    @MainActor
    func testACallWhoseAudioNeverConnectsIsDropped() {
        let app = launch(["-live-call-preview-no-audio"])
        openGmail(app)
        let start = app.buttons["live-call-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()

        let title = app.staticTexts["live-call-title"]
        expectation(for: NSPredicate(format: "label == %@", "Connecting…"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
        record("Connecting, the audio never arrives", app)

        // Well inside the limit it still waits…
        Thread.sleep(forTimeInterval: 12)
        XCTAssertEqual(title.label, "Connecting…", "dropped before the connect timeout")

        // …and at the limit the phone gives up, with a way to try again.
        expectation(for: NSPredicate(format: "label == %@", "Call dropped: the audio could not connect."), evaluatedWith: title)
        waitForExpectations(timeout: 15)
        let retry = app.buttons["live-call-retry"]
        XCTAssertTrue(retry.exists)
        XCTAssertFalse(app.buttons["live-call-hangup"].exists, "no call left to hang up")
        XCTAssertTrue(app.buttons["Start dictation"].isEnabled, "the microphone is free again")
        record("Dropped: the audio could not connect", app)

        retry.tap()
        expectation(for: NSPredicate(format: "label == %@", "Connecting…"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
        app.buttons["live-call-hangup"].tap()
        let bar = app.otherElements["live-call-bar"]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: bar)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(start.waitForExistence(timeout: 5), "the header offers a new call")
    }

    /// The sheet's first read of the Mac's settings is slow here; a change
    /// made before it lands is answered first, and the read must not put
    /// the old value back.
    @MainActor
    func testAChangeMadeBeforeTheSettingsLoadIsKept() {
        let app = launch(["-live-call-preview-slow-config"])
        openGmail(app)
        startCall(app)

        app.buttons["live-call-settings"].tap()
        let toggle = app.switches["Read replies to typed messages"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertEqual(toggle.value as? String, "1", "the default while the Mac's settings load")
        flip(toggle)
        expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: toggle)
        waitForExpectations(timeout: 5)

        // The slow read lands after this (the preview holds it 3 s).
        Thread.sleep(forTimeInterval: 4)
        XCTAssertEqual(toggle.value as? String, "0", "the older read did not undo the saved change")
        record("Settings after the slow read", app)
        app.buttons["Done"].tap()
        app.buttons["live-call-hangup"].tap()
    }

    /// Neither the change nor a re-read reaches the Mac: the sheet says so,
    /// and the switch goes back to what the Mac last said rather than stay
    /// on screen as if saved.
    @MainActor
    func testAChangeThatCannotReachTheMacDoesNotStayOnScreen() {
        let app = launch(["-live-call-preview-settings-unreachable"])
        openGmail(app)
        startCall(app)

        app.buttons["live-call-settings"].tap()
        let toggle = app.switches["Read replies to typed messages"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let progress = app.activityIndicators.firstMatch
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: progress)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(toggle.value as? String, "1")
        flip(toggle)

        let error = app.descendants(matching: .any)["live-call-settings-error"]
        XCTAssertTrue(error.waitForExistence(timeout: 5), "the sheet says the change did not reach the Mac")
        expectation(for: NSPredicate(format: "value == '1'"), evaluatedWith: toggle)
        waitForExpectations(timeout: 5)
        record("Settings change that could not be saved", app)
        app.buttons["Done"].tap()
        app.buttons["live-call-hangup"].tap()
    }

    /// The idle hang-up offers the minutes every client offers, not a
    /// stepper's every minute, and a choice is saved as picked.
    @MainActor
    func testTheIdleHangUpOffersTheSharedMinutes() {
        let app = launch()
        openGmail(app)
        startCall(app)

        app.buttons["live-call-settings"].tap()
        let idle = app.descendants(matching: .any)["live-call-idle"]
        XCTAssertTrue(idle.waitForExistence(timeout: 5))
        let progress = app.activityIndicators.firstMatch
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: progress)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(shown(idle).contains("5 minutes"), shown(idle))

        idle.tap()
        for choice in ["1 minute", "2 minutes", "3 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "60 minutes"] {
            XCTAssertTrue(app.buttons[choice].waitForExistence(timeout: 5), choice)
        }
        XCTAssertFalse(app.buttons["4 minutes"].exists, "a stepper's minute is not a choice")
        record("Idle hang-up minutes", app)
        app.buttons["10 minutes"].tap()
        expectation(for: NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "10 minutes", "10 minutes"), evaluatedWith: idle)
        waitForExpectations(timeout: 5)
        app.buttons["Done"].tap()
        app.buttons["live-call-hangup"].tap()
    }

    /// While the voice talks its words reach the caption line many times a
    /// second. A tap in the settings sheet meanwhile must still land: the
    /// words redraw the caption line only, not the chat and the sheet over
    /// it, where a tap during a redraw was lost. Three sheets, each read
    /// afresh from the Mac, so one lost tap in any of them fails the test.
    @MainActor
    func testASettingChangedWhileTheVoiceTalksLands() {
        let app = launch(["-live-call-preview-chatty"])
        openGmail(app)
        startCall(app)
        let caption = app.staticTexts["live-call-caption"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "and on and on"), evaluatedWith: caption)
        waitForExpectations(timeout: 10)

        for round in 1...3 {
            app.buttons["live-call-settings"].tap()
            let toggle = app.switches["Read replies to typed messages"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5))
            let progress = app.activityIndicators.firstMatch
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: progress)
            waitForExpectations(timeout: 5)
            XCTAssertEqual(toggle.value as? String, "1", "round \(round): the Mac's setting")
            flip(toggle)
            expectation(for: NSPredicate(format: "value == '0'"), evaluatedWith: toggle)
            waitForExpectations(timeout: 5)
            if round == 3 { record("A setting changed while the voice talks", app) }
            app.buttons["Done"].tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: toggle)
            waitForExpectations(timeout: 5)
        }
        XCTAssertTrue(caption.label.contains("and on"), "the voice was still talking")
        app.buttons["live-call-hangup"].tap()
    }

    /// This phone's call holds the audio: a voice note in the chat cannot
    /// play meanwhile, and says so rather than ignore the tap.
    @MainActor
    func testAVoiceNoteWaitsForTheCallToEnd() {
        let app = launch()
        openGmail(app)
        let time = app.staticTexts["voice-note-time"]
        XCTAssertTrue(find(time, app: app), "the thread's voice note never appeared")
        let play = app.buttons["voice-note-play"]
        XCTAssertTrue(play.isEnabled)

        startCall(app)
        let reason = app.staticTexts["voice-note-blocked"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5), "the note says why it cannot play")
        XCTAssertEqual(reason.label, "Voice notes can’t play during a Live call.")
        XCTAssertFalse(play.isEnabled, "the play control is off during the call")
        record("Voice note during a call", app)

        app.buttons["live-call-hangup"].tap()
        XCTAssertTrue(time.waitForExistence(timeout: 10), "the note is back once the call is over")
        XCTAssertTrue(play.isEnabled)
    }

    /// The computer stops taking this phone's requests (it was unpaired)
    /// while the phone is on a call: the call hangs up at once, and the
    /// unpaired screen that replaces the chat says why it ended.
    @MainActor
    func testACallHangsUpWhenThisPhoneIsUnpaired() {
        let app = launch(["-live-call-preview-revoke"])
        openGmail(app)
        startCall(app)

        // Any refused request will do; the preview refuses the next settings change.
        app.buttons["live-call-settings"].tap()
        let toggle = app.switches["Read replies to typed messages"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let progress = app.activityIndicators.firstMatch
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: progress)
        waitForExpectations(timeout: 5)
        flip(toggle)

        let notice = app.staticTexts["live-call-signed-out"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "the unpaired screen says why the call ended")
        XCTAssertEqual(notice.label, "Call ended: you were signed out.")
        XCTAssertTrue(app.buttons["Pair again"].exists)
        XCTAssertFalse(app.buttons["live-call-hangup"].exists, "no call left to hang up")
        XCTAssertFalse(app.buttons["live-call-retry"].exists, "pairing again is the way on")
        record("Unpaired during a call", app)
    }

    /// The Mac holds a call on this chat: the remote bar, its clock running,
    /// where the call is on a line of its own, and a hang-up that takes it
    /// down on the Mac's answer.
    @MainActor
    func testAnotherDevicesCallShowsARemoteBarWithARunningClock() {
        let app = launch(["-live-call-remote-preview"])
        openGmail(app)

        let title = app.staticTexts["live-call-remote-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Live with Pepper")
        let clock = app.staticTexts["live-call-remote-clock"]
        XCTAssertTrue(clock.label.hasPrefix("1:"), clock.label)
        XCTAssertEqual(app.staticTexts["live-call-remote-device"].label, "From your computer")
        XCTAssertFalse(app.buttons["live-call-start"].exists, "no call from the header while the Mac holds the line")
        let bar = remoteBar(app)
        assertTheLineKeepsTheClock(name: title, clock: clock, before: app.buttons["live-call-remote-hangup"], in: bar)
        assertWhole(app.staticTexts["live-call-remote-device"], in: bar)
        assertTheChatEndsAbove(bar, app)
        record("Remote bar", app)

        let first = clock.label
        expectation(for: NSPredicate(format: "label != %@", first), evaluatedWith: clock)
        waitForExpectations(timeout: 4)

        app.buttons["live-call-remote-hangup"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: title)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["live-call-start"].waitForExistence(timeout: 5), "the line is free again")
        record("After the remote hang-up", app)
    }

    /// A bot name too long for the bar's line gives way; the clock, where the
    /// call is and the buttons never do: on the remote bar, then on this
    /// phone's own call.
    @MainActor
    func testALongBotNameGivesWayToTheClock() {
        let app = launch(["-live-call-remote-preview", "-live-call-long-name-preview"])
        openGmail(app)

        let remoteName = app.staticTexts["live-call-remote-title"]
        XCTAssertTrue(remoteName.waitForExistence(timeout: 5))
        XCTAssertEqual(remoteName.label, "Live with \(Self.longName)", "the whole name, for VoiceOver")
        let bar = remoteBar(app)
        let remoteHangUp = app.buttons["live-call-remote-hangup"]
        assertTheLineKeepsTheClock(name: remoteName, clock: app.staticTexts["live-call-remote-clock"], before: remoteHangUp, in: bar)
        let device = app.staticTexts["live-call-remote-device"]
        XCTAssertEqual(device.label, "From your computer")
        assertWhole(device, in: bar)
        record("Remote bar with a long name", app)

        remoteHangUp.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: remoteName)
        waitForExpectations(timeout: 5)

        startCall(app)
        let name = app.staticTexts["live-call-title"]
        XCTAssertEqual(name.label, "Live with \(Self.longName)")
        assertTheLineKeepsTheClock(
            name: name, clock: app.staticTexts["live-call-clock"], before: app.buttons["live-call-settings"],
            in: app.otherElements["live-call-bar"]
        )
        XCTAssertTrue(app.buttons["live-call-hangup"].isHittable)
        record("Live call bar with a long name", app)
        app.buttons["live-call-hangup"].tap()
    }

    /// While this phone is on a call, a room's chat carries the banner back
    /// to it, as the roster and other bots' chats do.
    @MainActor
    func testARoomShowsTheBannerWhileThisPhoneIsOnACall() {
        let app = launch(["-live-call-room-preview"])
        openGmail(app)
        startCall(app)
        let start = app.buttons["live-call-start"]

        app.buttons["Back"].tap()
        let room = app.buttons["chat-row.preview-room"]
        XCTAssertTrue(room.waitForExistence(timeout: 5))
        room.tap()
        XCTAssertTrue(app.descendants(matching: .any)["message-input"].waitForExistence(timeout: 5))
        // The preview answers no room routes, so opening one raises the
        // app's error alert; it is not what this test is about.
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons["OK"].tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: alert)
            waitForExpectations(timeout: 5)
        }

        let banners = app.buttons.matching(identifier: "live-call-banner")
        XCTAssertTrue(banners.firstMatch.waitForExistence(timeout: 5))
        let banner = banners.allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(banner, "the room's own banner, not the roster's behind it")
        XCTAssertTrue(banner?.label.hasPrefix("On a call with Pepper") ?? false, banner?.label ?? "no banner")
        record("Room with the call banner", app)

        // The banner leads back: to the roster, whose banner opens the call.
        banner?.tap()
        XCTAssertTrue(room.waitForExistence(timeout: 5))
        let rosterBanner = app.buttons["live-call-banner"]
        XCTAssertTrue(rosterBanner.waitForExistence(timeout: 5))
        rosterBanner.tap()
        let hangUp = app.buttons["live-call-hangup"]
        XCTAssertTrue(hangUp.waitForExistence(timeout: 5))
        hangUp.tap()
        XCTAssertTrue(start.waitForExistence(timeout: 10))
    }

    // MARK: - Helpers

    /// The settings sheet's words on what reaches OpenAI (the shared
    /// disclosure, and the typed-replies switch's description).
    private static let disclosure = "A Live call sends your voice to OpenAI, along with the chat's recent messages, the bot's answers and the details of any approval it asks for. The OpenAI key stays on your computer."
    private static let typedRepliesOff = "When this is off, messages you type during a call and the bot's answers to them are not sent to OpenAI."
    /// Pepper's name under `-live-call-long-name-preview`: 40 characters.
    private static let longName = "Pepper, the Quarterly Planning Assistant"
    /// The newest message in Pepper's Gmail thread (the preview's).
    private static let newestMessage = "Here’s this morning’s triage as a voice note."

    /// The remote bar, by the id it carries on its own or the bars' shared one.
    @MainActor
    private func remoteBar(_ app: XCUIApplication) -> XCUIElement {
        app.otherElements.matching(NSPredicate(format: "identifier IN %@", ["live-call-remote-bar", "live-call-bar"])).firstMatch
    }

    /// The bar's line gives way at the name only: the name ends where the
    /// clock starts, and the whole clock sits in the bar before `button`.
    @MainActor
    private func assertTheLineKeepsTheClock(
        name: XCUIElement, clock: XCUIElement, before button: XCUIElement, in bar: XCUIElement,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(name.exists && clock.exists && button.exists, "the name, the clock and the button are there", file: file, line: line)
        XCTAssertLessThanOrEqual(name.frame.maxX, clock.frame.minX + 0.5, "the name runs into the clock", file: file, line: line)
        XCTAssertLessThanOrEqual(clock.frame.maxX, button.frame.minX, "the clock runs into the button", file: file, line: line)
        assertWhole(clock, in: bar, file: file, line: line)
        assertWhole(button, in: bar, file: file, line: line)
    }

    @MainActor
    private func assertWhole(_ element: XCUIElement, in bar: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.exists, "\(element) is missing", file: file, line: line)
        XCTAssertFalse(element.frame.isEmpty, "\(element.identifier) has no size", file: file, line: line)
        XCTAssertTrue(bar.frame.contains(element.frame), "\(element.identifier) \(element.frame) is cut off by the bar \(bar.frame)", file: file, line: line)
    }

    /// Nothing of the chat's end is under the bar: the newest message and the
    /// typing dots after it end above the bar's top.
    @MainActor
    private func assertTheChatEndsAbove(_ bar: XCUIElement, _ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(bar.exists, "no bar", file: file, line: line)
        let newest = Self.text(Self.newestMessage, in: app)
        XCTAssertTrue(newest.exists, "the newest message is not on screen", file: file, line: line)
        XCTAssertLessThanOrEqual(newest.frame.maxY, bar.frame.minY, "the newest message runs under the bar", file: file, line: line)
        let working = app.descendants(matching: .any)["typing-indicator"]
        if working.exists {
            XCTAssertLessThanOrEqual(working.frame.maxY, bar.frame.minY, "the typing dots run under the bar", file: file, line: line)
        }
    }

    /// A text found by its whole label. XCTest refuses a subscript identifier
    /// longer than 128 characters, and the disclosure is longer than that.
    @MainActor
    private static func text(_ label: String, in element: XCUIElement) -> XCUIElement {
        element.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// `disclosureShown`: whether this phone already made a Live call and
    /// so skips the first-call disclosure (true for every test but the one
    /// about it). The launch argument outranks what an earlier run stored;
    /// nil leaves what this phone has stored.
    @MainActor
    private func launch(_ extra: [String] = [], disclosureShown: Bool? = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.terminate()
        let disclosure = disclosureShown.map { ["-companion.prefs.liveDisclosureShown", $0 ? "YES" : "NO"] } ?? []
        app.launchArguments = ["-store-preview", "-threads-preview", "-live-call-preview"] + extra + disclosure + [
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
            "-companion.prefs.islandIntro", "never",
            "-companion.onboarding.welcomeSeen", "YES",
            "-companion.onboarding.notificationsSeen", "YES"]
        app.launch()
        if app.buttons["Connect computer"].exists {
            app.terminate()
            app.launch()
        }
        return app
    }

    @MainActor
    private func openGmail(_ app: XCUIApplication) {
        let toggle = app.buttons["threads-toggle.preview-pepper"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        let gmail = app.buttons["thread.preview-gmail"]
        XCTAssertTrue(gmail.waitForExistence(timeout: 5))
        gmail.tap()
    }

    @MainActor
    private func startCall(_ app: XCUIApplication) {
        let start = app.buttons["live-call-start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.tap()
        let title = app.staticTexts["live-call-title"]
        expectation(for: NSPredicate(format: "label BEGINSWITH %@", "Live with Pepper"), evaluatedWith: title)
        waitForExpectations(timeout: 10)
    }

    /// What a Form picker row shows: its label and the chosen value, which
    /// iOS reports as the label or as the value depending on the version.
    @MainActor
    private func shown(_ element: XCUIElement) -> String {
        "\(element.label) \(element.value as? String ?? "")"
    }

    /// A Form toggle's element is the whole row; the switch is at its end.
    @MainActor
    private func flip(_ toggle: XCUIElement) {
        let inner = toggle.switches.firstMatch
        if inner.exists { inner.tap() } else { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap() }
    }

    /// Scroll the transcript either way until `element` shows.
    @MainActor
    private func find(_ element: XCUIElement, app: XCUIApplication, maxSwipes: Int = 8) -> Bool {
        for _ in 0..<maxSwipes {
            if element.exists { return true }
            app.swipeUp(velocity: .fast)
        }
        return scrollUp(to: element, app: app, maxSwipes: maxSwipes * 2)
    }

    @MainActor
    private func scrollUp(to element: XCUIElement, app: XCUIApplication, maxSwipes: Int = 10) -> Bool {
        for _ in 0..<maxSwipes {
            if element.exists { return true }
            app.swipeDown(velocity: .fast)
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
