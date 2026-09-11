// Walkie mode's engine: hold to talk to one bot, hear its answer back.
//
// Dictation is the composer's own `SpeechDictation`, driven by press and
// release instead of a toggle. Sending is `Session.send`, so a Walkie message
// is an ordinary message in the bot's current thread — open the chat and it
// is there. The answer is read with the phone's own voice: that needs nothing
// configured on the computer, and works against a server with no voices.
import AVFoundation
import Combine
import CompanionCore
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
    enum Phase: Equatable { case idle, listening, sending, waiting, speaking }

    @Published private(set) var phase: Phase = .idle
    /// What you said: live while holding, then the last thing sent.
    @Published private(set) var heard = ""
    /// The last answer, and who gave it.
    @Published private(set) var reply = ""
    @Published private(set) var replyFrom = ""
    /// One short line when something needs your attention.
    @Published private(set) var note: String?

    var speaksReplies = true {
        didSet {
            if !speaksReplies, phase == .speaking { synthesizer.stopSpeaking(at: .immediate) }
        }
    }

    private let dictation = SpeechDictation()
    private let synthesizer = AVSpeechSynthesizer()
    private let voiceDelegate = VoiceDelegate()
    private var pending: Pending?
    private var cancellables = Set<AnyCancellable>()

    private struct Pending {
        let threadId: String
        let name: String
        let baseline: Set<String>
        let sentAt: Date
    }

    /// Stop waiting for an answer after this long; the chat still gets it.
    private static let patience: TimeInterval = 10 * 60

    init() {
        synthesizer.delegate = voiceDelegate
        voiceDelegate.onFinish = { [weak self] in
            guard let self, self.phase == .speaking else { return }
            self.phase = .idle
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        dictation.$transcript
            .sink { [weak self] words in
                guard let self, self.phase == .listening else { return }
                self.heard = words
            }
            .store(in: &cancellables)
        dictation.$error
            .sink { [weak self] error in
                guard let self, error != nil, self.phase == .listening else { return }
                self.phase = .idle
                self.note = String(localized: "Couldn't hear that. Walkie needs Microphone and Speech Recognition access in Settings.")
            }
            .store(in: &cancellables)
    }

    func pressBegan() {
        guard phase != .listening, phase != .sending else { return }
        synthesizer.stopSpeaking(at: .immediate)
        note = nil
        heard = ""
        phase = .listening
        Haptics.impact(.medium)
        dictation.toggle(capturing: "")
    }

    func pressEnded(session: Session, target: Bot?) async {
        guard phase == .listening else { return }
        let words = dictation.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        dictation.stop()
        Haptics.impact(.light)
        guard !words.isEmpty else {
            phase = .idle
            note = String(localized: "Didn't catch that. Keep holding the button while you talk.")
            return
        }
        guard let target else {
            phase = .idle
            note = String(localized: "Pick an agent to talk to first.")
            return
        }
        heard = words
        phase = .sending
        let baseline = Set(session.state.transcript(forThread: target.threadId).map(\.id))
        session.actionError = nil
        await session.send(words, to: .bot(target))
        if let error = session.actionError {
            // Said here, where you are looking, rather than as an alert
            // behind this full-screen view.
            session.actionError = nil
            phase = .idle
            note = error
            return
        }
        pending = Pending(threadId: target.threadId, name: target.name, baseline: baseline, sentAt: Date())
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
        if phase == .speaking {
            synthesizer.stopSpeaking(at: .immediate)
            phase = .idle
            return
        }
        guard let target, target.currentTaskBusy == true else { return }
        await session.interrupt(bot: target)
        pending = nil
        phase = .idle
        note = String(localized: "Stopped \(target.name).")
    }

    func shutdown() {
        if phase == .listening { dictation.stop() }
        synthesizer.stopSpeaking(at: .immediate)
        pending = nil
        phase = .idle
    }

    private func speak(_ text: String) {
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? audio.setActive(true)
        let utterance = AVSpeechUtterance(string: Walkie.speakable(text))
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        phase = .speaking
        synthesizer.speak(utterance)
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
