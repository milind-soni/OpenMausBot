// Composer dictation: how typed text and a live transcript share a field.
//
// The Speech session is in App/ and needs a device. The join is the part
// with a decision in it — partials replace, they do not stack — and getting
// that wrong is a composer that writes "hello hello hello world" as you
// talk. Same shape as the desktop: freeze the base when the mic goes on,
// and every subsequent transcript is `base + spoken`.
import XCTest
@testable import CompanionCore

final class DictationTests: XCTestCase {
    func testEmptyComposerTakesTheTranscript() {
        XCTAssertEqual(Dictation.draft(base: "", transcript: "hello"), "hello")
    }

    func testEmptyTranscriptLeavesTheBase() {
        // The first callback has not arrived yet. Wiping the field in that
        // window would look like the mic deleted what you had typed.
        XCTAssertEqual(Dictation.draft(base: "please look", transcript: ""), "please look")
        XCTAssertEqual(Dictation.draft(base: "please look", transcript: "   "), "please look")
    }

    func testSpokenTextAppendsAfterTypedText() {
        XCTAssertEqual(Dictation.draft(base: "please", transcript: "look at the logs"), "please look at the logs")
    }

    func testWhitespaceAroundEitherSideIsTrimmed() {
        XCTAssertEqual(Dictation.draft(base: "  please  ", transcript: "  look  "), "please look")
    }

    /// The contract ChatView has to keep: the base is the text at the
    /// moment listening started, not the live draft. Re-joining against
    /// that frozen base is how a later partial replaces an earlier one
    /// instead of concatenating onto it.
    func testALaterPartialReplacesAnEarlierOne() {
        let base = "please"
        XCTAssertEqual(Dictation.draft(base: base, transcript: "look"), "please look")
        XCTAssertEqual(Dictation.draft(base: base, transcript: "look at the logs"), "please look at the logs")
    }

    func testBothEmptyStaysEmpty() {
        XCTAssertEqual(Dictation.draft(base: "", transcript: ""), "")
        XCTAssertEqual(Dictation.draft(base: "  ", transcript: "\n"), "")
    }

    // MARK: - Transcript updates across segments

    func testEmptyTranscriptTakesTheNewPartial() {
        XCTAssertEqual(Dictation.updateTranscript("", new: "hello"), "hello")
    }

    func testEmptyPartialLeavesTheTranscript() {
        XCTAssertEqual(Dictation.updateTranscript("hello", new: ""), "hello")
        XCTAssertEqual(Dictation.updateTranscript("hello", new: "   "), "hello")
    }

    /// Same segment: each longer partial replaces the last in place.
    func testALongerPartialReplacesTheCurrentOne() {
        XCTAssertEqual(
            Dictation.updateTranscript("first sent", new: "first sentence"),
            "first sentence"
        )
        XCTAssertEqual(
            Dictation.updateTranscript("first sentence", new: "first sentence."),
            "first sentence."
        )
    }

    /// A fresh segment after a pause does not start with the old one, so the
    /// old text is preserved and the new segment is appended.
    func testAFreshSegmentIsAppendedAfterThePreviousText() {
        XCTAssertEqual(
            Dictation.updateTranscript("first sentence.", new: "second sentence."),
            "first sentence. second sentence."
        )
    }

    /// If the recognizer revises a word in the middle of the same segment,
    /// most leading words still match, so we take the latest best reading.
    func testAWordLevelRevisionReplacesInPlace() {
        XCTAssertEqual(
            Dictation.updateTranscript("I walked to the store", new: "I walked to a store"),
            "I walked to a store"
        )
    }

    /// A brief backtrack (new partial shorter but still a prefix) keeps the
    /// longer accumulated text.
    func testABacktrackKeepsTheLongerTranscript() {
        XCTAssertEqual(
            Dictation.updateTranscript("first sentence", new: "first"),
            "first sentence"
        )
    }

    /// A new sentence that happens to share the first word with the previous
    /// sentence is still treated as a new segment.
    func testASharedFirstWordIsNotEnoughToMergeAcrossSegments() {
        XCTAssertEqual(
            Dictation.updateTranscript("first sentence", new: "first word"),
            "first sentence first word"
        )
    }

    // MARK: - Locale candidates

    func testPreferredLanguageComesFirst() {
        let locales = Dictation.localeCandidates(
            preferredLanguages: ["fr-FR", "de-DE"],
            current: Locale(identifier: "en-US")
        )
        XCTAssertEqual(Dictation.canonicalIdentifier(locales[0]), "fr_fr")
        XCTAssertTrue(locales.map(Dictation.canonicalIdentifier).contains("en_us"))
    }

    func testEnglishIsNotDuplicatedWhenItIsAlreadyPreferred() {
        let locales = Dictation.localeCandidates(
            preferredLanguages: ["en-US"],
            current: Locale(identifier: "en-US")
        )
        let keys = locales.map(Dictation.canonicalIdentifier)
        XCTAssertEqual(keys, ["en_us"])
    }

    func testHyphenAndUnderscoreAreTheSameCandidate() {
        let locales = Dictation.localeCandidates(
            preferredLanguages: ["en-US"],
            current: Locale(identifier: "en_US")
        )
        XCTAssertEqual(locales.map(Dictation.canonicalIdentifier), ["en_us"])
    }

    func testEnglishIsTheLastResortWhenNothingElseIsOffered() {
        let locales = Dictation.localeCandidates(
            preferredLanguages: [],
            current: Locale(identifier: "ja-JP")
        )
        XCTAssertEqual(Dictation.canonicalIdentifier(locales[0]), "ja_jp")
        XCTAssertEqual(locales.last.map(Dictation.canonicalIdentifier), "en_us")
    }

    func testPreferredLanguageProbingIsBounded() {
        let locales = Dictation.localeCandidates(
            preferredLanguages: ["fr-FR", "de-DE", "it-IT", "es-ES", "pt-BR"],
            current: Locale(identifier: "ja-JP")
        )
        let keys = locales.map(Dictation.canonicalIdentifier)
        XCTAssertEqual(Array(keys.prefix(3)), ["fr_fr", "de_de", "it_it"])
        XCTAssertFalse(keys.contains("es_es"))
        XCTAssertFalse(keys.contains("pt_br"))
        XCTAssertEqual(Array(keys.suffix(2)), ["ja_jp", "en_us"])
    }
}
