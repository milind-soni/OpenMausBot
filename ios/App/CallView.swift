// Call mode — the bot on the line, on the phone.
//
// The same loop as the desktop's CallView, and deliberately HALF-DUPLEX for
// the same reason: the microphone is live only while the bot is not
// speaking. The phone's voice-chat audio mode does cancel echo, but a
// recognizer that hears even a little of the bot's own voice sends it
// back as a message, and the two of them talk forever. Interrupting is a
// tap instead.
//
// Turn-taking is the silence endpointer in `SpeechDictation.listenForTurn`:
// the turn ends 850 ms after the transcript last changed. Waiting is
// narrated — every activity chip the harness phrases for a voice
// (`tool.spoken`) is read as it lands — so an agent turn of tool calls
// sounds like someone working rather than a dropped call.
//
// Approvals and questions are not answered by voice here yet; a card
// that appears mid-call is announced, and answering it happens in the
// chat. Saying "yes" to a permission is the kind of thing that should not
// be inferred from a sentence that happened to contain the word.
import AVFoundation
import Combine
import SwiftUI
import CompanionCore

/// Sequential playback of utterances fetched from the computer.
@MainActor
final class CallSpeaker: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isSpeaking = false
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Never>?
    private var generation = 0

    /// Speak every utterance in order. Returns false when stopped early.
    func speak(_ utterances: [Data]) async -> Bool {
        generation += 1
        let mine = generation
        isSpeaking = true
        defer { if generation == mine { isSpeaking = false } }
        for data in utterances {
            guard generation == mine else { return false }
            guard let next = try? AVAudioPlayer(data: data) else { continue }
            next.delegate = self
            player = next
            guard next.prepareToPlay(), next.play() else { continue }
            await withCheckedContinuation { continuation in finished = continuation }
            guard generation == mine else { return false }
        }
        return generation == mine
    }

    func stop() {
        generation += 1
        player?.stop()
        player = nil
        isSpeaking = false
        finished?.resume()
        finished = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.finished?.resume()
            self.finished = nil
        }
    }
}

struct CallView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @StateObject private var microphone = SpeechDictation()
    @StateObject private var speaker = CallSpeaker()
    @State private var phase: Phase = .listening
    @State private var note: String?
    /// Everything already on screen when the call starts has been read or
    /// ignored — a call must not open by reciting the backlog.
    @State private var spokenIds: Set<String> = []
    @State private var announcedRequests: Set<String> = []
    @State private var started = false
    @State private var sayGeneration = 0

    private static let endpointGap: TimeInterval = 0.85

    enum Phase { case listening, sending, working, speaking }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var messages: [Message] { session.state.visibleTranscript(forThread: current.threadId) }
    private var pendingCard: Message? {
        messages.last { $0.card?.isPending == true }
    }

    var body: some View {
        ZStack {
            MausPalette.color(current.color).opacity(0.18).ignoresSafeArea()
            VStack(spacing: 24) {
                Spacer()
                BotAvatarView(bot: current, size: 160)
                    .scaleEffect(phase == .speaking ? 1.06 : 1)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: phase == .speaking)
                Text(current.name)
                    .font(.system(size: 28, weight: .semibold))
                Text(phaseText)
                    .font(.system(size: 17))
                    .foregroundStyle(Color.secondary)
                    .contentTransition(.opacity)
                if !microphone.transcript.isEmpty, phase == .listening {
                    Text(microphone.transcript)
                        .font(.system(size: 17))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                        .lineLimit(4)
                }
                if let note {
                    Text(note)
                        .font(.system(size: 14))
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                }
                Spacer()
                HStack(spacing: 40) {
                    Button {
                        interrupt()
                    } label: {
                        Label("Interrupt", systemImage: "hand.raised.fill")
                            .labelStyle(.iconOnly)
                            .font(.system(size: 24, weight: .semibold))
                            .frame(width: 68, height: 68)
                            .background(Circle().fill(Color.secondary.opacity(0.18)))
                    }
                    .buttonStyle(.plain)
                    .disabled(phase != .speaking)
                    .opacity(phase == .speaking ? 1 : 0.35)
                    .accessibilityLabel("Interrupt and speak")

                    Button {
                        hangUp()
                    } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 68, height: 68)
                            .background(Circle().fill(Color.red))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("End call")
                }
                .padding(.bottom, 36)
            }
        }
        .onAppear { startIfNeeded() }
        .onDisappear { microphone.stop(); speaker.stop() }
        .onChange(of: messages) { _, _ in react() }
        .onChange(of: current.busy) { _, _ in react() }
        .onChange(of: microphone.error) { _, error in
            if let error { note = error }
        }
    }

    private var phaseText: String {
        switch phase {
        case .listening: return "Listening…"
        case .sending: return "Sending…"
        case .working: return "\(current.name) is working…"
        case .speaking: return "Speaking"
        }
    }

    // MARK: - The loop

    private func startIfNeeded() {
        guard !started else { return }
        started = true
        spokenIds = Set(messages.map(\.id))
        if current.busy == true { move(.working) } else { listen() }
    }

    private func move(_ next: Phase) {
        withAnimation(.easeInOut(duration: 0.2)) { phase = next }
    }

    private func listen() {
        move(.listening)
        note = nil
        microphone.listenForTurn(endpointAfter: Self.endpointGap) { heard in
            turnEnded(heard)
        }
    }

    private func turnEnded(_ heard: String) {
        let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { listen(); return }
        move(.sending)
        Task { await session.send(said, to: .bot(current)) }
    }

    /// Speak with the microphone closed, then return whether this call is
    /// still the one that asked (an interrupt or hang-up bumps the
    /// generation).
    private func say(_ text: String) async -> Bool {
        sayGeneration += 1
        let mine = sayGeneration
        move(.speaking)
        microphone.stop()
        do {
            let prepared = try await session.prepareSpeech(text, voiceId: current.voice)
            guard prepared.ready else {
                note = "Set up a voice in Settings → Voice to hear \(current.name)."
                return sayGeneration == mine
            }
            var clips: [Data] = []
            for utterance in prepared.utterances {
                guard sayGeneration == mine else { return false }
                clips.append(try await session.speak(utterance, voiceId: current.voice))
            }
            guard sayGeneration == mine else { return false }
            let finished = await speaker.speak(clips)
            return finished && sayGeneration == mine
        } catch {
            note = error.localizedDescription
            return sayGeneration == mine
        }
    }

    private func sayThenListen(_ text: String) {
        Task {
            let stillMine = await say(text)
            if stillMine, phase == .speaking { listen() }
        }
    }

    private func react() {
        guard started else { return }
        let fresh = messages.filter { !spokenIds.contains($0.id) }
        for message in fresh { spokenIds.insert(message.id) }

        if let card = pendingCard, let requestId = card.card?.requestId,
           !announcedRequests.contains(requestId), phase != .speaking {
            announcedRequests.insert(requestId)
            let what = card.card?.tool == nil ? "has a question" : "is asking for permission"
            sayThenListen("\(current.name) \(what). Open the chat to answer it.")
            return
        }

        let reply = fresh.last { $0.role == .bot && $0.kind == .text && !($0.text ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
        let chip = fresh.last { $0.kind == .activity && $0.tool?.spoken != nil }
        if let text = reply?.text {
            sayThenListen(text)
            return
        }
        if let spoken = chip?.tool?.spoken, phase == .working {
            Task {
                let stillMine = await say(spoken)
                if stillMine, phase == .speaking { move(.working) }
            }
            return
        }

        if current.busy == true {
            if phase == .listening || phase == .sending {
                microphone.stop()
                move(.working)
            }
        } else if phase == .working || phase == .sending, !speaker.isSpeaking {
            listen()
        }
    }

    private func interrupt() {
        guard phase == .speaking else { return }
        sayGeneration += 1
        speaker.stop()
        listen()
    }

    private func hangUp() {
        sayGeneration += 1
        microphone.stop()
        speaker.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        dismiss()
    }
}
