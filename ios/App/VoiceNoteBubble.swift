import AVFoundation
import CompanionCore
import SwiftUI

/// The one-voice rule for transcript audio: playing one note pauses any
/// other, exactly as the web bubble's claimExternalVoice does. The audio
/// session itself arbitrates against call mode — its reconfiguration
/// arrives here as an interruption, which pauses the holder. The current
/// holder is weak: a bubble scrolled out of the transcript releases itself.
///
/// The session this coordinates is process-wide, so the arbiter is too:
/// dictation and Walkie file through the same instance before they
/// reconfigure the shared session for recording.
@MainActor
final class VoiceNoteCenter {
    static let shared = VoiceNoteCenter()

    enum InputOwner: String { case dictation, walkie }

    private weak var current: VoiceNotePlayer?
    private var inputOwners: Set<InputOwner> = []
    /// True while a voice-note player configured the shared session for
    /// playback and no input owner has taken it since.
    private var ownsPlaybackSession = false

    func claim(_ player: VoiceNotePlayer) {
        if current !== player { current?.pause() }
        current = player
    }

    func release(_ player: VoiceNotePlayer) {
        if current === player { current = nil }
    }

    /// An input owner is about to reconfigure the shared session for
    /// recording: pause the audible note here, and keep playback off until
    /// the owner returns the session. Starting another in-app owner does
    /// not reliably fire interruptionNotification, so this is explicit.
    func beginInputOwnership(_ owner: InputOwner) {
        inputOwners.insert(owner)
        current?.pause()
        ownsPlaybackSession = false
    }

    func endInputOwnership(_ owner: InputOwner) {
        inputOwners.remove(owner)
    }

    /// Claim the shared session for playback. Rejected while an input
    /// owner holds it, so starting dictation or Walkie silences the
    /// transcript instead of the two fighting over the route.
    func beginPlaybackSession() -> Bool {
        guard inputOwners.isEmpty else { return false }
        ownsPlaybackSession = true
        return true
    }

    /// Give the session back — but only if a voice-note player still owns
    /// it. Deactivating while dictation or Walkie holds the session would
    /// end their capture.
    func endPlaybackSession() {
        guard ownsPlaybackSession else { return }
        ownsPlaybackSession = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// Plays one parked voice-note clip: load, play, pause, scrub, and the
/// interruption pause the umbrella spec requires. Bytes arrive through the
/// authenticated attachment route and the session cache, so replay never
/// refetches.
@MainActor
final class VoiceNotePlayer: NSObject, ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var elapsed: Double = 0
    /// Real duration once the clip loads; until then the bubble shows the
    /// server's durationMs estimate.
    @Published private(set) var loadedDuration: Double?

    private var player: AVAudioPlayer?
    private var ticker: Timer?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionWasInterrupted(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    func load(_ data: Data) throws {
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        player.prepareToPlay()
        self.player = player
        loadedDuration = player.duration > 0 ? player.duration : nil
        elapsed = 0
        isPlaying = false
    }

    /// Drop a loaded clip so a retry can fetch fresh bytes.
    func reset() {
        pause()
        player = nil
        loadedDuration = nil
        elapsed = 0
    }

    func play() {
        guard let player, player.duration > 0,
              VoiceNoteCenter.shared.beginPlaybackSession() else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
        guard player.play() else {
            VoiceNoteCenter.shared.endPlaybackSession()
            return
        }
        isPlaying = true
        startTicker()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        stopTicker()
    }

    func seek(to time: Double) {
        guard let player else { return }
        let target = min(max(0, time), player.duration)
        player.currentTime = target
        elapsed = target
    }

    private func startTicker() {
        stopTicker()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    private func tick() {
        guard let player, isPlaying else { return }
        elapsed = player.currentTime
    }

    @objc private func sessionWasInterrupted(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
        let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt)
        if value == AVAudioSession.InterruptionType.began.rawValue {
            pause()
            VoiceNoteCenter.shared.endPlaybackSession()
        }
    }

    private func finished() {
        isPlaying = false
        stopTicker()
        // Rewind so pressing play again replays instead of sitting at the
        // end of the clip.
        seek(to: 0)
        VoiceNoteCenter.shared.endPlaybackSession()
    }
}

extension VoiceNotePlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.finished() }
    }
}

/// One voice note in the transcript: a play button, a scrub bar, and the
/// clip's length — the iOS match of the web bubble in PR #1801, whose
/// behavior is this slice's contract. The transcript stays the message
/// body; this bubble is the playable clip beside it.
struct VoiceNoteBubble: View {
    let note: MessageVoiceNote
    var tint: Color = .accentColor

    @EnvironmentObject private var session: Session
    @StateObject private var player = VoiceNotePlayer()
    @State private var loading = true
    @State private var loadFailed = false
    @State private var attempt = 0

    /// The server's estimate until the clip loads its own metadata.
    private var duration: Double? {
        if let loaded = player.loadedDuration, loaded > 0 { return loaded }
        if let ms = note.durationMs, ms > 0 { return ms / 1000 }
        return nil
    }

    private var timeText: String {
        let total = duration.map(Self.clock) ?? "--:--"
        return "\(Self.clock(player.elapsed)) / \(total)"
    }

    private var timeBinding: Binding<Double> {
        Binding(
            get: { player.elapsed },
            set: { player.seek(to: $0) }
        )
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if player.isPlaying {
                    player.pause()
                } else {
                    VoiceNoteCenter.shared.claim(player)
                    player.play()
                }
            } label: {
                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(tint))
            }
            .buttonStyle(.plain)
            .disabled(loading || loadFailed || duration == nil)
            .accessibilityIdentifier("voice-note-play")
            .accessibilityLabel(player.isPlaying ? Text("Pause voice note") : Text("Play voice note"))

            if loading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
            } else if loadFailed {
                failure
            } else {
                Slider(value: timeBinding, in: 0...Swift.max(duration ?? 1, 0.1))
                    .tint(tint)
                    .accessibilityLabel(Text("Voice note position"))
                Text(timeText)
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundStyle(Color.secondary)
                    .accessibilityIdentifier("voice-note-time")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.secondary.opacity(0.13))
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-note")
        .task(id: "\(note.path)#\(attempt)") {
            guard player.loadedDuration == nil, !loadFailed else { return }
            guard let data = await session.voiceNoteData(for: note), !Task.isCancelled else {
                if !Task.isCancelled {
                    loadFailed = true
                    loading = false
                }
                return
            }
            do {
                try player.load(data)
                loadFailed = false
            } catch {
                loadFailed = true
            }
            loading = false
        }
        .onValueChange(of: player.isPlaying) { playing in
            if !playing { VoiceNoteCenter.shared.release(player) }
        }
        .onDisappear {
            player.pause()
            VoiceNoteCenter.shared.release(player)
        }
    }

    private var failure: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .accessibilityHidden(true)
            Text("Couldn’t load the voice note.")
                .font(.system(size: 12))
            Spacer(minLength: 4)
            Button("Retry") {
                player.reset()
                loadFailed = false
                loading = true
                attempt += 1
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(tint)
        }
        .foregroundStyle(Color.secondary)
    }

    private static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "0:00" }
        let whole = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}
