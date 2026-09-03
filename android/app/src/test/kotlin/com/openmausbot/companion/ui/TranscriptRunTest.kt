package com.openmausbot.companion.ui

import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.Sender
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * DELTA-06: where a run of bubbles ends, pinned against `endsRun` in
 * `ios/App/ChatView.swift`.
 *
 * The Swift asks three questions of the *next* message and none of this one:
 * a different role ends the run, a different speaker ends the run, and anything
 * that is not text ends the run. Everything else continues it, which is what
 * gives a stretch of replies one tail instead of one per bubble.
 */
class TranscriptRunTest {

    @Test
    fun `the last message always ends the run`() {
        // iOS: `guard index + 1 < messages.count else { return true }`.
        val messages = listOf(botText("m1"), botText("m2"))
        assertTrue(TranscriptLayout.endsRun(messages, 1))
        assertTrue(TranscriptLayout.endsRun(listOf(botText("only")), 0))
        assertTrue(TranscriptLayout.endsRun(emptyList(), 0))
    }

    @Test
    fun `two texts from the same side are one run`() {
        val messages = listOf(botText("m1"), botText("m2"))
        assertFalse(TranscriptLayout.endsRun(messages, 0))
    }

    @Test
    fun `the run ends where the side changes`() {
        // iOS: `if this.role != next.role { return true }`.
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1"), userText("m2")), 0))
        assertTrue(TranscriptLayout.endsRun(listOf(userText("m1"), botText("m2")), 0))
    }

    @Test
    fun `in a room the run ends where the speaker changes`() {
        // iOS: `if this.from?.name != next.from?.name { return true }`.
        val nora = Sender(botId = "bot-1", name = "Nora", color = "green")
        val ravi = Sender(botId = "bot-2", name = "Ravi", color = "cyan")
        assertTrue(
            TranscriptLayout.endsRun(listOf(botText("m1", nora), botText("m2", ravi)), 0),
        )
        assertFalse(
            TranscriptLayout.endsRun(listOf(botText("m1", nora), botText("m2", nora)), 0),
        )
        // A bot chat attributes nothing, so both sides are null and match.
        assertFalse(TranscriptLayout.endsRun(listOf(botText("m1"), botText("m2")), 0))
        // Named then unnamed is still a change.
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1", nora), botText("m2")), 0))
    }

    @Test
    fun `a card or a tool chip between two texts breaks the run visually`() {
        // iOS: `return next.kind != .text`.
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1"), botActivity("m2")), 0))
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1"), botOptions("m2")), 0))
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1"), botScreen("m2")), 0))
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1"), botUnknown("m2")), 0))
    }

    @Test
    fun `what this message is never matters — only what the next one is`() {
        // The Swift reads `this.role` and `this.from`, never `this.kind`. A tool
        // chip followed by more of the same bot's text does not end the run, and
        // the bubble that eventually does end it is the one that gets the tail.
        val messages = listOf(botActivity("m1"), botText("m2"))
        assertFalse(TranscriptLayout.endsRun(messages, 0))
        assertTrue(TranscriptLayout.endsRun(messages, 1))
    }

    @Test
    fun `an index off the end of the transcript ends the run rather than throwing`() {
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1")), 5))
        assertTrue(TranscriptLayout.endsRun(listOf(botText("m1")), -1))
    }

    @Test
    fun `the tail hangs on the speaker's own side, and only at the end of a run`() {
        // iOS: `SpeechBubble(tail: tailed ? (mine ? .trailing : .leading) : .none)`.
        assertEquals(BubbleTail.TRAILING, TranscriptLayout.tail(userText("m1"), endsRun = true))
        assertEquals(BubbleTail.LEADING, TranscriptLayout.tail(botText("m1"), endsRun = true))
        assertEquals(BubbleTail.NONE, TranscriptLayout.tail(userText("m1"), endsRun = false))
        assertEquals(BubbleTail.NONE, TranscriptLayout.tail(botText("m1"), endsRun = false))
    }
}

/**
 * What the composer's + offers, pinned against `plusActions` in
 * `ios/App/ChatView.swift`.
 *
 * The name pill is no longer a second door: for a bot it opens the agent
 * profile and for a room it opens this same sheet, so every action the pill's
 * menu used to carry has to be here — both export formats included.
 */
class ChatActionsTest {

    @Test
    fun `the sheet offers a bot everything, in the Swift's order`() {
        val actions = sheet(Chat.BotChat(bot(name = "Scout")))
        assertEquals(
            listOf(
                ChatActionId.PHOTOS,
                ChatActionId.FILES,
                ChatActionId.NEW_TASK,
                ChatActionId.TASKS,
                ChatActionId.SETTINGS,
                ChatActionId.WATCH_COMPUTER,
                ChatActionId.SHARE_MARKDOWN,
                ChatActionId.SHARE_JSON,
            ),
            actions.map { it.id },
        )
        assertEquals("Photo Library", actions[0].title)
        assertEquals("Add a photo to this message", actions[0].subtitle)
        assertEquals("Choose File", actions[1].title)
        assertEquals("Add a document from Files", actions[1].subtitle)
        assertEquals("New task", actions[2].title)
        assertEquals("Start a fresh thread with Scout", actions[2].subtitle)
        assertEquals("Tasks", actions[3].title)
        assertEquals("Switch, rename or remove one", actions[3].subtitle)
        assertEquals("Bot settings", actions[4].title)
        assertEquals("Model, profile, voice and notifications", actions[4].subtitle)
        assertEquals("Watch computer", actions[5].title)
        assertEquals("Live view of what Scout is doing", actions[5].subtitle)
        assertEquals("Share transcript", actions[6].title)
        assertEquals("This chat as Markdown", actions[6].subtitle)
        assertEquals("Share as JSON", actions[7].title)
        assertEquals("Structured transcript data", actions[7].subtitle)
    }

    @Test
    fun `a running bot can be interrupted, and cannot be given a second task`() {
        val actions = sheet(Chat.BotChat(bot(busy = true)))
        val interrupt = actions.last()
        assertEquals(ChatActionId.INTERRUPT, interrupt.id)
        assertEquals("Interrupt", interrupt.title)
        assertEquals("Stop the current turn", interrupt.subtitle)
        assertTrue(interrupt.destructive)
        // iOS: `.disabled(bot.busy == true)` on New task only.
        assertFalse(actions.single { it.id == ChatActionId.NEW_TASK }.enabled)
        assertTrue(actions.single { it.id == ChatActionId.TASKS }.enabled)
    }

    @Test
    fun `an idle bot offers no interrupt`() {
        val actions = sheet(Chat.BotChat(bot()))
        assertFalse(actions.any { it.id == ChatActionId.INTERRUPT })
        assertTrue(actions.single { it.id == ChatActionId.NEW_TASK }.enabled)
    }

    @Test
    fun `a pending approval stops a channel's New task, and only a channel's`() {
        // iOS: `disabled: current.busy || hasPendingApproval` inside
        // `if case let .room(room) = current, room.dm != true`. The bot branch
        // above it asks only `bot.busy == true`.
        val channel = Chat.RoomChat(taskCapableRoom())
        assertFalse(
            ChatActions.sheet(channel, hasPendingApproval = true, canAddAttachment = true)
                .single { it.id == ChatActionId.NEW_TASK }.enabled,
        )
        assertTrue(
            ChatActions.sheet(channel, hasPendingApproval = false, canAddAttachment = true)
                .single { it.id == ChatActionId.NEW_TASK }.enabled,
        )
        assertTrue(
            ChatActions.sheet(Chat.BotChat(bot()), hasPendingApproval = true, canAddAttachment = true)
                .single { it.id == ChatActionId.NEW_TASK }.enabled,
        )
    }

    @Test
    fun `a pending approval leaves the rest of a channel's sheet alone`() {
        val actions = ChatActions.sheet(Chat.RoomChat(taskCapableRoom()), hasPendingApproval = true, canAddAttachment = true)
        assertEquals(
            listOf(
                ChatActionId.PHOTOS,
                ChatActionId.FILES,
                ChatActionId.NEW_TASK,
                ChatActionId.TASKS,
                ChatActionId.SHARE_MARKDOWN,
                ChatActionId.SHARE_JSON,
            ),
            actions.map { it.id },
        )
        assertTrue(actions.single { it.id == ChatActionId.TASKS }.enabled)
    }

    @Test
    fun `a DM with a task list gets no task actions at all`() {
        // `Chat.supportsTasks` is `room.dm != true && room.tasks != null`; the
        // channel branch is the only one that adds them.
        val dm = Chat.RoomChat(taskCapableRoom().copy(dm = true))
        assertEquals(
            listOf(ChatActionId.PHOTOS, ChatActionId.FILES, ChatActionId.SHARE_MARKDOWN, ChatActionId.SHARE_JSON),
            sheet(dm).map { it.id },
        )
    }

    @Test
    fun `a legacy room has no tasks, no computer and nothing to interrupt`() {
        val busyRoom = Chat.RoomChat(room().copy(busyBotId = "bot-1"))
        assertEquals(
            listOf(ChatActionId.PHOTOS, ChatActionId.FILES, ChatActionId.SHARE_MARKDOWN, ChatActionId.SHARE_JSON),
            sheet(busyRoom).map { it.id },
        )
    }

    @Test
    fun `a task-capable channel offers task navigation but not computer or interrupt`() {
        val room = Chat.RoomChat(taskCapableRoom().copy(busyBotId = "bot-1"))
        val actions = sheet(room)
        assertEquals(
            listOf(
                ChatActionId.PHOTOS,
                ChatActionId.FILES,
                ChatActionId.NEW_TASK,
                ChatActionId.TASKS,
                ChatActionId.SHARE_MARKDOWN,
                ChatActionId.SHARE_JSON,
            ),
            actions.map { it.id },
        )
        assertFalse(actions.single { it.id == ChatActionId.NEW_TASK }.enabled)
        assertFalse(actions.any { it.id == ChatActionId.WATCH_COMPUTER || it.id == ChatActionId.INTERRUPT })
    }

    @Test
    fun `no action the pill's menu used to reach has gone missing`() {
        // What PORT7 shipped in the overflow and PORT13 kept in the name pill:
        // watch computer, tasks and both export formats, with Stop beside them
        // while the bot ran. The pill now opens the profile, so the + carries
        // all of it.
        val ids = sheet(Chat.BotChat(bot(busy = true))).map { it.id }.toSet()
        assertTrue(ChatActionId.NEW_TASK in ids)
        assertTrue(ChatActionId.WATCH_COMPUTER in ids)
        assertTrue(ChatActionId.TASKS in ids)
        assertTrue(ChatActionId.SHARE_MARKDOWN in ids)
        assertTrue(ChatActionId.SHARE_JSON in ids)
        assertTrue(ChatActionId.INTERRUPT in ids)
    }

    /** The sheet with nothing waiting on an answer, which is most of these cases. */
    private fun sheet(chat: Chat) = ChatActions.sheet(chat, hasPendingApproval = false, canAddAttachment = true)

    private fun taskCapableRoom(): Room =
        room().copy(tasks = listOf(BotTask("thread-room-1", "Plan", 0.0)))
}

private fun botText(id: String, from: Sender? = null): Message = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.TEXT,
    at = 1.0,
    text = "hello",
    from = from,
)

private fun userText(id: String): Message = Message(
    id = id,
    role = Message.Role.USER,
    kind = Message.Kind.TEXT,
    at = 1.0,
    text = "hello",
)

private fun botActivity(id: String): Message =
    botText(id).copy(kind = Message.Kind.ACTIVITY, text = null)

private fun botOptions(id: String): Message =
    botText(id).copy(kind = Message.Kind.OPTIONS, text = null)

private fun botScreen(id: String): Message =
    botText(id).copy(kind = Message.Kind.SCREEN, text = null)

private fun botUnknown(id: String): Message = botText(id).copy(kind = Message.Kind.UNKNOWN)
