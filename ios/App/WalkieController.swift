// Walkie mode's engine: hold to talk, check the words, send, hear the answer.
//
// Listening runs on `WalkieMic`, which is kept warm while Walkie is open so a
// press starts at once. Letting go waits briefly for the recognizer's final
// transcript and puts it up for review — editable, with Send and Discard —
// because a misheard word sent to an agent is work done wrong. Sending is
// `Session.send`, so the message lands in the bot's current thread like any
// other. Listening is Apple's recognizer on the phone; the answer is spoken
// by ElevenLabs, called straight from the phone with a key kept in its
// Keychain. Without a key, or when ElevenLabs fails, the phone's best
// installed voice reads it instead.
import AVFoundation
import CompanionCore
import Speech
import SwiftUI

/// One row of the Walkie roster: a bot and the most urgent thing about it.
struct WalkieAgent: Identifiable, Hashable {
    enum Status: Int, Comparable {
        case needsYou = 0, working, done, idle
        static func < (a: Status, b: Status) -> Bool { a.rawValue < b.rawValue }

        var label: LocalizedStringKey {
            switch self {
            case .needsYou: "Needs you"
            case .working: "Working"
            case .done: "Done"
            case .idle: "Idle"
            }
        }
    }

    let bot: Bot
    let status: Status
    let line: String
    var id: String { bot.id }
}

extension CompanionState {
    /// Every visible bot, most urgent first. The status is the Updates
    /// logic folded to one row per bot, so Walkie and the Updates pill never
    /// disagree about who needs you.
    var walkieRoster: [WalkieAgent] {
        var byBot: [String: ChatUpdate] = [:]
        for update in updates {
            if case let .bot(bot) = update.chat, byBot[bot.id] == nil { byBot[bot.id] = update }
        }
        let rows = bots.filter { $0.hidden != true }.map { bot -> WalkieAgent in
            guard let update = byBot[bot.id] else {
                let about = bot.description.split(whereSeparator: \.isNewline).first.map(String.init)
                return WalkieAgent(bot: bot, status: .idle, line: about ?? String(localized: "Ready"))
            }
            let status: WalkieAgent.Status = switch update.kind {
            case .needsYou: .needsYou
            case .working: .working
            case .toReview: .done
            }
            let line = update.line.isEmpty ? String(localized: "Finished — tap Replay or open the chat") : update.line
            return WalkieAgent(bot: bot, status: status, line: line)
        }
        return rows.enumerated()
            .sorted { ($0.element.status, $0.offset) < ($1.element.status, $1.offset) }
            .map(\.element)
    }
}

@MainActor
final class WalkieController: ObservableObject {
    enum Phase: Equatable { case idle, listening, transcribing, review, sending, waiting, speaking }

    @Published private(set) var phase: Phase = .idle
    /// The live transcript while you hold the button.
    @Published private(set) var heard = ""
    /// What Send will send: the transcript, editable while reviewing.
    @Published var draft = ""
    /// The last answer, and who gave it.
    @Published private(set) var reply = ""
    @Published private(set) var replyFrom = ""
    /// One short line when something needs your attention.
    @Published private(set) var note: String?

    var speaksReplies = true {
        didSet { if !speaksReplies { stopVoice() } }
    }

    private let mic = WalkieMic()
    private let player = WalkiePlayer()
    private let synthesizer = AVSpeechSynthesizer()
    private let voiceDelegate = VoiceDelegate()

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognition: SFSpeechRecognitionTask?
    private var finalArrived = false
    private var finalWaiter: CheckedContinuation<Void, Never>?
    private var ready = false
    private var preparing = false
    private var startWhenReady = false

    private var pending: Pending?
    private var replyVoice: String?
    private var speaking: Task<Void, Never>?
    private var deviceWaiter: CheckedContinuation<Void, Never>?

    private struct Pending {
        let threadId: String
        let name: String
        let voiceId: String?
        let baseline: Set<String>
        let sentAt: Date
    }

    /// Stop waiting for an answer after this long; the chat still gets it.
    private static let patience: TimeInterval = 10 * 60
    /// How long a release waits for the recognizer's final words.
    private static let finalGrace: Duration = .milliseconds(1200)

    init() {
        synthesizer.delegate = voiceDelegate
        voiceDelegate.onFinish = { [weak self] in
            self?.deviceWaiter?.resume()
            self?.deviceWaiter = nil
        }
    }

    // MARK: - Microphone

    /// Ask for access and start the microphone, so a press listens at once.
    func prepare() async {
        guard !ready, !preparing else { return }
        preparing = true
        defer { preparing = false }

        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized, await AVAudioApplication.requestRecordPermission() else {
            return fail(String(localized: "Walkie needs Microphone and Speech Recognition access. Turn them on in Settings."))
        }
        recognizer = Dictation.localeCandidates()
            .compactMap { SFSpeechRecognizer(locale: $0) }
            .first { $0.isAvailable }
        guard recognizer != nil else {
            return fail(String(localized: "Speech recognition isn't available for this language."))
        }
        do {
            try await mic.warm()
        } catch {
            return fail(String(localized: "Couldn't start the microphone."))
        }
        ready = true
        if startWhenReady, phase == .listening {
            startWhenReady = false
            startRecognition()
        }
    }

    /// Give the microphone back: leaving Walkie, or the app leaving the screen.
    func suspend() {
        cancelRecognition()
        mic.cool()
        ready = false
        startWhenReady = false
        if phase == .listening || phase == .transcribing { phase = .idle }
    }

    private func fail(_ message: String) {
        note = message
        startWhenReady = false
        if phase == .listening { phase = .idle }
    }

    // MARK: - Talking

    func pressBegan() {
        guard [.idle, .waiting, .speaking].contains(phase) else { return }
        stopVoice()
        note = nil
        heard = ""
        phase = .listening
        Haptics.impact(.medium)
        if ready {
            startRecognition()
        } else {
            startWhenReady = true
            Task { await prepare() }
        }
    }

    private func startRecognition() {
        guard let recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let id = ObjectIdentifier(request)
        self.request = request
        finalArrived = false
        mic.route(request)
        recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let done = result?.isFinal == true || error != nil
            Task { @MainActor in self?.recognized(text, done: done, for: id) }
        }
    }

    private func recognized(_ text: String?, done: Bool, for id: ObjectIdentifier) {
        guard let request, ObjectIdentifier(request) == id else { return }
        if let text, !text.isEmpty, phase == .listening || phase == .transcribing { heard = text }
        if done { resumeFinal() }
    }

    func pressEnded() async {
        guard phase == .listening else { return }
        startWhenReady = false
        Haptics.impact(.light)
        guard let request else {
            phase = .idle
            note = String(localized: "Didn't catch that. Keep holding the button while you talk.")
            return
        }
        phase = .transcribing
        mic.route(nil)
        request.endAudio()
        await waitForFinal()
        cancelRecognition()
        let words = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            phase = .idle
            note = String(localized: "Didn't catch that. Keep holding the button while you talk.")
            return
        }
        draft = words
        phase = .review
    }

    private func waitForFinal() async {
        guard !finalArrived else { return }
        await withCheckedContinuation { continuation in
            finalWaiter = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.finalGrace)
                self?.resumeFinal()
            }
        }
    }

    private func resumeFinal() {
        finalArrived = true
        finalWaiter?.resume()
        finalWaiter = nil
    }

    private func cancelRecognition() {
        mic.route(nil)
        recognition?.cancel()
        recognition = nil
        request = nil
        resumeFinal()
    }

    func discard() {
        draft = ""
        heard = ""
        note = nil
        phase = .idle
    }

    func send(session: Session, target: Bot?) async {
        guard phase == .review else { return }
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return discard() }
        guard let target else {
            note = String(localized: "Pick an agent to talk to first.")
            return
        }
        heard = words
        note = nil
        phase = .sending
        Haptics.impact(.light)
        let baseline = Set(session.state.transcript(forThread: target.threadId).map(\.id))
        session.actionError = nil
        await session.send(words, to: .bot(target))
        if let error = session.actionError {
            // Said here, where you are looking, rather than as an alert
            // behind this full-screen view. The draft stays for a retry.
            session.actionError = nil
            phase = .review
            note = error
            return
        }
        draft = ""
        pending = Pending(
            threadId: target.threadId, name: target.name, voiceId: target.voice,
            baseline: baseline, sentAt: Date()
        )
        reply = ""
        phase = .waiting
        observe(session.state)
    }

    /// Called on every state change; speaks the answer once the turn settles.
    func observe(_ state: CompanionState) {
        guard phase == .waiting, let pending else { return }
        let busy = state.bot(forThread: pending.threadId)?.currentTaskBusy == true
        if let answer = Walkie.settledReply(
            transcript: state.transcript(forThread: pending.threadId),
            baseline: pending.baseline,
            busy: busy
        ) {
            self.pending = nil
            reply = answer
            replyFrom = pending.name
            replyVoice = pending.voiceId
            Haptics.success()
            if speaksReplies { speak(answer) } else { phase = .idle }
        } else if Date().timeIntervalSince(pending.sentAt) > Self.patience {
            self.pending = nil
            phase = .idle
            note = String(localized: "\(pending.name) is still working. The answer will be in the chat.")
        }
    }

    func replay() {
        guard !reply.isEmpty else { return }
        speak(reply)
    }

    /// Stop talking if the phone is talking; otherwise stop the bot's turn.
    func stop(session: Session, target: Bot?) async {
        if phase == .speaking { return stopVoice() }
        guard let target, target.currentTaskBusy == true else { return }
        await session.interrupt(bot: target)
        pending = nil
        phase = .idle
        note = String(localized: "Stopped \(target.name).")
    }

    func shutdown() {
        suspend()
        stopVoice()
        pending = nil
        phase = .idle
    }

    // MARK: - Voice

    /// A short line in the current voice settings, for the voice sheet.
    func sample(agentVoice: String?) {
        replyVoice = agentVoice
        speak(String(localized: "Hi. This is how your agents will sound in Walkie."))
    }

    private func speak(_ text: String) {
        stopVoice()
        let parts = Walkie.utterances(Walkie.speakable(text))
        guard !parts.isEmpty else { return }
        phase = .speaking
        let agentVoice = replyVoice
        speaking = Task { [weak self] in
            await self?.play(parts, agentVoice: agentVoice)
            guard let self, !Task.isCancelled else { return }
            self.speaking = nil
            if self.phase == .speaking { self.phase = .idle }
        }
    }

    /// ElevenLabs from this phone, one utterance at a time, fetching the next
    /// while the current one plays. The first utterance settles the voice: an
    /// agent's voice from another ElevenLabs account falls through to the one
    /// chosen here. Without a key, or on any failure, the phone's own voice
    /// reads the rest.
    private func play(_ parts: [String], agentVoice: String?) async {
        guard let key = WalkieVoiceKey.read() else {
            note = String(localized: "Add your ElevenLabs key with the voice button at the top. Using the phone's voice for now.")
            return await deviceSpeak(parts.joined(separator: " "))
        }
        let defaults = UserDefaults.standard
        let useAgentVoices = defaults.object(forKey: WalkieVoicePrefs.useAgentVoices) as? Bool ?? true
        let chosen = defaults.string(forKey: WalkieVoicePrefs.voiceId)
        var candidates: [String] = []
        for voice in [useAgentVoices ? agentVoice : nil, chosen, ElevenLabs.defaultVoiceId] {
            if let voice, !voice.isEmpty, !candidates.contains(voice) { candidates.append(voice) }
        }

        var voice = ElevenLabs.defaultVoiceId
        var audio: Data?
        var failure: Error?
        for candidate in candidates {
            do {
                audio = try await ElevenLabs.speech(text: parts[0], voiceId: candidate, key: key)
                voice = candidate
                break
            } catch {
                guard !Task.isCancelled else { return }
                failure = error
                // A key, credit or rate problem is the same for every voice.
                if let status = (error as? ElevenLabs.Failure)?.status, [401, 402, 403, 429].contains(status) { break }
            }
        }
        guard var current = audio else {
            return await fallBack(parts, failure: failure)
        }

        for index in parts.indices {
            var next: Task<Data, Error>?
            if index + 1 < parts.count {
                let upcoming = parts[index + 1]
                let settled = voice
                next = Task { try await ElevenLabs.speech(text: upcoming, voiceId: settled, key: key) }
            }
            do {
                try await player.play(current)
            } catch {
                next?.cancel()
                guard !Task.isCancelled else { return }
                return await fallBack(Array(parts[index...]), failure: error)
            }
            guard !Task.isCancelled else { next?.cancel(); return }
            guard let next else { return }
            do {
                current = try await next.value
            } catch {
                guard !Task.isCancelled else { return }
                return await fallBack(Array(parts[(index + 1)...]), failure: error)
            }
        }
    }

    private func fallBack(_ parts: [String], failure: Error?) async {
        let reason = failure?.localizedDescription ?? String(localized: "ElevenLabs didn't answer.")
        note = String(localized: "\(reason) The phone read it instead.")
        await deviceSpeak(parts.joined(separator: " "))
    }

    private func deviceSpeak(_ text: String) async {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestDeviceVoice()
        await withCheckedContinuation { continuation in
            deviceWaiter = continuation
            synthesizer.speak(utterance)
        }
    }

    /// The highest-quality installed voice for the phone's language —
    /// premium or enhanced when someone has downloaded one.
    private static func bestDeviceVoice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let exact = voices.filter { $0.language == language }
        let pool = exact.isEmpty ? voices.filter { $0.language.hasPrefix(String(language.prefix(2))) } : exact
        return pool.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: language)
    }

    private func stopVoice() {
        speaking?.cancel()
        speaking = nil
        player.stop()
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        deviceWaiter?.resume()
        deviceWaiter = nil
        if phase == .speaking { phase = .idle }
    }
}

private final class VoiceDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (@MainActor () -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish() }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish() }

    private func finish() {
        let done = onFinish
        Task { @MainActor in done?() }
    }
}
