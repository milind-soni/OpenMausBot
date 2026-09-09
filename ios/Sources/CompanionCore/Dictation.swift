// Composer dictation, the half that has no microphone.
//
// The Speech session lives in the app target — it needs AVFoundation and a
// device. What lives here is the contract between that session and the text
// field, because that is where the decisions are and where they can be
// tested without a phone:
//
// - Partials *replace* each other after the text that was already in the
//   composer. They never stack. The desktop helper works the same way
//   (`src/components/Composer.tsx`): the base is frozen when the mic goes
//   on, and every transcript line is `base + " " + spoken`.
// - The recognizer's locale is the user's language, not a hardcoded
//   English. A French speaker talking to an en-US recognizer gets
//   nonsense, which is how this went wrong on the desktop the first time
//   (`electron/resources/speech-helper.swift`). Same candidate list here.
import Foundation

public enum Dictation {
    private static let maximumPreferredLanguages = 3

    /// Combine already-typed composer text with the current transcript.
    ///
    /// `base` is whatever was in the field when listening started, frozen
    /// for the session. Pass that every time, not the live draft — passing
    /// the live draft would append each partial onto the last one.
    public static func draft(base: String, transcript: String) -> String {
        let typed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if spoken.isEmpty { return typed }
        if typed.isEmpty { return spoken }
        return "\(typed) \(spoken)"
    }

    /// Merge a new formatted partial into the accumulated transcript.
    ///
    /// Partials for the same segment extend or revise the current text in
    /// place. A fresh segment after a pause does not start with the previous
    /// partial, so it is appended instead of replacing the accumulated text.
    public static func updateTranscript(_ current: String, new: String) -> String {
        let current = current.trimmingCharacters(in: .whitespacesAndNewlines)
        let new = new.trimmingCharacters(in: .whitespacesAndNewlines)
        if new.isEmpty { return current }
        if current.isEmpty { return new }

        // Same segment: the recognizer lengthened the current text.
        if new.hasPrefix(current) { return new }

        // Same segment with a brief backtrack: keep the longer version.
        if current.hasPrefix(new) { return current }

        // Same segment with a word-level revision: most leading words match.
        let currentWords = current.split(separator: " ")
        let newWords = new.split(separator: " ")
        let commonWordCount = zip(currentWords, newWords)
            .prefix(while: { $0.lowercased() == $1.lowercased() })
            .count
        if commonWordCount >= 2, commonWordCount * 2 >= currentWords.count {
            return new
        }

        // New segment after a pause: append, separated by a space.
        return draft(base: current, transcript: new)
    }

    /// Locales to try, in order. First available recognizer wins.
    ///
    /// Preferred languages, then the current locale, then en-US as a last
    /// resort so a device with no speech support for the user's language
    /// still has something to attempt rather than failing closed with no
    /// explanation.
    public static func localeCandidates(
        preferredLanguages: [String] = Locale.preferredLanguages,
        current: Locale = .current
    ) -> [Locale] {
        var seen = Set<String>()
        var result: [Locale] = []
        func add(_ locale: Locale) {
            // "en-US" and "en_US" are the same recognizer. Canonicalize so
            // the fallback does not add a duplicate of a locale we already
            // tried under a different identifier spelling.
            let key = canonicalIdentifier(locale)
            guard seen.insert(key).inserted else { return }
            result.append(locale)
        }
        for language in preferredLanguages.prefix(maximumPreferredLanguages) {
            add(Locale(identifier: language))
        }
        add(current)
        add(Locale(identifier: "en-US"))
        return result
    }

    /// Lowercased BCP-47 with underscores, so `en-US` and `en_US` collide.
    public static func canonicalIdentifier(_ locale: Locale) -> String {
        locale.identifier.lowercased().replacingOccurrences(of: "-", with: "_")
    }
}
