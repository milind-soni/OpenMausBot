package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import com.openmausbot.companion.core.Dictation
import com.openmausbot.companion.core.DraftProvenance

/**
 * Composer draft mutations for one conversation — the path [ChatScreen] /
 * `LoadedChat` uses for typed edits, dictation merges, send, manual clear, and
 * leave-to-roster.
 *
 * JVM tests drive the same mutation methods the screen calls. Volatile [text]
 * lives in the [holder]; [saveableValue] is the **only** string the [saver]
 * will hand to `rememberSaveable`. The screen does not pick a field: it mounts
 * this object under that saver and mirrors [text] into the TextField.
 *
 * Push vs pop: [onLeaveToRoster] clears both halves (iOS destroys `@State` on
 * pop). Pushing Computer must **not** call it — the holder entry is what
 * survives while `navigator.current` is Computer.
 */
class ChatComposerDraft(
    private val chatId: String,
    private val holder: ChatDraftHolder,
    initialSaveable: String,
) {
    /** Volatile field text — may contain speech. Never what the saver persists. */
    var text: String by mutableStateOf("")
        private set

    /**
     * Typed-only half. The sole value [saver] may write into SavedStateRegistry.
     * Not a peer of [text] for the screen to choose between — production reads
     * it only through the saver.
     */
    var saveableValue: String
        private set

    var contaminated: Boolean
        private set

    val provenance: DraftProvenance
        get() = DraftProvenance(typedSnapshot = saveableValue, contaminated = contaminated)

    init {
        val held = holder.get(chatId)
        val seeded = Dictation.seedVolatileDraft(held?.volatile, initialSaveable)
        text = seeded.text
        contaminated = seeded.contaminated
        // Prefer the holder's snapshot when present (Computer return); otherwise
        // the saveable half restored after Activity recreation.
        saveableValue = held?.typedSnapshot ?: initialSaveable
        if (holder.get(chatId) == null) {
            // Recreation / first open: republish so an immediate Computer push
            // still has something to bring back.
            holder.put(chatId, text, provenance)
        }
    }

    fun publish(next: String, nextProvenance: DraftProvenance) {
        text = next
        saveableValue = nextProvenance.typedSnapshot
        contaminated = nextProvenance.contaminated
        holder.put(chatId, next, nextProvenance)
    }

    /**
     * Composer `onValueChange`. Emptying the field resets provenance the same
     * way send does — otherwise a contaminated snapshot stays forever (send is
     * a no-op on empty text).
     */
    fun onTypedChange(next: String) {
        if (next.isEmpty()) {
            publish("", Dictation.afterClear())
        } else {
            publish(next, Dictation.afterTypedEdit(provenance, next))
        }
    }

    /** A partial/final from the recognizer — never copies speech into the snapshot. */
    fun onDictation(merged: String) {
        val current = holder.get(chatId)?.provenance ?: provenance
        publish(merged, Dictation.afterDictation(current))
    }

    /** Send of non-empty text: clear before `session.send`. */
    fun onSend() {
        publish("", Dictation.afterClear())
    }

    /**
     * Back to the roster. Clears holder + typed snapshot while the screen is
     * still composed so `rememberSaveable` does not resurrect the draft on
     * reopen. Do not call when pushing Computer.
     */
    fun onLeaveToRoster() {
        publish("", Dictation.afterClear())
    }

    companion object {
        /** Envelope marker — reject anything that is not `[TYPED_MARKER, snapshot]`. */
        private const val TYPED_MARKER = "typed:"

        /**
         * The only bridge from this draft into `rememberSaveable`. Saves an
         * envelope of [saveableValue] — never [text]. Routing [text] into the
         * envelope is the mutation that must turn the suite red.
         *
         * Restore is fail-closed: null, wrong type, or a malformed/unexpected
         * payload degrades to an empty typed snapshot (no crash, no speech
         * seeded into the holder).
         */
        fun saver(
            chatId: String,
            holder: ChatDraftHolder,
        ): Saver<ChatComposerDraft, Any> = Saver(
            save = { listOf(TYPED_MARKER, it.saveableValue) },
            restore = { raw ->
                holder.composer(
                    chatId,
                    initialSaveable = typedSnapshotFromSaved(raw).orEmpty(),
                )
            },
        )

        /**
         * Pure parse of the saver payload for JVM tests and the restore path.
         * Returns null when [raw] is absent, the wrong type, or not a typed
         * envelope — callers degrade to `""`.
         */
        fun typedSnapshotFromSaved(raw: Any?): String? {
            val list = raw as? List<*> ?: return null
            if (list.size != 2) return null
            if (list[0] != TYPED_MARKER) return null
            return list[1] as? String
        }
    }
}
