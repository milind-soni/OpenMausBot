package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The List density setting and what a compact home-list row shows, without a
 * screen. The rules mirror the iPhone companion's compact list, case for case
 * where the two models agree.
 *
 * Compact is one line per bot: a "› N" control only where there is a list to
 * open, and status as small marks. Comfortable keeps the logic it shipped with
 * in its own composables, so nothing here decides a comfortable row.
 */
class RosterDensityTest {
    // The setting

    @Test
    fun compactIsTheDefault() {
        assertEquals(RosterDensity.COMPACT, RosterDensity.DEFAULT)
        assertEquals(RosterDensity.COMPACT, RosterDensity.fromWire(null))
    }

    @Test
    fun storedChoicesRoundTrip() {
        RosterDensity.entries.forEach { density ->
            assertEquals(density, RosterDensity.fromWire(density.wireValue))
        }
        assertEquals(listOf(RosterDensity.COMFORTABLE, RosterDensity.COMPACT), RosterDensity.entries)
        assertEquals(listOf("comfortable", "compact"), RosterDensity.entries.map { it.wireValue })
    }

    /** A value this build cannot read — a typo, a newer build's choice — must
     * land on the default, not on comfortable. */
    @Test
    fun unreadableStoredValuesFallBackToCompact() {
        assertEquals(RosterDensity.COMPACT, RosterDensity.fromWire("icons"))
        assertEquals(RosterDensity.COMPACT, RosterDensity.fromWire(""))
        assertEquals(RosterDensity.COMPACT, RosterDensity.fromWire("Compact"))
        assertEquals(RosterDensity.COMPACT, RosterDensity.fromWire("COMFORTABLE"))
    }

    @Test
    fun settingsNamesBothChoicesAndSaysWhatEachDoes() {
        assertEquals(listOf("Comfortable", "Compact"), RosterDensity.entries.map { it.label })
        RosterDensity.entries.forEach { assertTrue(it.caption.isNotBlank()) }
        // the count leaves put-away threads out, so the caption says "active"
        assertTrue("more than one active thread" in RosterDensity.COMPACT.caption)
    }

    // Thread count behind "› N"

    @Test
    fun threadCountMatchesTheTreeAndSkipsRoutineRuns() {
        val bot = bot(listOf(task("a"), task("b"), task("run", routine = true)))
        assertEquals(2, bot.rosterThreadCount())
        assertEquals(bot.threadGroups().sumOf { it.tasks.size }, bot.rosterThreadCount())
    }

    @Test
    fun threadCountLeavesOutFoldedThreadsLikeTheTree() {
        val closed = task("closed").copy(closedBy = ThreadCloser(botId = "pm", name = "PM", at = 1.0))
        val archived = task("archived").copy(archivedAt = 1.0)
        assertEquals(1, bot(listOf(task("a"), closed, archived)).rosterThreadCount())
    }

    /** Android's tree folds a sleeping thread too, until its clock runs out. */
    @Test
    fun threadCountLeavesOutSnoozedThreadsUntilTheyWake() {
        val asleep = task("asleep").copy(snoozedUntil = 0.0)
        val timed = task("timed").copy(snoozedUntil = 2_000.0)
        val bot = bot(listOf(task("a"), asleep, timed))
        assertEquals(1, bot.rosterThreadCount(now = 1_000))
        assertEquals(2, bot.rosterThreadCount(now = 3_000))
    }

    /** A closed thread holding a queued send stays in the tree, so it counts. */
    @Test
    fun threadCountKeepsAFoldedThreadWithAHeldSend() {
        val closed = task("closed").copy(closedBy = ThreadCloser(botId = "pm", name = "PM", at = 1.0))
        assertEquals(2, bot(listOf(task("a"), closed)).rosterThreadCount(queuedThreadIds = setOf("closed")))
    }

    /** Older computers send no task list: that is one conversation. */
    @Test
    fun legacyBotWithoutTasksHasOneThread() {
        assertEquals(1, bot(emptyList()).copy(tasks = null).rosterThreadCount())
    }

    // Status

    @Test
    fun idleBotHasNoStatus() {
        assertEquals(RosterRowStatus.IDLE, bot(listOf(task("a"))).rosterStatus(hasPendingCard = false))
    }

    @Test
    fun anyWorkingThreadMakesTheBotWork() {
        val background = task("b").copy(activity = "working")
        assertEquals(
            RosterRowStatus.WORKING,
            bot(listOf(task("a"), background)).rosterStatus(hasPendingCard = false),
        )
        assertEquals(
            RosterRowStatus.WORKING,
            bot(listOf(task("a"))).copy(busy = true).rosterStatus(hasPendingCard = false),
        )
    }

    /** The harness counts waiting-on-you as busy. The person comes first. */
    @Test
    fun waitingOnYouOutranksWorking() {
        val waiting = task("a").copy(activity = "waiting-on-you", busy = true)
        assertEquals(
            RosterRowStatus.WAITING_ON_YOU,
            bot(listOf(waiting)).copy(busy = true).rosterStatus(hasPendingCard = false),
        )
    }

    @Test
    fun anUnansweredCardMeansWaitingOnYou() {
        assertEquals(
            RosterRowStatus.WAITING_ON_YOU,
            bot(listOf(task("a"))).copy(busy = true).rosterStatus(hasPendingCard = true),
        )
    }

    /** A teammate wait is a quiet wait, never the work spinner. */
    @Test
    fun teammateWaitIsNotWork() {
        val waiting = task("a").copy(busy = true, activity = "working", waitingOnTeammate = true)
        val bot = bot(listOf(waiting)).copy(busy = true, waitingOnTeammate = true)
        assertEquals(RosterRowStatus.IDLE, bot.rosterStatus(hasPendingCard = false))
    }

    @Test
    fun routineRunsDoNotMakeTheRowWork() {
        val run = task("run", routine = true).copy(busy = true)
        assertEquals(RosterRowStatus.IDLE, bot(listOf(task("a"), run)).rosterStatus(hasPendingCard = false))
    }

    /**
     * The bot's own activity is its current thread's when that thread's task
     * carries none — the fallback `Bot.forTask` makes when a chat opens.
     */
    @Test
    fun theCurrentThreadFallsBackToTheBotsActivity() {
        val bot = bot(listOf(task("a"), task("b"))).copy(activity = "waiting-on-you", busy = true)
        assertEquals(RosterRowStatus.WAITING_ON_YOU, bot.rosterStatus(hasPendingCard = false))
    }

    /** A thread's own activity wins, and no other thread borrows the bot's. */
    @Test
    fun onlyTheCurrentThreadWithoutItsOwnActivityBorrowsTheBots() {
        val current = task("a").copy(activity = "idle")
        val other = task("b")
        val bot = bot(listOf(current, other)).copy(activity = "waiting-on-you")
        assertEquals(RosterRowStatus.IDLE, bot.rosterStatus(hasPendingCard = false))
    }

    /** Older computers send no task list: the bot's own fields are its one thread, as in the tree. */
    @Test
    fun aLegacyBotWaitingOnYouShowsTheHandNotTheSpinner() {
        val legacy = bot(emptyList()).copy(tasks = null, activity = "waiting-on-you", busy = true)
        assertEquals(RosterRowStatus.WAITING_ON_YOU, legacy.rosterStatus(hasPendingCard = false))
        val working = bot(emptyList()).copy(tasks = null, activity = "working")
        assertEquals(RosterRowStatus.WORKING, working.rosterStatus(hasPendingCard = false))
        assertEquals(RosterRowStatus.IDLE, bot(emptyList()).copy(tasks = null).rosterStatus(hasPendingCard = false))
    }

    // The compact row

    @Test
    fun singleThreadBotHasNoThreadControl() {
        val row = RosterBotRow(bot(listOf(task("a"))), hasPendingCard = false)
        assertEquals(1, row.threadCount)
        assertFalse(row.showsThreadControl)
        assertFalse(row.listsThreads(expanded = true, searching = false))
        assertFalse(row.endsWithNewThread(expanded = true, searching = false))
    }

    @Test
    fun multiThreadBotOpensItsListWithNewThreadAtTheEnd() {
        val row = RosterBotRow(bot(listOf(task("a"), task("b"))), hasPendingCard = false)
        assertTrue(row.showsThreadControl)
        assertEquals(2, row.threadCount)
        assertFalse(row.listsThreads(expanded = false, searching = false))
        assertTrue(row.listsThreads(expanded = true, searching = false))
        assertTrue(row.endsWithNewThread(expanded = true, searching = false))
        assertFalse(row.endsWithNewThread(expanded = false, searching = false))
    }

    /** Search lists what matched under every bot, as the desktop does;
     * results are not a place to create a thread. */
    @Test
    fun searchListsMatchesWithoutNewThread() {
        val single = RosterBotRow(bot(listOf(task("a"))), hasPendingCard = false)
        assertTrue(single.listsThreads(expanded = false, searching = true))
        assertFalse(single.endsWithNewThread(expanded = false, searching = true))

        val multi = RosterBotRow(bot(listOf(task("a"), task("b"))), hasPendingCard = false)
        assertTrue(multi.listsThreads(expanded = true, searching = true))
        assertFalse(multi.endsWithNewThread(expanded = true, searching = true))
    }

    /** An opened list whose control went away — threads closed or deleted —
     * is dropped, so a later second thread does not reopen it by itself. */
    @Test
    fun anOpenListIsDroppedOnceItsControlGoes() {
        val single = RosterBotRow(bot(listOf(task("a"))), hasPendingCard = false)
        assertTrue(single.dropsExpansion(expanded = true))
        assertFalse(single.dropsExpansion(expanded = false))
        val multi = RosterBotRow(bot(listOf(task("a"), task("b"))), hasPendingCard = false)
        assertFalse(multi.dropsExpansion(expanded = true))
    }

    @Test
    fun compactWorkingRowSwapsTheTimeForASpinner() {
        val row = RosterBotRow(bot(listOf(task("a"))).copy(busy = true), hasPendingCard = false)
        assertTrue(row.showsSpinner)
        assertFalse(row.showsTime)
    }

    @Test
    fun compactWaitingRowKeepsItsTimeAndShowsTheHand() {
        val waiting = task("a").copy(activity = "waiting-on-you")
        val row = RosterBotRow(bot(listOf(waiting)).copy(busy = true), hasPendingCard = false)
        assertTrue(row.showsWaiting)
        assertFalse(row.showsSpinner)
        assertTrue(row.showsTime)
    }

    @Test
    fun chiefOfStaffWearsTheCrown() {
        val chief = bot(listOf(task("a"))).copy(chiefOfStaff = true)
        assertTrue(RosterBotRow(chief, hasPendingCard = false).showsChiefBadge)
        assertFalse(RosterBotRow(bot(listOf(task("a"))), hasPendingCard = false).showsChiefBadge)
    }

    // The unread dot: the rule the comfortable row has always used — shown
    // while the bot is unread, hidden while the bot itself is busy.

    @Test
    fun unreadDotHidesWhileTheBotIsBusy() {
        val unread = bot(listOf(task("a"))).copy(unread = true)
        assertTrue(RosterBotRow(unread, hasPendingCard = false).showsUnreadDot)
        assertFalse(RosterBotRow(unread.copy(busy = true), hasPendingCard = false).showsUnreadDot)
    }

    /** The harness paints a wait on the person busy, so the hand stands alone. */
    @Test
    fun unreadDotHidesWhileWaitingOnYou() {
        val waiting = task("a").copy(activity = "waiting-on-you", busy = true)
        val row = RosterBotRow(bot(listOf(waiting)).copy(unread = true, busy = true), hasPendingCard = false)
        assertTrue(row.showsWaiting)
        assertFalse(row.showsUnreadDot)
    }

    /** A teammate wait is painted busy too: no dot, and no spinner either. */
    @Test
    fun unreadDotHidesDuringATeammateWait() {
        val waiting = task("a").copy(busy = true, waitingOnTeammate = true)
        val bot = bot(listOf(waiting)).copy(unread = true, busy = true, waitingOnTeammate = true)
        val row = RosterBotRow(bot, hasPendingCard = false)
        assertFalse(row.showsUnreadDot)
        assertFalse(row.showsSpinner)
    }

    /** Busy is the bot's own flag: work in another thread spins without hiding the dot. */
    @Test
    fun unreadDotStaysWhileAnotherThreadWorks() {
        val background = task("b").copy(activity = "working")
        val row = RosterBotRow(bot(listOf(task("a"), background)).copy(unread = true), hasPendingCard = false)
        assertTrue(row.showsSpinner)
        assertTrue(row.showsUnreadDot)
    }

    // The label over unfiled threads

    /** Beneath a folder, unfiled threads would read as that folder's: they get a "Threads" label. */
    @Test
    fun unfiledThreadsAreLabelledOnlyBeneathAFolder() {
        val folder = BotProject(id = "email", name = "Email")
        val filed = task("filed").copy(projectId = "email")
        val both = bot(listOf(filed, task("loose"))).copy(projects = listOf(folder)).threadGroups()
        assertTrue(labelsUnfiledThreads(both))

        val onlyUnfiled = bot(listOf(task("a"), task("b"))).threadGroups()
        assertFalse(labelsUnfiledThreads(onlyUnfiled))
        val onlyFiled = bot(listOf(filed)).copy(projects = listOf(folder)).threadGroups()
        assertFalse(labelsUnfiledThreads(onlyFiled))
        assertFalse(labelsUnfiledThreads(emptyList()))
    }

    // Helpers

    private fun task(id: String, routine: Boolean = false): BotTask =
        BotTask(threadId = id, title = id, createdAt = 1.0, routineRunId = if (routine) "run-$id" else null)

    private fun bot(tasks: List<BotTask>): Bot = Bot(
        id = "bot", threadId = tasks.firstOrNull()?.threadId ?: "bot-thread", name = "Bot", title = "Helper",
        description = "", notifications = true, color = "blue", unread = false,
        modelSelection = ModelSelection("i", "m"), createdAt = 1.0,
        tasks = tasks,
    )
}
