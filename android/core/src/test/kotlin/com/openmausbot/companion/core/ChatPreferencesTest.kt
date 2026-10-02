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
    fun statusNoticeIsNeverHiddenOrFolded() {
        // "Qwen hit a rate limit and is retrying" answers "is it stuck?"; it is not tool noise.
        val notice = activity("n").copy(tool = ToolActivity(name = "notice: Qwen is waiting on its model", ok = true))
        val messages = listOf(activity("a"), activity("b"), notice, activity("c"), activity("d"))
        assertEquals(listOf("n"), transcriptRows(messages, ActivityDetail.HIDDEN).map { it.id })
        val rows = transcriptRows(messages, ActivityDetail.REDUCED)
        assertEquals(3, rows.size)
        assertEquals("n", assertIs<TranscriptRow.Single>(rows[1]).id)
    }

    @Test
    fun hiddenDropsDigestAndCompactionReceiptsToo() {
        val messages = listOf(text("a"), activity("b"), digest("c"), text("d"), compaction("e"))
        assertEquals(listOf("a", "d"), transcriptRows(messages, ActivityDetail.HIDDEN).map { it.id })
    }

    @Test
    fun theDigestIsItsOwnRowAndNeverAStep() {
        val messages = listOf(activity("a"), activity("b"), digest("c"), text("d"))
        val reduced = transcriptRows(messages, ActivityDetail.REDUCED)
        assertEquals(listOf("run.a", "c", "d"), reduced.map { it.id })
        assertEquals(2, (reduced[0] as TranscriptRow.ActivityRun).items.size)
        assertEquals(Message.Kind.DIGEST, reduced[1].kind)
        assertEquals(listOf("a", "b", "c", "d"), transcriptRows(messages, ActivityDetail.FULL).map { it.id })
    }

    @Test
    fun theRosterPreviewReadsPastTheDigestToTheReply() {
        val messages = listOf(text("a"), digest("b"))
        assertEquals("hello", rosterPreview(messages, ActivityDetail.FULL))
        assertEquals("hello", rosterPreview(messages, ActivityDetail.REDUCED))
    }

    @Test
    fun quietTurnsDoNotLeaveAnEmptyDigestRowAtAnyActivityLevel() {
        val quiet = digest("quiet").copy(text = "[digest] · no tool activity observed in this turn · files: none changed · reply: hello")
        for (detail in ActivityDetail.entries) {
            assertEquals(listOf("answer"), transcriptRows(listOf(text("answer"), quiet), detail).map { it.id })
        }
        val changed = quiet.copy(text = "[digest] · no tool calls · files: changed notes.txt")
        assertEquals(listOf("answer", "quiet"), transcriptRows(listOf(text("answer"), changed), ActivityDetail.REDUCED).map { it.id })
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
