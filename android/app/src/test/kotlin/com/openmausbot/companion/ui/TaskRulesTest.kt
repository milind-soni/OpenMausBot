package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The task rules from `ios/App/TaskManagerView.swift` and §10: a bot cannot lose
 * its last task, and a running bot refuses task changes underneath it.
 */
class TaskRulesTest {

    private fun task(id: String, title: String = "Research") =
        BotTask(threadId = id, title = title, createdAt = 0.0)

    private fun bot(
        tasks: List<BotTask>,
        current: String = "t1",
        busy: Boolean? = null,
    ): Bot = bot(id = "bot-1", busy = busy).copy(threadId = current, tasks = tasks)

    @Test
    fun `an empty title reads as untitled rather than blank`() {
        assertEquals("Untitled thread", TaskRules.title(task("t1", "")))
        assertEquals("Research", TaskRules.title(task("t1", "Research")))
    }

    @Test
    fun `the current task is the one the bot's thread points at`() {
        val subject = bot(listOf(task("t1"), task("t2")), current = "t2")
        assertFalse(TaskRules.isCurrent(task("t1"), subject))
        assertTrue(TaskRules.isCurrent(task("t2"), subject))
    }

    @Test
    fun `the last task cannot be deleted`() {
        val only = task("t1")
        assertFalse(TaskRules.canDelete(only, bot(listOf(only))))
        assertTrue(TaskRules.canDelete(only, bot(listOf(only, task("t2")))))
    }

    @Test
    fun `a busy bot refuses create, delete and switch`() {
        val tasks = listOf(task("t1"), task("t2"))
        val busy = bot(tasks, current = "t1", busy = true)
        assertFalse(TaskRules.canCreate(busy))
        assertFalse(TaskRules.canDelete(task("t2"), busy))
        assertFalse(TaskRules.canSwitch(task("t2"), busy))
    }

    @Test
    fun `independent tasks allow navigation while only the running task refuses deletion`() {
        val running = task("t1").copy(busy = true)
        val idle = task("t2").copy(busy = false)
        val subject = bot(listOf(running, idle), busy = true)
        assertTrue(TaskRules.canCreate(subject))
        assertTrue(TaskDialogRules.createEnabled(Chat.BotChat(subject)))
        assertTrue(ChatActions.sheet(Chat.BotChat(subject), hasPendingApproval = true, canAddAttachment = true)
            .single { it.id == ChatActionId.NEW_TASK }.enabled)
        assertTrue(TaskRules.canSwitch(idle, subject))
        assertTrue(TaskRules.canDelete(idle, subject))
        assertFalse(TaskRules.canDelete(running, subject))
    }

    @Test
    fun `an idle bot allows all three`() {
        val tasks = listOf(task("t1"), task("t2"))
        val idle = bot(tasks, current = "t1", busy = false)
        assertTrue(TaskRules.canCreate(idle))
        assertTrue(TaskRules.canDelete(task("t2"), idle))
        assertTrue(TaskRules.canSwitch(task("t2"), idle))
    }

    @Test
    fun `a null busy flag counts as idle`() {
        val tasks = listOf(task("t1"), task("t2"))
        val unknown = bot(tasks, current = "t1", busy = null)
        assertTrue(TaskRules.canCreate(unknown))
        assertTrue(TaskRules.canSwitch(task("t2"), unknown))
    }

    @Test
    fun `switching to the task already open is not a switch`() {
        val tasks = listOf(task("t1"), task("t2"))
        assertFalse(TaskRules.canSwitch(task("t1"), bot(tasks, current = "t1")))
    }

    @Test
    fun `a task the bot no longer lists cannot be deleted`() {
        val subject = bot(listOf(task("t1"), task("t2")))
        assertFalse(TaskRules.canDelete(task("gone"), subject))
    }

    @Test
    fun `renaming is allowed even while busy — it touches the label, not the thread`() {
        assertTrue(TaskRules.canRename(bot(listOf(task("t1")), busy = true)))
    }

    @Test
    fun `a bot with no task list reports none`() {
        assertEquals(emptyList(), TaskRules.tasks(bot(id = "bot-1")))
    }

    @Test
    fun `thread pickers hide only marked bot executions and preserve direct switching`() {
        val legacy = task("legacy", "Routine: old run")
        val results = task("results", "Brief results")
        val execution = task("run-thread").copy(routineRunId = "run-1", busy = true)
        val subject = bot(listOf(legacy, results, execution), current = "results", busy = true)

        assertEquals(listOf(legacy, results), TaskRules.tasks(subject))
        assertEquals(listOf(legacy, results), TaskRules.tasks(Chat.BotChat(subject)))
        assertEquals(3, subject.tasks?.size)
        assertTrue(TaskRules.canCreate(subject))
        assertTrue(TaskRules.canSwitch(execution, subject))
        assertFalse(TaskRules.canDelete(results, subject.copy(tasks = listOf(results, execution))))

        // The wire type is shared, but routine execution markers are bot-only.
        val group = Chat.RoomChat(room().copy(tasks = listOf(legacy, execution)))
        assertEquals(listOf(legacy, execution), TaskRules.tasks(group))
    }

    @Test
    fun `room tasks use the same navigation rules as bot tasks`() {
        val tasks = listOf(task("t1"), task("t2"))
        val room = Chat.RoomChat(room().copy(threadId = "t1", tasks = tasks))
        assertEquals(tasks, TaskRules.tasks(room))
        assertTrue(TaskRules.isCurrent(task("t1"), room))
        assertTrue(TaskRules.canSwitch(task("t2"), room))
        assertTrue(TaskRules.canDelete(task("t2"), room))
        assertEquals("Group threads", TaskRules.subtitle(room))
    }
}

/**
 * The dialogs keep following the bot after they are on screen, and the rename
 * field is allowed to be empty.
 */
class TaskDialogRulesTest {

    private fun subject(busy: Boolean?) =
        bot(id = "bot-1", busy = busy).copy(
            tasks = listOf(BotTask("t1", "First", 0.0), BotTask("t2", "Second", 1.0)),
        )

    @Test
    fun `a bot that starts running while the create dialog is open disables Create`() {
        assertTrue(TaskDialogRules.createEnabled(subject(busy = false)))
        assertFalse(
            TaskDialogRules.createEnabled(subject(busy = true)),
            "Create must not stay lit to collect a 409",
        )
    }

    @Test
    fun `an empty rename is allowed, as iOS allows it`() {
        val idle = subject(busy = false)
        assertTrue(TaskDialogRules.renameEnabled(idle, ""))
        assertTrue(TaskDialogRules.renameEnabled(idle, "   "))
        assertTrue(TaskDialogRules.renameEnabled(idle, "Research"))
    }

    @Test
    fun `renaming is not gated on busy either`() {
        assertTrue(TaskDialogRules.renameEnabled(subject(busy = true), "Research"))
    }

    @Test
    fun `create trims, and an empty title lets the harness name the task`() {
        assertEquals("Research", TaskDialogRules.createTitle("  Research  "))
        assertNull(TaskDialogRules.createTitle(""))
        assertNull(TaskDialogRules.createTitle("   "))
    }

    @Test
    fun `rename sends the field as typed`() {
        assertEquals("", TaskDialogRules.renameTitle(""))
        assertEquals("  spaced  ", TaskDialogRules.renameTitle("  spaced  "))
    }
}
