import XCTest
@testable import CompanionCore

final class ProfileRoutinePolicyTests: XCTestCase {
    func testOnlyFutureOneTimeRoutinesCanToggle() {
        let now = Date(timeIntervalSince1970: 2_000)

        XCTAssertTrue(routine(schedule: .daily(time: "09:00", weekdays: [1])).canToggle(at: now))
        XCTAssertTrue(
            routine(schedule: .interval(everyMinutes: 5, anchorAt: now.addingTimeInterval(-3_600)))
                .canToggle(at: now),
            "an interval remains resumable after its anchor because future occurrences still exist"
        )
        XCTAssertFalse(
            routine(schedule: .init(type: .interval, everyMinutes: 4, anchorAt: 1_000))
                .canToggle(at: now),
            "a malformed interval must not become toggleable merely because its type is known"
        )
        XCTAssertTrue(routine(schedule: .once(at: now.addingTimeInterval(1))).canToggle(at: now))
        XCTAssertFalse(routine(schedule: .once(at: now)).canToggle(at: now))
        XCTAssertFalse(routine(schedule: .once(at: now.addingTimeInterval(-1))).canToggle(at: now))
        XCTAssertFalse(
            routine(schedule: .init(type: .unknown, at: now.addingTimeInterval(1).timeIntervalSince1970 * 1_000))
                .canToggle(at: now),
            "an unsupported kind stays non-toggleable even when it happens to carry a future at field"
        )
    }

    func testCloudRunAvailabilityMatchesDesktopRequirements() throws {
        let configured = try decodeConfig(#"{"box":{"configured":true}}"#)
        let unconfigured = try decodeConfig(#"{"box":{"configured":false}}"#)
        let available = try decodeInstances(state: "available")
        let unavailable = try decodeInstances(state: "unavailable")

        XCTAssertFalse(RoutineRunAvailability(config: unconfigured, instances: available).cloudReady)
        XCTAssertFalse(RoutineRunAvailability(config: configured, instances: unavailable).cloudReady)

        let ready = RoutineRunAvailability(config: configured, instances: available)
        XCTAssertTrue(ready.cloudReady)
        XCTAssertTrue(ready.canSelect(.cloud, preserving: .maus))

        let offline = RoutineRunAvailability(config: configured, instances: unavailable)
        XCTAssertFalse(offline.canSelect(.cloud, preserving: .maus))
        XCTAssertTrue(offline.canSelect(.cloud, preserving: .cloud), "an existing cloud routine must not silently move")
        XCTAssertTrue(offline.canSelect(.maus, preserving: .cloud))
    }

    func testAgentVoiceWorksWithoutANonexistentWorkspaceDefault() throws {
        let keyOnly = try decodeConfig(#"{"tts":{"configured":true,"ready":false,"voice":""}}"#)
        XCTAssertTrue(keyOnly.isTTSConfigured)
        XCTAssertFalse(keyOnly.hasWorkspaceDefaultVoice)
        XCTAssertFalse(keyOnly.canSpeak(agentVoice: nil))
        XCTAssertTrue(keyOnly.canSpeak(agentVoice: "agent-voice"))

        let withDefault = try decodeConfig(#"{"tts":{"configured":true,"ready":true,"voice":"workspace-voice"}}"#)
        XCTAssertTrue(withDefault.hasWorkspaceDefaultVoice)
        XCTAssertTrue(withDefault.canSpeak(agentVoice: nil))
    }

    func testProviderSwitchClearsTheOpenProfilesProviderSpecificVoice() throws {
        let fishWithoutDefault = try decodeConfig(
            #"{"tts":{"configured":true,"ready":false,"provider":"fish","voice":""}}"#
        )
        let stale = AgentProfileVoiceState(
            voice: "elevenlabs-voice",
            speakReplies: true,
            baselineVoice: "elevenlabs-voice"
        )

        let reset = stale.afterProviderSwitch(to: fishWithoutDefault)

        XCTAssertEqual(reset.voice, "")
        XCTAssertEqual(reset.baselineVoice, "")
        XCTAssertFalse(reset.speakReplies, "speech cannot stay enabled with no valid voice")
    }

    func testOnlyTheEngineTheServerNamesGetsItsOwnExplanation() throws {
        // The built-in engine is the reason "configured" stopped meaning "a
        // key is on file" — so the copy that explains a false has to know
        // which engine it is talking about.
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":false,"provider":"system"}}"#).voiceProvider, .system)
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":true,"provider":"chatterbox"}}"#).voiceProvider, .chatterbox)
        XCTAssertEqual(try decodeConfig(#"{"tts":{"configured":true,"provider":"fish"}}"#).voiceProvider, .fish)

        // Every known engine uses an exact wire value; everything else falls
        // back to ElevenLabs, matching `voiceProvider(cfg)` in
        // `server/tts/index.ts`. Each case is asserted on its own, because a rule that
        // merely matched "system" loosely would still pass the assertion
        // above while explaining someone's ElevenLabs setup as a Mac voice.
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":true,"ready":true,"voice":"v"}}"#).voiceProvider, .elevenlabs,
            "a computer older than the choice does not send the field at all"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":true,"provider":"elevenlabs"}}"#).voiceProvider, .elevenlabs
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"System"}}"#).voiceProvider, .elevenlabs,
            "only the exact string the server writes selects the built-in engine"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"cartesia"}}"#).voiceProvider, .elevenlabs,
            "an engine this build has never heard of must not borrow another engine's copy"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"Chatterbox"}}"#).voiceProvider, .elevenlabs,
            "capitalisation is not the server's spelling; the address fields stay hidden for it"
        )
        XCTAssertEqual(
            try decodeConfig(#"{"tts":{"configured":false,"provider":"system-voices"}}"#).voiceProvider, .elevenlabs,
            "a future engine whose name merely contains the old one is still unknown: matching loosely would explain it with Mac-voice copy and a Mac-voice remedy"
        )
        XCTAssertEqual(
            try decodeConfig("{}").voiceProvider, .elevenlabs,
            "no voice block at all is not the built-in engine either"
        )

        // The flag itself stays provider-neutral: the meaning of a true moved,
        // not its shape, and nothing above may quietly change who can speak.
        XCTAssertTrue(try decodeConfig(#"{"tts":{"configured":true,"provider":"system","voice":"Albert"}}"#).canSpeak(agentVoice: nil))
        XCTAssertFalse(try decodeConfig(#"{"tts":{"configured":false,"provider":"system","voice":"Albert"}}"#).canSpeak(agentVoice: nil))
    }

    func testChatterboxAddressArrivesOnlyWithTheEngineThatNeedsIt() throws {
        // Chatterbox's credential is an address, not a key, so the status
        // carries it — and only it — for the picker to prefill.
        let chatterbox = try decodeConfig(
            #"{"tts":{"configured":true,"provider":"chatterbox","baseUrl":"http://127.0.0.1:4123","model":"chatterbox-turbo"}}"#
        )
        XCTAssertEqual(chatterbox.tts?.baseUrl, "http://127.0.0.1:4123")
        XCTAssertEqual(chatterbox.tts?.model, "chatterbox-turbo")

        // Every other engine — and an older computer — sends nothing to read.
        let elevenlabs = try decodeConfig(#"{"tts":{"configured":true,"provider":"elevenlabs"}}"#)
        XCTAssertNil(elevenlabs.tts?.baseUrl)
        XCTAssertNil(elevenlabs.tts?.model)
    }

    private func routine(schedule: RoutineSchedule) -> Routine {
        Routine(
            id: "routine-1",
            name: "Brief",
            prompt: "Summarize",
            botId: "bot-1",
            runOn: "maus",
            enabled: false,
            schedule: schedule,
            durationMinutes: 30,
            timeoutMinutes: nil,
            nextRunAt: nil,
            createdAt: 1,
            updatedAt: 1
        )
    }

    private func decodeConfig(_ json: String) throws -> ConfigStatus {
        try JSONDecoder().decode(ConfigStatus.self, from: Data(json.utf8))
    }

    private func decodeInstances(state: String) throws -> [Instance] {
        let json = """
        {"instances":[{
          "instanceId":"box-1","driverKind":"boxAgent",
          "snapshot":{"state":"\(state)"},
          "models":{"default":"model-1","options":[]}
        }]}
        """
        return try JSONDecoder().decode(InstanceList.self, from: Data(json.utf8)).instances
    }
}
