// Walkie's microphone and speaker.
//
// The composer's dictation sets up the audio session and a fresh engine on
// every tap, and does it on the main thread — fine for a button you press
// once per message, choppy for a walkie-talkie. Here the session and engine
// are set up once, off the main thread, when Walkie opens, and stay running
// while it is on screen. A press only points the running tap at a new
// recognition request, so listening starts at once and the first word is
// not lost. Nothing is recognized or sent unless the button is held.
import AVFoundation
import Speech

final class WalkieMic: @unchecked Sendable {
    enum Failure: Error { case noInput }

    private let queue = DispatchQueue(label: "com.openmausbot.walkie.mic")
    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?

    /// Set up the session and start the engine. Safe to call again.
    func warm() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    if self.engine?.isRunning == true { return done.resume() }
                    let session = AVAudioSession.sharedInstance()
                    // Play-and-record once, so speaking a reply and listening
                    // again never reconfigures the session between them.
                    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
                    try session.setActive(true)
                    let engine = AVAudioEngine()
                    let input = engine.inputNode
                    let format = input.outputFormat(forBus: 0)
                    guard format.channelCount > 0 else { throw Failure.noInput }
                    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                        self?.feed(buffer)
                    }
                    engine.prepare()
                    try engine.start()
                    self.engine = engine
                    done.resume()
                } catch {
                    done.resume(throwing: error)
                }
            }
        }
    }

    /// Stop the engine and give the audio session back.
    func cool() {
        route(nil)
        queue.async {
            if let engine = self.engine {
                engine.inputNode.removeTap(onBus: 0)
                engine.stop()
            }
            self.engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Where captured audio goes; nil drops it.
    func route(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    private func feed(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }
}

/// Plays one clip of speech audio and returns when it has finished.
@MainActor
final class WalkiePlayer: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var waiter: CheckedContinuation<Void, Never>?

    func play(_ audio: Data) async throws {
        let player = try AVAudioPlayer(data: audio)
        player.delegate = self
        player.prepareToPlay()
        self.player = player
        await withCheckedContinuation { continuation in
            waiter = continuation
            if !player.play() { finish() }
        }
    }

    func stop() {
        player?.stop()
        player = nil
        finish()
    }

    private func finish() {
        waiter?.resume()
        waiter = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finished(id) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in self.finished(id) }
    }

    private func finished(_ id: ObjectIdentifier) {
        guard let player, ObjectIdentifier(player) == id else { return }
        self.player = nil
        finish()
    }
}
