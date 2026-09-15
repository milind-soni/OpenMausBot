package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.QueuedSend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The Needs attention section: the cross-bot rules of SidebarBotActivity. */
class AttentionInboxTest {
    private fun task(id: String, activity: String? = null, busy: Boolean? = null, unread: Boolean? = null, routineRunId: String? = null) =
        BotTask(id, id, 0.0, activity = activity, busy = busy, unread = unread, routineRunId = routineRunId)

    private fun bot(
        id: String,
        tasks: List<BotTask>?,
        name: String = id.replaceFirstChar { it.uppercase() },
        hidden: Boolean = false,
        busy: Boolean? = null,
        activity: String? = null,
        unread: Boolean = false,
    ) = Bot(
        id, "$id-t", name, "Role", "", true, "blue", unread,
        ModelSelection("default", "default"), 0.0,
        hidden = hidden, busy = busy, activity = activity, tasks = tasks,
    )

    @Test
    fun idleQuietThreadsNeverEnter() {
        val state = CompanionState(bots = listOf(bot("scout", listOf(task("a"), task("b", busy = false)))))
        assertTrue(state.crossBotAttention().isEmpty())
    }

    @Test
    fun hiddenBotsAndTheExcludedBotStayOut() {
        val state = CompanionState(bots = listOf(
            bot("hidden", listOf(task("a", unread = true)), hidden = true),
            bot("here", listOf(task("b", unread = true))),
            bot("away", listOf(task("c", unread = true))),
        ))
        val entries = state.crossBotAttention(exceptBotId = "here")
        assertEquals(listOf("away-c"), entries.map { "${it.botId}-${it.task.threadId}" })
    }

    @Test
    fun theWholeFleetOrdersTogetherSoNoUnreadOutranksAWait() {
        // Flatten first, then order once: Scout's unread reply must not
        // outrank Pepper's waiting approval just because Scout is earlier.
        val state = CompanionState(bots = listOf(
            bot("scout", listOf(task("scout-read", unread = true), task("scout-wait", activity = "waiting-on-you"))),
            bot("pepper", listOf(task("pepper-wait", activity = "waiting-on-you"))),
        ))
        assertEquals(
            listOf("scout-wait", "pepper-wait", "scout-read"),
            state.crossBotAttention().map { it.task.threadId },
        )
    }

    @Test
    fun routineRunsStayOutButALegacyBotAggregateStillCounts() {
        val state = CompanionState(bots = listOf(
            bot("modern", listOf(task("internal", busy = true, routineRunId = "run-1"), task("idle"))),
            bot("legacy", null as List<BotTask>?, busy = true),
        ))
        assertEquals(listOf("legacy-t"), state.crossBotAttention().map { it.task.threadId })
    }

    @Test
    fun aQueuedSendIsAttentionAndNamesItsStatus() {
        val state = CompanionState(
            bots = listOf(bot("scout", listOf(task("drafting")))),
            pendingQueued = mapOf("drafting" to listOf(QueuedSend("q1", "and add tests"))),
        )
        val entry = state.crossBotAttention().single()
        assertTrue(entry.queued)
        assertEquals("Queued", entry.statusLine())
    }

    @Test
    fun statusWordsFollowTheAttentionOrder() {
        assertEquals("Waiting on you", AttentionEntry("b", "Bot", task("w", activity = "waiting-on-you"), false).statusLine())
        assertEquals("Working", AttentionEntry("b", "Bot", task("w", busy = true), false).statusLine())
        assertEquals("Working", AttentionEntry("b", "Bot", task("w", activity = "working"), false).statusLine())
        assertEquals("Unread", AttentionEntry("b", "Bot", task("w", unread = true), false).statusLine())
    }
}
