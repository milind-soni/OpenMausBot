package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TaskIsolationTest {
    private val modelA = ModelSelection("codex", "model-a")
    private val modelB = ModelSelection("claude", "model-b")
    private val taskA = BotTask("a", "A", 1.0, modelSelection = modelA, busy = true,
        activity = "waiting-on-you", unread = true, approvalMode = "ask", alwaysAllow = emptyList())
    private val taskB = BotTask("b", "B", 2.0, modelSelection = modelB, busy = false,
        activity = "idle", unread = false, approvalMode = "auto", alwaysAllow = listOf("Read"))
    private val bot = Bot("bot", "b", "Scout", "Research", "", true, "blue", true,
        ModelSelection("default", "default"), 1.0, busy = true, tasks = listOf(taskA, taskB))

    @Test
    fun taskControlsUseTheirOwnModelActivityAndApprovalsWithoutChangingTheProfile() {
        val state = CompanionState(bots = listOf(bot))
        val a = (state.chat(ChatTarget.Bot("bot", "a")) as Chat.BotChat).bot
        val b = (state.chat(ChatTarget.Bot("bot", "b")) as Chat.BotChat).bot
        assertEquals(modelA, a.modelSelection)
        assertEquals(modelB, b.modelSelection)
        assertTrue(a.busy == true)
        assertFalse(b.busy == true)
        assertEquals("waiting-on-you", a.activity)
        assertEquals("ask", a.approvalMode)
        assertEquals("auto", b.approvalMode)
        assertEquals(emptyList(), a.alwaysAllow)
        assertEquals(listOf("Read"), b.alwaysAllow)
        assertEquals("default", state.bot("bot")?.modelSelection?.model)
        assertNull(bot.forTask("foreign"))
    }

    @Test
    fun oldTaskPayloadsKeepDecodingAndSelectedLegacyControlsStillWork() {
        val old = CompanionJson.decodeFromString<BotTask>("""{"threadId":"a","title":"A","createdAt":1}""")
        assertNull(old.busy)
        assertNull(old.modelSelection)
        assertNull(old.routineRunId)
        val legacy = bot.copy(threadId = "a", tasks = listOf(old))
        assertEquals(legacy.modelSelection, legacy.forTask("a")?.modelSelection)
        assertEquals(true, legacy.forTask("a")?.busy)
    }

    @Test
    fun routineExecutionMarkerPreservesDirectNavigationAndPendingApprovals() {
        val execution = CompanionJson.decodeFromString<BotTask>(
            """{"threadId":"run-thread","title":"Brief","createdAt":3,"routineRunId":"run-1","busy":true,"activity":"waiting-on-you","approvalMode":"ask"}""",
        )
        assertEquals("run-1", execution.routineRunId)
        val card = Message("approval", Message.Role.BOT, Message.Kind.OPTIONS, 4.0,
            card = OptionCard("Approve?", "Read", listOf("Approve", "Deny"), requestId = "request"))
        val state = CompanionState(
            bots = listOf(bot.copy(tasks = listOf(taskB, execution))),
            messages = mapOf("run-thread" to listOf(card)),
        )
        val opened = (state.chat(ChatTarget.Bot("bot", "run-thread")) as Chat.BotChat).bot
        assertEquals("run-thread", opened.threadId)
        assertEquals(true, opened.busy)
        assertEquals("waiting-on-you", opened.activity)
        assertEquals("ask", opened.approvalMode)
        assertEquals(2, state.bot("bot")?.tasks?.size)
        assertEquals("run-thread", state.botForThread("run-thread")?.threadId)
        assertEquals(listOf(card), state.visibleTranscript("run-thread"))
        assertEquals(listOf("run-thread"), state.pendingApprovals.map(PendingApproval::threadId))
    }

    @Test
    fun taskApprovalMirrorTakesPrecedenceOverTheProfileButNotAnExplicitMode() {
        for (taskAuto in listOf(true, false)) {
            val old = CompanionJson.decodeFromString<BotTask>(
                """{"threadId":"a","title":"A","createdAt":1,"autoApprove":$taskAuto}""")
            val profile = bot.copy(approvalMode = if (taskAuto) "ask" else "auto", tasks = listOf(old, taskB))
            assertEquals(if (taskAuto) "auto" else "ask", profile.forTask("a")?.approvalMode)
            assertEquals(taskAuto, profile.forTask("a")?.autoApprove)
            assertEquals("full", profile.copy(tasks = listOf(old.copy(approvalMode = "full")))
                .forTask("a")?.approvalMode)
            assertEquals(profile.approvalMode, profile.copy(tasks = listOf(old.copy(autoApprove = null)))
                .forTask("a")?.approvalMode)
        }
    }

    @Test
    fun selectedBotFramesDoNotClearASiblingsReplyOrBranchAndApprovalsStayDiscoverable() {
        val root = Message("root", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "A")
        val chosen = Message("chosen", Message.Role.BOT, Message.Kind.TEXT, 2.0, parentId = "root", text = "Chosen")
        val alternate = chosen.copy(id = "alternate", text = "Other version")
        val card = Message("approval", Message.Role.BOT, Message.Kind.OPTIONS, 3.0, parentId = "chosen",
            card = OptionCard("Approve?", "Read", listOf("Approve", "Deny"), requestId = "request"))
        val state = CompanionState(bots = listOf(bot.copy(threadId = "a", activeLeafId = "approval")),
            messages = mapOf("a" to listOf(root, chosen, alternate, card)),
            streaming = mapOf("a" to "Still writing", "b" to "Old settled delta"))
            .apply(Frame.Thread("a", "approval"))
            .copy(streaming = mapOf("a" to "Still writing", "b" to "Old settled delta"))
            .apply(Frame.Bot(bot.copy(messages = emptyList())))
        assertEquals("Still writing", state.streaming["a"])
        assertNull(state.streaming["b"])
        assertEquals(listOf("root", "chosen", "approval"), state.visibleTranscript("a").map(Message::id))
        assertEquals(listOf("a"), state.pendingApprovals.map(PendingApproval::threadId))
        val cold = CompanionState(bots = listOf(bot)).merge(
            ThreadPage(listOf(root, chosen, alternate, card), activeLeafId = "approval"), "a")
        assertEquals(listOf("root", "chosen", "approval"), cold.visibleTranscript("a").map(Message::id))
    }
}
