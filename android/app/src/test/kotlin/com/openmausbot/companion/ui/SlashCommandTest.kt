package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.SaverScope
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Expectations read off `CommandSkillHUDView.defaultCommands`,
 * `PredictiveActionChipsView.defaultChips` and the composer in
 * `ios/App/ChatView.swift` — the `commands:` filter for rooms, the
 * `onSelectCommand` switch, `onChange(of: draft)`, the close button's
 * `if text == "/"`, and the `else if draft.isEmpty && !current.busy &&
 * !hasPendingApproval` that gates the chips. Not derived from the Kotlin.
 */
class SlashCommandsTest {
    @Test
    fun `the five commands, in the order the HUD lists them`() {
        assertEquals(
            listOf(
                SlashCommandId.COMPUTER,
                SlashCommandId.TASKS,
                SlashCommandId.DIFF,
                SlashCommandId.RETRY,
                SlashCommandId.STEER,
            ),
            SlashCommands.ALL.map { it.id },
        )
        assertEquals(
            listOf("/computer", "/threads", "/diff", "/retry", "/steer"),
            SlashCommands.ALL.map { it.title },
        )
    }

    @Test
    fun `the three prompts are the words the Swift sends, exactly`() {
        assertEquals(SlashEffect.Send("Show git diff and list modified files"), effect("/diff"))
        assertEquals(SlashEffect.Send("Please retry the last turn"), effect("/retry"))
        assertEquals(SlashEffect.Send("Pause and explain your current plan"), effect("/steer"))
    }

    @Test
    fun `computer and tasks navigate, and carry no prompt to send`() {
        assertEquals(SlashEffect.OpenComputer, effect("/computer"))
        assertEquals(SlashEffect.OpenTasks, effect("/threads"))
        assertEquals(
            listOf("/diff", "/retry", "/steer"),
            SlashCommands.ALL.filter { it.effect is SlashEffect.Send }.map { it.title },
        )
    }

    @Test
    fun `a room has no computer and no task list`() {
        assertEquals(
            listOf("/diff", "/retry", "/steer"),
            SlashCommands.forChat(Chat.RoomChat(room())).map { it.title },
        )
    }

    @Test
    fun `a channel with tasks keeps tasks but never computer`() {
        val channel = Chat.RoomChat(room().copy(tasks = listOf(BotTask("task-1", "Plan", 0.0))))
        assertEquals(
            listOf("/threads", "/diff", "/retry", "/steer"),
            SlashCommands.forChat(channel).map { it.title },
        )
    }

    @Test
    fun `a DM is still a DM, even when the desktop sends it a task list`() {
        // `Chat.supportsTasks` is `room.dm != true && room.tasks != null`
        // (`ios/App/Session.swift:1352`). A channel with tasks keeps /tasks; a
        // DM with the very same list does not, and the sheet behind it is gated
        // on the same answer.
        val dm = Chat.RoomChat(
            room().copy(dm = true, tasks = listOf(BotTask("task-1", "Plan", 0.0))),
        )
        assertFalse(dm.supportsTasks)
        assertEquals(
            listOf("/diff", "/retry", "/steer"),
            SlashCommands.forChat(dm).map { it.title },
        )
    }

    @Test
    fun `a bot chat keeps all five`() {
        assertEquals(SlashCommands.ALL, SlashCommands.forChat(Chat.BotChat(bot())))
    }

    @Test
    fun `a lone slash filters nothing`() {
        assertEquals(SlashCommands.ALL, SlashCommands.matching(SlashCommands.ALL, "/"))
        assertEquals(SlashCommands.ALL, SlashCommands.matching(SlashCommands.ALL, ""))
        assertEquals(SlashCommands.ALL, SlashCommands.matching(SlashCommands.ALL, "hello"))
    }

    @Test
    fun `what follows the slash filters on the title`() {
        assertEquals(
            listOf("/computer"),
            SlashCommands.matching(SlashCommands.ALL, "/comp").map { it.title },
        )
        assertEquals(
            listOf("/retry"),
            SlashCommands.matching(SlashCommands.ALL, "/RET").map { it.title },
        )
    }

    @Test
    fun `and on the description, so a command is findable by what it does`() {
        // "git" appears in no title; it is in `/diff`'s description.
        assertEquals(
            listOf("/diff"),
            SlashCommands.matching(SlashCommands.ALL, "/git").map { it.title },
        )
        assertEquals(
            listOf("/computer"),
            SlashCommands.matching(SlashCommands.ALL, "/desktop").map { it.title },
        )
    }

    @Test
    fun `a query nothing answers to shows nothing`() {
        assertTrue(SlashCommands.matching(SlashCommands.ALL, "/zzz").isEmpty())
    }

    @Test
    fun `a draft that starts with a slash opens the HUD, and anything else closes it`() {
        assertTrue(SlashCommands.opensOnDraft("/"))
        assertTrue(SlashCommands.opensOnDraft("/dif"))
        assertFalse(SlashCommands.opensOnDraft(""))
        assertFalse(SlashCommands.opensOnDraft("hello /diff"))
        assertFalse(SlashCommands.opensOnDraft(" /diff"))
    }

    @Test
    fun `closing takes back the literal slash and nothing else`() {
        assertEquals("", SlashCommands.draftAfterClose("/"))
        assertEquals("/d", SlashCommands.draftAfterClose("/d"))
        assertEquals("//", SlashCommands.draftAfterClose("//"))
        assertEquals("/ ", SlashCommands.draftAfterClose("/ "))
        assertEquals("what changed?", SlashCommands.draftAfterClose("what changed?"))
    }
}

/**
 * The panel has to survive the two ways this screen is torn down and put back:
 * `ChatView` on iOS is never torn down for Computer, so `draft` and
 * `showCommandHUD` cannot come apart there. Here they can, which is why the
 * entry state is derived rather than assumed.
 *
 * Driven through the same objects `LoadedChat` mounts with — a real
 * [ChatDraftHolder], the real [CompanionNavigator] push/pop, and the production
 * [ChatComposerDraft.saver] — rather than a hand-written string.
 */
class SlashCommandEntryTest {
    @Test
    fun `a chat that comes back from Computer on a slash draft comes back with the HUD`() {
        val chatId = "bot-1"
        val holder = ChatDraftHolder()
        val navigator = CompanionNavigator()
        val typed = ChatComposerDraft(chatId, holder, initialSaveable = "")
        typed.onTypedChange("/dif")

        navigator.push(Destination.Chat(ChatTarget.Bot(chatId, "thread-1")))
        navigator.push(Destination.Computer(chatId))
        // The push that takes ChatScreen out of composition while keeping the draft.
        assertTrue(navigator.retainsChatDraft(chatId))
        navigator.pop()

        val remounted = ChatComposerDraft(
            chatId,
            holder,
            initialSaveable = holder.get(chatId)!!.typedSnapshot,
        )
        assertEquals("/dif", remounted.text)
        assertTrue(SlashCommands.openOnEntry(remounted.text))
    }

    @Test
    fun `a chat rebuilt after process death on a slash draft opens with the HUD`() {
        val chatId = "bot-2"
        val holder = ChatDraftHolder()
        val typed = ChatComposerDraft(chatId, holder, initialSaveable = "")
        typed.onTypedChange("/dif")

        val saved = with(ChatComposerDraft.saver(chatId, holder)) {
            SaverScope { true }.save(typed)
        }
        val restored = requireNotNull(
            ChatComposerDraft.saver(chatId, ChatDraftHolder())
                .restore(requireNotNull(saved)),
        )
        assertEquals("/dif", restored.text)
        assertTrue(SlashCommands.openOnEntry(restored.text))
    }

    @Test
    fun `a chat that comes back on anything else comes back closed`() {
        val chatId = "bot-3"
        val holder = ChatDraftHolder()
        val typed = ChatComposerDraft(chatId, holder, initialSaveable = "")
        typed.onTypedChange("what changed?")

        val remounted = ChatComposerDraft(
            chatId,
            holder,
            initialSaveable = holder.get(chatId)!!.typedSnapshot,
        )
        assertFalse(SlashCommands.openOnEntry(remounted.text))
    }

    @Test
    fun `a chat reopened from the roster opens closed`() {
        val chatId = "bot-4"
        val holder = ChatDraftHolder()
        val typed = ChatComposerDraft(chatId, holder, initialSaveable = "")
        typed.onTypedChange("/dif")
        // Leaving to the roster clears both halves before the pop.
        typed.onLeaveToRoster()

        val reopened = ChatComposerDraft(chatId, holder, initialSaveable = "")
        assertEquals("", reopened.text)
        assertFalse(SlashCommands.openOnEntry(reopened.text))
    }
}

class PredictiveChipsTest {
    @Test
    fun `four chips, sending the words the Swift sends`() {
        assertEquals(
            listOf(
                "Show latest git diff",
                "Run all automated tests",
                "Explain the changes in detail",
                "What should we do next?",
            ),
            PredictiveChips.ALL.map { it.prompt },
        )
        assertEquals(
            listOf("Show diff", "Run tests", "Explain steps", "What's next?"),
            PredictiveChips.ALL.map { it.title },
        )
    }
}

class ComposerAccessoriesTest {
    @Test
    fun `an empty composer over an idle bot offers the chips`() {
        assertEquals(
            ComposerAccessory.CHIPS,
            ComposerAccessories.accessory(
                hudOpen = false,
                draft = "",
                busy = false,
                pendingApproval = false,
                hasQuickReplies = true,
                hasAttachments = false,
            ),
        )
    }

    @Test
    fun `half a sentence is not an empty composer`() {
        // A chip sends immediately; offering one here would throw the sentence
        // away. Not trimmed, exactly as `draft.isEmpty` on iOS is not.
        assertEquals(ComposerAccessory.NONE, accessory(draft = "wha"))
        assertEquals(ComposerAccessory.NONE, accessory(draft = " "))
    }

    @Test
    fun `a busy bot is not offered another turn`() {
        assertEquals(ComposerAccessory.NONE, accessory(busy = true))
    }

    @Test
    fun `a pending approval is the only thing on screen worth tapping`() {
        assertEquals(ComposerAccessory.NONE, accessory(pendingApproval = true))
    }

    @Test
    fun `the HUD wins over the chips wherever both could apply`() {
        assertEquals(ComposerAccessory.HUD, accessory(hudOpen = true))
        assertEquals(
            ComposerAccessory.HUD,
            ComposerAccessories.accessory(
                hudOpen = true,
                draft = "/dif",
                busy = true,
                pendingApproval = true,
                hasQuickReplies = true,
                hasAttachments = false,
            ),
        )
    }

    @Test
    fun `a card still waiting on an answer is a pending approval`() {
        assertTrue(ComposerAccessories.hasPendingApproval(listOf(card(pending = true))))
        assertFalse(ComposerAccessories.hasPendingApproval(listOf(card(pending = false))))
        assertFalse(ComposerAccessories.hasPendingApproval(emptyList()))
        assertTrue(
            ComposerAccessories.hasPendingApproval(
                listOf(card(pending = false), card(pending = true)),
            ),
        )
    }

    private fun accessory(
        hudOpen: Boolean = false,
        draft: String = "",
        busy: Boolean = false,
        pendingApproval: Boolean = false,
        hasQuickReplies: Boolean = true,
        hasAttachments: Boolean = false,
    ) = ComposerAccessories.accessory(hudOpen, draft, busy, pendingApproval, hasQuickReplies, hasAttachments)

    private fun card(pending: Boolean): Message = Message(
        id = if (pending) "pending" else "answered",
        role = Message.Role.BOT,
        kind = Message.Kind.OPTIONS,
        at = 1.0,
        card = OptionCard(
            title = "Run tests?",
            subtitle = "npm test",
            options = listOf("Allow", "Deny"),
            answered = if (pending) null else "Allow",
            requestId = "req-1",
        ),
    )
}

private fun effect(title: String): SlashEffect =
    SlashCommands.ALL.first { it.title == title }.effect
