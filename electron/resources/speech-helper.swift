// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// Runs until the final result or a per-session stop marker. Launched by
// electron/speech.mjs as this background app bundle so macOS can resolve the
// microphone and speech purpose strings in its Info.plist.
//
// `--endpoint-ms N` ends the audio stream after N milliseconds without a
// transcript change. SFSpeechRecognizer does not finalize a buffer-backed
// request on silence by itself; it only produces `isFinal` after endAudio().
// Composer dictation omits this flag and keeps its existing press-to-stop
// behavior, while call mode opts into silence endpointing.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

// LaunchServices gives the helper the bundle identity TCC needs, but it also
// means the parent cannot terminate it by killing the `open -W` process. A
// per-session stop marker keeps intentional mute/hang-up deterministic.
var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) { exit(0) }
  }
  stopTimer = timer
  timer.resume()
}

// Push-to-talk release must finalize recognition rather than cancel it. The
// handler is installed once the audio engine exists; the timer keeps polling
// if an unusually fast key release beats authorization/setup.
var finishHandler: (() -> Void)?
var finishTimer: DispatchSourceTimer?
if let finishFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    guard FileManager.default.fileExists(atPath: finishFile), let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

/// SFSpeechRecognizer can keep revising/re-emitting a partial transcript
/// after the user stops talking. Only a changed transcript resets the timer.
final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "com.astra.speech.endpoint")
  private let gap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(gapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    // Never terminate an empty turn: a call may be quiet for as long as the
    // user needs before they begin speaking.
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard silentFor >= gap else { return }
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  // Recognize in the user's language: a hardcoded en-US recognizer
  // transcribes everyone else into nonsense. First preference that has an
  // available recognizer wins, with en-US as the last resort.
  let candidates =
    Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) {
      // Stop capture before ending the request: appending another audio
      // buffer after endAudio() can make the recognition task fail instead
      // of delivering its final transcript.
      finishAudio()
    }
    endpointer?.start()
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      emit(["partial": !result.isFinal, "text": text])
      if result.isFinal { exit(0) }
    }
    if error != nil { fail("recognition-error") }
  }
}

RunLoop.main.run()
