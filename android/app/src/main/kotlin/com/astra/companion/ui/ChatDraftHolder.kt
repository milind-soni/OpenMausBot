package com.astra.companion.ui

import com.astra.companion.core.Chat
import com.astra.companion.core.DraftProvenance
import com.astra.companion.core.VolatileDraft

/**
 * In-memory composer drafts keyed by the stable conversation id ([Chat.id]).
 *
 * Android renders only `navigator.current`, so pushing Computer removes
 * [ChatScreen] from composition (`RootScreen`). iOS keeps `ChatView` under
 * the pushed destination, so its `@State draft` survives (`ChatView.swift`).
 * This holder is that survival — process memory only, never a `Saver`, so a
 * dictated partial can live here briefly without entering SavedStateRegistry.
 *
 * Identity is [Chat.id], not `threadId`: a task switch inside one bot must
 * not wipe the draft (iOS derives a new thread inside the same `ChatView`
 * without keying `@State draft`).
 *
 * Lifetime: survives a **push** (Computer still has the chat underneath —
 * [CompanionNavigator.retainsChatDraft] is true). Does **not** survive a
 * **pop** back to the roster: [ChatComposerDraft.onLeaveToRoster] clears the
 * entry (and the saveable half) before pop, matching iOS destroying
 * `ChatView`/`@State`. Activity death drops the map; recreation restores only
 * [ChatComposerDraft.saveableValue] through [ChatComposerDraft.saver].
 */
class ChatDraftHolder {
    data class Entry(
        val text: String,
        val typedSnapshot: String,
        val contaminated: Boolean,
    ) {
        val volatile: VolatileDraft
            get() = VolatileDraft(text = text, contaminated = contaminated)

        val provenance: DraftProvenance
            get() = DraftProvenance(typedSnapshot = typedSnapshot, contaminated = contaminated)
    }

    private val entries = mutableMapOf<String, Entry>()

    fun get(chatId: String): Entry? = entries[chatId]

    fun put(chatId: String, text: String, provenance: DraftProvenance) {
        if (text.isEmpty() && provenance.typedSnapshot.isEmpty() && !provenance.contaminated) {
            entries.remove(chatId)
            return
        }
        entries[chatId] = Entry(
            text = text,
            typedSnapshot = provenance.typedSnapshot,
            contaminated = provenance.contaminated,
        )
    }

    fun clear(chatId: String) {
        entries.remove(chatId)
    }
}
