package com.openmausbot.companion.core

import java.util.Locale

/**
 * Saveable half of the composer draft: only text the user typed before any
 * dictation touched the field. Spoken partials/finals must never enter this
 * value — §6 forbids transcript in saved state, and a later edit of a
 * contaminated draft must not smuggle speech back in by copying the whole
 * string.
 */
data class DraftProvenance(
    val typedSnapshot: String = "",
    val contaminated: Boolean = false,
)

/**
 * Volatile composer text shown in the field, paired with whether speech has
 * touched it since the last send/clear.
 */
data class VolatileDraft(
    val text: String = "",
    val contaminated: Boolean = false,
)

/**
 * Composer dictation, the half that has no microphone.
 *
 * The Speech session lives in the app target — it needs a recognizer and a
 * device. What lives here is the contract between that session and the text
 * field, because that is where the decisions are and where they can be
 * tested without a phone:
 *
 * - Partials *replace* each other after the text that was already in the
 *   composer. They never stack. The desktop helper works the same way
 *   (`src/components/Composer.tsx`): the base is frozen when the mic goes
 *   on, and every transcript line is `base + " " + spoken`.
 * - The recognizer's locale is the user's language, not a hardcoded
 *   English. Same candidate list as `ios/Sources/CompanionCore/Dictation.swift`.
 * - Typed text and spoken text have separate provenance so rotation can
 *   restore the former without serialising the latter.
 */
object Dictation {
    private const val MAXIMUM_PREFERRED_LANGUAGES = 3

    /**
     * Combine already-typed composer text with the current transcript.
     *
     * [base] is whatever was in the field when listening started, frozen
     * for the session. Pass that every time, not the live draft — passing
     * the live draft would append each partial onto the last one.
     */
    fun draft(base: String, transcript: String): String {
        val typed = base.trim()
        val spoken = transcript.trim()
        if (spoken.isEmpty()) return typed
        if (typed.isEmpty()) return spoken
        return "$typed $spoken"
    }

    /**
     * Merge a new formatted partial into the accumulated transcript.
     *
     * Partials for the same segment extend or revise the current text in
     * place. A fresh segment after a pause does not start with the previous
     * partial, so it is appended instead of replacing the accumulated text.
     */
    fun updateTranscript(current: String, new: String): String {
        val current = current.trim()
        val new = new.trim()
        if (new.isEmpty()) return current
        if (current.isEmpty()) return new

        // Same segment: the recognizer lengthened the current text.
        if (new.startsWith(current)) return new

        // Same segment with a brief backtrack: keep the longer version.
        if (current.startsWith(new)) return current

        // Same segment with a word-level revision: most leading words match.
        val currentWords = current.split(" ").filter { it.isNotEmpty() }
        val newWords = new.split(" ").filter { it.isNotEmpty() }
        val commonWordCount = currentWords
            .zip(newWords)
            .takeWhile { it.first.lowercase() == it.second.lowercase() }
            .count()
        if (commonWordCount >= 2 && commonWordCount * 2 >= currentWords.size) {
            return new
        }

        // New segment after a pause: append, separated by a space.
        return draft(base = current, transcript = new)
    }

    /**
     * Typing while clean updates the saveable snapshot. Typing after any
     * partial/final leaves the snapshot alone — the live string may still
     * contain speech. Emptying the field resets like send: a contaminated
     * snapshot must not outlive a blank composer.
     */
    fun afterTypedEdit(provenance: DraftProvenance, draft: String): DraftProvenance =
        when {
            draft.isEmpty() -> afterClear()
            provenance.contaminated -> provenance
            else -> provenance.copy(typedSnapshot = draft)
        }

    /** A partial or final marks the draft contaminated; the snapshot stays. */
    fun afterDictation(provenance: DraftProvenance): DraftProvenance =
        provenance.copy(contaminated = true)

    /** Send or clear resets both halves of provenance. */
    fun afterClear(): DraftProvenance = DraftProvenance()

    /**
     * Draft to show after the Activity (and its in-memory holder) are gone.
     * Only the typed snapshot returns; spoken text is discarded.
     */
    fun restoredDraft(provenance: DraftProvenance): String = provenance.typedSnapshot

    /**
     * Seed the volatile field when ChatScreen enters composition.
     *
     * [held] is the in-memory entry that survives pushing Computer; null
     * means Activity recreation (or a first open), so restore the typed
     * snapshot only.
     */
    fun seedVolatileDraft(held: VolatileDraft?, typedSnapshot: String): VolatileDraft =
        held ?: VolatileDraft(text = typedSnapshot, contaminated = false)

    /**
     * Locales to try, in order. First available recognizer wins.
     *
     * Preferred languages, then the current locale, then en-US as a last
     * resort so a device with no speech support for the user's language
     * still has something to attempt rather than failing closed with no
     * explanation.
     */
    fun localeCandidates(
        preferredLanguages: List<String>,
        current: Locale = Locale.getDefault(),
    ): List<Locale> {
        val seen = linkedSetOf<String>()
        val result = ArrayList<Locale>()
        fun add(locale: Locale) {
            // "en-US" and "en_US" are the same recognizer. Canonicalize so
            // the fallback does not add a duplicate of a locale we already
            // tried under a different identifier spelling.
            val key = canonicalIdentifier(locale)
            if (key.isEmpty()) return
            if (!seen.add(key)) return
            result += locale
        }
        for (language in preferredLanguages.take(MAXIMUM_PREFERRED_LANGUAGES)) {
            add(localeFromTag(language))
        }
        add(current)
        add(localeFromTag("en-US"))
        return result
    }

    /** Lowercased BCP-47 with underscores, so `en-US` and `en_US` collide. */
    fun canonicalIdentifier(locale: Locale): String =
        locale.toLanguageTag().lowercase().replace('-', '_')

    /** Accept both `en-US` and `en_US` spellings from preference lists. */
    fun localeFromTag(tag: String): Locale =
        Locale.forLanguageTag(tag.trim().replace('_', '-'))
}
