// On-device dictation for the composer.
//
// Same engine as the desktop helper (`electron/resources/speech-helper.swift`):
// `SFSpeechRecognizer` on an `AVAudioEngine` tap, partials streamed into the
// text field, press to stop. Composer mode, not call mode — there is no
// silence endpointing. The phone is better at this than the Mac was: the
// recognizer is in the same process as the field, so there is no helper
// binary, no TCC bundle dance, and no `open -W`.
//
// On-device when the recognizer supports it, so talking to a bot does not
// become talking to Apple's servers. Locales come from `Dictation.localeCandidates`
// rather than a hardcoded en-US, for the same reason the desktop helper
// stopped hardcoding one.
//
// Lives in the app target on purpose. CompanionCore is Foundation-only so
// `swift test` can run without a simulator; Speech and AVAudioEngine are
// the opposite of that.
import AVFoundation
import Combine
import Speech
import CompanionCore
import SwiftUI

@MainActor
final class SpeechDictation: ObservableObject {
    private static let cancellationCodes: [String: Set<Int>] = [
        "kLSRErrorDomain": [209, 216],
        "kAFAssistantErrorDomain": [216],
    ]

    @Published private(set) var isListening = false
    /// True from `start` until capture is running or the attempt fails.
    /// Publishing it keeps the frozen composer base protected while the
    /// system permission sheets are still in flight.
    @Published private(set) var isStarting = false
    @Published private(set) var transcript = ""
    @Published private(set) var error: LocalizedStringKey?

    /// Composer text captured when listening started. Frozen for the
    /// session so each partial replaces the last rather than stacking.
    /// ChatView reads this from `onChange(of: transcript)` and must not
    /// substitute the live draft.
    private(set) var base = ""

    private var recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var stopping = false
    /// Bumped on every start/stop so an authorization that finishes after
    /// the user already cancelled cannot open the mic.
    private var generation = 0
    private var startTask: Task<Void, Never>?

    func toggle(capturing base: String) {
        if isListening || isStarting {
            stop()
        } else {
            start(base: base)
        }
    }

    private func start(base: String) {
        guard !isListening, !isStarting else { return }
        error = nil
        self.base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        transcript = ""
        isStarting = true
        generation += 1
        let gen = generation
        startTask = Task { await actuallyStart(generation: gen) }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        generation += 1
        isStarting = false
        stopping = true
        isListening = false
        teardown()
    }

    // MARK: - Authorization

    private func actuallyStart(generation gen: Int) async {
        let speech = await requestSpeechAuthorization()
        guard gen == generation, !Task.isCancelled else {
            return
        }
        guard speech == .authorized else {
            isStarting = false
            error = Self.speechDeniedMessage
            return
        }

        let mic = await AVAudioApplication.requestRecordPermission()
        guard gen == generation, !Task.isCancelled else {
            return
        }
        guard mic else {
            isStarting = false
            error = Self.micDeniedMessage
            return
        }

        do {
            try beginCapture(generation: gen)
            isStarting = false
        } catch CaptureError.noRecognizer {
            isStarting = false
            error = "Dictation isn't available for this language."
            teardown()
        } catch {
            isStarting = false
            self.error = "Couldn't start the microphone."
            teardown()
        }
    }

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    // MARK: - Capture

    private func beginCapture(generation gen: Int) throws {
        let recognizer = Dictation.localeCandidates()
            .compactMap { SFSpeechRecognizer(locale: $0) }
            .first { $0.isAvailable }
        guard let recognizer else {
            throw CaptureError.noRecognizer
        }
        self.recognizer = recognizer

        let session = AVAudioSession.sharedInstance()
        // `.record` rather than `.playAndRecord`: this is composer
        // dictation, not a call, and holding the playback route would
        // duck whatever else is on the phone for no reason.
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // The desktop helper does not set this (it is a CLI talking to an
        // older Speech.framework), but a chat message is better with the
        // commas the recognizer already knows about.
        request.addsPunctuation = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        // Keep the engine on self before start() so a throw still has
        // something for teardown to remove the tap from. A local engine
        // that fails to start would leave tapInstalled true and the next
        // teardown would removeTap on a new engine that has none — which
        // is an exception, not a no-op.
        audioEngine = engine
        recognitionRequest = request

        // The tap format is only valid after the session is active.
        // Installing against a 0-channel format is the usual "it works
        // in the sample and fails here" failure.
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 else {
            throw CaptureError.silentInput
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()

        stopping = false
        isListening = true

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, recognitionError in
            Task { @MainActor in
                self?.handle(
                    result: result,
                    recognitionError: recognitionError,
                    generation: gen
                )
            }
        }
    }

    private func handle(
        result: SFSpeechRecognitionResult?,
        recognitionError: Error?,
        generation gen: Int
    ) {
        // A cancelled task can still deliver a partial or a 209 after the
        // next session has already started. `isListening` is true then too,
        // so generation is what keeps this callback from rewriting the
        // new draft or stopping the new capture.
        guard gen == generation, !stopping, isListening else { return }
        if let result {
            transcript = Dictation.updateTranscript(transcript, new: result.bestTranscription.formattedString)
            // Composer dictation does not wait for isFinal — the last
            // partial is what you send. If the recognizer finalizes on
            // its own (rare without endAudio), just stop listening.
            if result.isFinal {
                stop()
                return
            }
        }
        guard let recognitionError else { return }
        let ns = recognitionError as NSError
        // Speech uses separate internal domains for local-recognizer and
        // assistant cancellation. Keep the observed codes scoped to their
        // domains: other values (notably assistant 1110, no speech) are real
        // recognition failures and should remain visible.
        if Self.cancellationCodes[ns.domain]?.contains(ns.code) == true {
            stop()
            return
        }
        self.error = "Couldn't transcribe that."
        stop()
    }

    private func teardown() {
        // Drop the tap before ending the request: a buffer that arrives
        // after endAudio() can fail the task instead of being ignored.
        if let engine = audioEngine {
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            if engine.isRunning { engine.stop() }
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        audioEngine = nil
        recognizer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum CaptureError: Error {
        case silentInput
        case noRecognizer
    }

    static let speechDeniedMessage: LocalizedStringKey =
        "Dictation needs Speech Recognition access. Enable it in Settings → OpenMausMobile."
    static let micDeniedMessage: LocalizedStringKey =
        "Dictation needs Microphone access. Enable it in Settings → OpenMausMobile."
}
