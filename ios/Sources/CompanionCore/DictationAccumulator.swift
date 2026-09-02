// Stitching a recognizer's restarts back into one transcript.
//
// `SFSpeechRecognizer` does not promise that each partial result extends
// the last. On-device recognition in particular treats a pause as the end
// of an utterance and starts the next result from nothing — so with the
// composer showing `bestTranscription.formattedString` verbatim, a pause
// mid-sentence made the first half vanish and the second half take its
// place. That is the bug this closes.
//
// The signal that the recognizer started over is in the segments: every
// segment carries a timestamp from the start of the audio, and a fresh
// utterance begins later than the one before it. A revision of the current
// utterance keeps its start. So: same start, replace; later start, commit
// what was there and begin a new piece.
import Foundation

public struct DictationAccumulator: Sendable {
    /// A revision of the current utterance may nudge its start by a few
    /// milliseconds; only a clear jump forward is a new utterance.
    public static let restartTolerance: TimeInterval = 0.5

    private var committed: [String] = []
    private var current = ""
    private var currentStart: TimeInterval?

    public init() {}

    /// Everything heard so far, committed utterances then the live one.
    public var transcript: String {
        (committed + [current]).filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Feed one result. `start` is the timestamp of its first segment, nil
    /// when the result has no segments, in which case the text is treated
    /// as a revision of the current utterance.
    @discardableResult
    public mutating func accept(text: String, start: TimeInterval?) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let start, let previous = currentStart, start > previous + Self.restartTolerance {
            if !current.isEmpty { committed.append(current) }
            current = ""
            currentStart = start
        } else if currentStart == nil {
            currentStart = start
        }
        current = trimmed
        return transcript
    }
}
