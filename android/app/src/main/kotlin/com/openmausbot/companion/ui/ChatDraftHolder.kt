package com.openmausbot.companion.ui

import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import com.openmausbot.companion.core.PendingMessageAttachment
import com.openmausbot.companion.core.DraftProvenance
import com.openmausbot.companion.core.VolatileDraft

/**
 * Memory-only drafts, separate for each thread. Only typed text is saveable.
 *
 * Android renders only `navigator.current`, so pushing Computer removes
 * [ChatScreen] from composition (`RootScreen`). iOS keeps `ChatView` under
 * the pushed destination, so its `@State draft` survives (`ChatView.swift`).
 * This holder is that survival — process memory only, never a `Saver`, so a
 * dictated partial can live here briefly without entering SavedStateRegistry.
 *
 * Switching threads keeps the source draft instead of carrying it into the
 * destination. Attachments and upload state never enter saved instance state.
 *
 * Lifetime: survives a **push** (Computer still has the chat underneath —
 * [CompanionNavigator.retainsChatDraft] is true). Does **not** survive a
 * **pop** back to the roster: [ChatComposerDraft.onLeaveToRoster] clears the
 * entry (and the saveable half) before pop, matching iOS destroying
 * `ChatView`/`@State`. Activity death drops the map; recreation restores only
 * [ChatComposerDraft.saveableValue] through [ChatComposerDraft.saver].
 */
class ChatDraftHolder {
    class Attachments {
        val items = mutableStateListOf<PendingMessageAttachment>()
        val preparing = mutableStateOf(false)
        val sending = mutableStateOf(false)
        val error = mutableStateOf<String?>(null)
    }

    private val owners = mutableMapOf<String, MutableSet<String>>()
    private val attachments = mutableMapOf<String, Attachments>()
    private val composers = mutableMapOf<String, ChatComposerDraft>()

    fun composer(conversationId: String, initialSaveable: String = ""): ChatComposerDraft =
        composers.getOrPut(conversationId) { ChatComposerDraft(conversationId, this, initialSaveable) }

    fun register(ownerId: String, conversationId: String) {
        owners.getOrPut(ownerId) { mutableSetOf() }.add(conversationId)
    }

    fun attachments(conversationId: String): Attachments =
        attachments.getOrPut(conversationId) { Attachments() }

    fun clearOwner(ownerId: String) {
        owners.remove(ownerId)?.forEach(::clear)
    }

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
        attachments.remove(chatId)
        composers.remove(chatId)
    }
}
