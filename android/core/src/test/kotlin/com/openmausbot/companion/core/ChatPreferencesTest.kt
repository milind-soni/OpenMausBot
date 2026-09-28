package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ChatPreferencesTest {
    private fun text(id: String, at: Double = 1.0): Message = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.TEXT,
        at = at,
        text = "hello",
    )

    private fun activity(id: String, at: Double = 1.0, ok: Boolean? = true): Message = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.ACTIVITY,
        at = at,
        tool = ToolActivity(name = "run", ok = ok),
    )

    private fun digest(id: String, at: Double = 1.0): Message = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.DIGEST,
        at = at,
        text = "[digest] Bash ×2",
    )

    private fun compaction(id: String, at: Double = 1.0): Message = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.COMPACTION,
        at = at,
        text = "[compaction] summary",
        compaction = Compaction(summary = "summary", tokensBefore = 10),
    )

    // The digest and compaction receipts are the harness talking about the
    // tool calls: hidden with them, but never folded into a run of them.

    @Test
    fun hiddenDropsDigestAndCompactionReceiptsToo() {
        val messages = listOf(text("a"), activity("b"), digest("c"), text("d"), compaction("e"))
        assertEquals(listOf("a", "d"), transcriptRows(messages, ActivityDetail.HIDDEN).map { it.id })
    }

    @Test
    fun reducedKeepsACompactionAsItsOwnRowAndBreaksTheRun() {
        val messages = listOf(activity("a"), activity("b"), compaction("c"), activity("d"), activity("e"))
        val rows = transcriptRows(messages, ActivityDetail.REDUCED)
        assertEquals(listOf("run.a", "c", "run.d"), rows.map { it.id })
        assertEquals(Message.Kind.COMPACTION, rows[1].kind)
    }

    @Test
    fun fullKeepsEveryMessageAndHiddenDropsEveryActivity() {
        val messages = listOf(text("a"), activity("b"), activity("c", ok = false), text("d"))
        assertEquals(listOf("a", "b", "c", "d"), transcriptRows(messages, ActivityDetail.FULL).map { it.id })
        assertEquals(listOf("a", "d"), transcriptRows(messages, ActivityDetail.HIDDEN).map { it.id })
    }

    @Test
    fun reducedFoldsRunsButNeverFoldsFailuresOrSingleSteps() {
        val rows = transcriptRows(
            listOf(
                activity("a", at = 100.0),
                activity("b", at = 200.0),
                activity("failed", at = 300.0, ok = false),
                activity("single", at = 400.0),
                text("tail", at = 500.0),
            ),
            ActivityDetail.REDUCED,
        )

        val run = assertIs<TranscriptRow.ActivityRun>(rows[0])
        assertEquals(listOf("a", "b"), run.items.map(Message::id))
        assertEquals(100.0, run.at)
        assertEquals(200.0, run.endAt)
        assertFalse(run.running)
        assertEquals(listOf("run.a", "failed", "single", "tail"), rows.map { it.id })
        assertIs<TranscriptRow.Single>(rows[1])
        assertIs<TranscriptRow.Single>(rows[2])
    }

    @Test
    fun reducedRunReportsRunningWhenAReceiptHasNoVerdict() {
        val row = transcriptRows(
            listOf(activity("a"), activity("b", ok = null)),
            ActivityDetail.REDUCED,
        ).single()
        assertTrue(assertIs<TranscriptRow.ActivityRun>(row).running)
    }

    @Test
    fun quickRepliesRoundTripAndDistinguishEmptyListFromEmptyStore() {
        val mine = listOf(
            QuickReply(title = "Deploy", prompt = "Deploy to staging", icon = "send"),
            QuickReply(title = "Logs", prompt = "Show logs", icon = "document"),
        )
        assertEquals(mine, QuickReply.decode(QuickReply.encode(mine)))
        assertEquals(QuickReply.DEFAULTS, QuickReply.decode(""))
        assertEquals(QuickReply.DEFAULTS, QuickReply.decode("{not json"))
        assertEquals(emptyList(), QuickReply.decode(QuickReply.encode(emptyList())))
    }

    @Test
    fun invalidQuickReplyIdsFallBackToDefaults() {
        assertEquals(
            QuickReply.DEFAULTS,
            QuickReply.decode(QuickReply.encode(listOf(QuickReply(id = " ", title = "A", prompt = "A", icon = "next")))),
        )
        assertEquals(
            QuickReply.DEFAULTS,
            QuickReply.decode(
                QuickReply.encode(
                    listOf(
                        QuickReply(id = "same", title = "A", prompt = "A", icon = "next"),
                        QuickReply(id = "same", title = "B", prompt = "B", icon = "next"),
                    ),
                ),
            ),
        )
    }

    @Test
    fun unknownActivityDetailUsesIosDefault() {
        assertEquals(ActivityDetail.FULL, ActivityDetail.fromWire("unknown"))
    }
}
