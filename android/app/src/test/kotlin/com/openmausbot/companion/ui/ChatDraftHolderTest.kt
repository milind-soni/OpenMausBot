package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.SaverScope
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.Dictation
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Drives [ChatComposerDraft] — the same mutation path `LoadedChat` calls for
 * typed edits, dictation, send, manual clear, and leave-to-roster — against a
 * real [ChatDraftHolder] and [CompanionNavigator], plus the production
 * [ChatComposerDraft.saver] that `rememberSaveable` uses.
 *
 * Not covered here (no Robolectric / compose-ui-test on this module): mounting
 * `LoadedChat` inside a composition and the SavedStateRegistry key plumbing
 * across a real Activity recreation. Those stay on the device plan. The saver
 * round-trip below is the serialization contract itself — what the registry
 * would store — not a hand-copied snapshot. Routing [ChatComposerDraft.text]
 * into [ChatComposerDraft.saver] fails these tests.
 *
 * Holder replacement while the same chat stays composed is also out of scope
 * here: production builds [ChatDraftHolder] once per Activity
 * ([MainActivity]), so the case is unreachable today. `LoadedChat` still keys
 * `heldOnEntry` / `composerSaver` / `rememberSaveable` on both `chatId` and
 * `chatDrafts` so a future environment swap cannot leave a stale saver; that
 * remember-key guard is documented in `ChatScreen`, not pinned by a JVM test.
 */
class ChatDraftHolderTest {

    @Test
    fun taskSwitchKeepsSeparateDraftsAndRestoresTheSource() {
        val holder = ChatDraftHolder()
        holder.register("bot-1", "thread-a")
        holder.register("bot-1", "thread-b")
        val draft = ChatComposerDraft("thread-a", holder, initialSaveable = "")
        draft.onTypedChange("please look")
        val sibling = ChatComposerDraft("thread-b", holder, initialSaveable = "")
        assertEquals("", sibling.text)
        sibling.onTypedChange("other work")
        val afterSwitch = ChatComposerDraft("thread-a", holder, initialSaveable = "")
        assertEquals("please look", afterSwitch.text)
        assertEquals("please look", afterSwitch.saveableValue)
        assertFalse(afterSwitch.contaminated)
        assertEquals("other work", holder.get("thread-b")?.text)
        holder.clearOwner("bot-1")
        assertNull(holder.get("thread-a"))
        assertNull(holder.get("thread-b"))
    }

    @Test
    fun lateAttachmentResultsStayWithTheirOriginalThread() {
        val holder = ChatDraftHolder()
        holder.register("bot-1", "thread-a")
        holder.register("bot-1", "thread-b")
        val source = holder.attachments("thread-a")
        source.sending.value = true
        val destination = holder.attachments("thread-b")
        // An upload completes after the reader switched to B.
        source.sending.value = false
        source.error.value = "Upload failed"
        assertNull(destination.error.value)
        assertFalse(destination.sending.value)
        assertEquals("Upload failed", holder.attachments("thread-a").error.value)
        holder.clearOwner("bot-1")
        assertNull(holder.attachments("thread-a").error.value)
    }

    @Test
    fun returningBeforeAnUploadCompletesReusesTheLiveComposer() {
        val holder = ChatDraftHolder()
        val source = holder.composer("thread-a")
        source.onTypedChange("original")
        holder.composer("thread-b").onTypedChange("unrelated")
        val returned = holder.composer("thread-a")
        assertTrue(source === returned)
        returned.onTypedChange("newer edit")
        assertEquals("newer edit", source.text)
        // Successful completion can clear the same live UI object, not an
        // abandoned TextField state cell from before the switch.
        source.onSend()
        assertEquals("", returned.text)
        assertEquals("unrelated", holder.composer("thread-b").text)
    }

    @Test
    fun pushingComputerKeepsDraftButPopToRosterDropsIt() {
        val chatId = "bot-7"
        val holder = ChatDraftHolder()
        val navigator = CompanionNavigator()
        val draft = ChatComposerDraft(chatId, holder, initialSaveable = "")
        draft.onTypedChange("please")
        draft.onDictation(Dictation.draft(base = "please", transcript = "look at the logs"))
        assertEquals("please look at the logs", draft.text)
        assertEquals("please", draft.saveableValue)
        assertTrue(draft.contaminated)

        navigator.push(Destination.Chat(ChatTarget.Bot(chatId, "thread-a")))
        navigator.push(Destination.Computer(chatId))
        // Production: RootScreen renders only navigator.current, so Computer
        // removes ChatScreen. retainsChatDraft is how dispose distinguishes
        // that push from a pop.
        assertTrue(navigator.current is Destination.Computer)
        assertTrue(navigator.retainsChatDraft(chatId))
        assertNotNull(holder.get(chatId))

        navigator.pop()
        assertTrue(navigator.current is Destination.Chat)
        assertTrue(navigator.retainsChatDraft(chatId))
        val returned = ChatComposerDraft(
            chatId,
            holder,
            initialSaveable = holder.get(chatId)!!.typedSnapshot,
        )
        assertEquals("please look at the logs", returned.text)
        assertTrue(returned.contaminated)
        assertEquals("please", returned.saveableValue)

        // Production leave-to-roster: clear while composed, then pop.
        returned.onLeaveToRoster()
        navigator.pop()
        assertFalse(navigator.retainsChatDraft(chatId))
        assertNull(holder.get(chatId))

        // Reopen from roster with an empty saveable half — draft must not return.
        val reopened = ChatComposerDraft(chatId, holder, initialSaveable = "")
        assertEquals("", reopened.text)
        assertEquals("", reopened.saveableValue)
        assertFalse(reopened.contaminated)
    }

    @Test
    fun sendClearsThroughPublishNotHolderClear() {
        val chatId = "bot-3"
        val holder = ChatDraftHolder()
        val draft = ChatComposerDraft(chatId, holder, initialSaveable = "")
        draft.onTypedChange("please")
        draft.onDictation(Dictation.draft(base = "please", transcript = "look"))
        // Production onSend calls composer.onSend() → publish("", afterClear()),
        // never holder.clear().
        draft.onSend()

        assertNull(holder.get(chatId))
        assertEquals("", draft.text)
        assertEquals("", draft.saveableValue)
        assertFalse(draft.contaminated)
    }

    @Test
    fun emptyingTheFieldResetsProvenanceLikeSend() {
        val chatId = "bot-4"
        val holder = ChatDraftHolder()
        val draft = ChatComposerDraft(chatId, holder, initialSaveable = "")
        draft.onTypedChange("please")
        draft.onDictation(Dictation.draft(base = "please", transcript = "SECRET_SPOKEN"))
        assertTrue(draft.contaminated)
        assertEquals("please", draft.saveableValue)

        // Manual clear — the path that used to leave typedSnapshot forever.
        draft.onTypedChange("")
        assertNull(holder.get(chatId))
        assertEquals("", draft.saveableValue)
        assertFalse(draft.contaminated)

        draft.onTypedChange("new draft")
        assertEquals("new draft", draft.saveableValue)
        assertFalse(draft.contaminated)
        assertEquals("new draft", holder.get(chatId)!!.text)
    }

    @Test
    fun editAfterDictationDoesNotSmuggleSpeechIntoTheSnapshot() {
        val chatId = "bot-5"
        val holder = ChatDraftHolder()
        val draft = ChatComposerDraft(chatId, holder, initialSaveable = "")
        draft.onTypedChange("please")
        draft.onDictation(Dictation.draft(base = "please", transcript = "look"))
        draft.onTypedChange("please look now")

        val entry = holder.get(chatId)!!
        assertEquals("please look now", entry.text)
        assertEquals("please", entry.typedSnapshot)
        assertTrue(entry.contaminated)
    }

    @Test
    fun saverPersistsTypedOnlyNeverSpeech() {
        // Production rememberSaveable uses ChatComposerDraft.saver — this is
        // that save/restore, not a hand-copied snapshot. SavedStateRegistry
        // keying across a real Activity still needs a composition harness
        // (device plan); the value the registry would store is decided here.
        val liveHolder = ChatDraftHolder()
        val live = ChatComposerDraft("bot-9", liveHolder, initialSaveable = "")
        live.onTypedChange("please")
        live.onDictation(Dictation.draft(base = "please", transcript = "SECRET_SPOKEN"))
        assertEquals("please SECRET_SPOKEN", live.text)

        val saver = ChatComposerDraft.saver("bot-9", liveHolder)
        val saved = with(saver) { SaverScope { true }.save(live) }
        assertEquals("please", ChatComposerDraft.typedSnapshotFromSaved(saved))
        assertFalse(requireNotNull(saved).toString().contains("SECRET_SPOKEN"))

        // Process death: new holder, restore only what the saver emitted.
        val afterDeath = ChatDraftHolder()
        val restored = requireNotNull(
            ChatComposerDraft.saver("bot-9", afterDeath).restore(requireNotNull(saved)),
        )
        assertEquals("please", restored.text)
        assertEquals("please", restored.saveableValue)
        assertFalse(restored.text.contains("SECRET_SPOKEN"))
        assertFalse(restored.contaminated)
    }

    @Test
    fun saverRestoresCorruptOrAbsentAsEmpty() {
        // Fail-closed: null / wrong type / bare string / malformed envelope
        // must not crash and must not seed speech (or any holder entry).
        val rejected: List<Any?> = listOf(
            null,
            42,
            "please SECRET_SPOKEN",
            emptyList<Any>(),
            listOf("nope", "please"),
            listOf("typed:"),
            listOf("typed:", 42),
            listOf("typed:", "please", "extra"),
        )
        for (raw in rejected) {
            assertNull(
                ChatComposerDraft.typedSnapshotFromSaved(raw),
                "expected reject for $raw",
            )
        }

        // restore() takes Saveable : Any (non-null). Feed every unexpected
        // non-null shape; null is covered by the parse → "" path below.
        val restoreRejected: List<Any> = listOf(
            42,
            "please SECRET_SPOKEN",
            emptyList<Any>(),
            listOf("nope", "please"),
            listOf("typed:"),
            listOf("typed:", 42),
            listOf("typed:", "please", "extra"),
        )
        for (raw in restoreRejected) {
            val holder = ChatDraftHolder()
            val restored = requireNotNull(
                ChatComposerDraft.saver("bot-bad", holder).restore(raw),
            )
            assertEquals("", restored.text, "raw=$raw")
            assertEquals("", restored.saveableValue, "raw=$raw")
            assertFalse(restored.contaminated, "raw=$raw")
            assertNull(holder.get("bot-bad"), "raw=$raw must not leave a holder entry")
        }

        // Absent value: parse null → empty composer, no holder entry.
        val holder = ChatDraftHolder()
        val empty = ChatComposerDraft(
            "bot-absent",
            holder,
            initialSaveable = ChatComposerDraft.typedSnapshotFromSaved(null).orEmpty(),
        )
        assertEquals("", empty.text)
        assertEquals("", empty.saveableValue)
        assertFalse(empty.contaminated)
        assertNull(holder.get("bot-absent"))
    }
}
