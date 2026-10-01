package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The routine-run message the computer upserts into a routine's source thread.
 * Reported from the phones: all a run ever showed was "Routine “X” completed",
 * because the kind decoded as unknown and the card with the real output was
 * dropped on the floor.
 */
class RoutineRunCardTest {
    private fun decode(json: String): Message = CompanionJson.decodeFromString(json)

    @Test
    fun decodesARunWithItsCard() {
        val message = decode(
            """{"id":"m1","role":"bot","kind":"routine.run","at":1,"text":"Routine “Brief” completed",
               "routineRun":{"runId":"r1","routineId":"x","routineName":"Brief","status":"completed",
               "executionThreadId":"t-run","summary":"Three new issues.\nAll triaged.","newerField":1}}""",
        )
        assertEquals(Message.Kind.ROUTINE_RUN, message.kind)
        val run = assertNotNull(message.routineRun)
        assertEquals("t-run", run.executionThreadId)
        assertEquals("Routine “Brief” completed: Three new issues.", previewText(message))
    }

    @Test
    fun aRunWithoutItsCardFallsBackToTheText() {
        val message = decode("""{"id":"m1","role":"bot","kind":"routine.run","at":1,"text":"Routine “Brief” failed"}""")
        assertEquals(Message.Kind.ROUTINE_RUN, message.kind)
        assertNull(message.routineRun)
        assertEquals("Routine “Brief” failed", previewText(message))
    }

    @Test
    fun anUnknownStatusIsShownAsSpelled() {
        val message = decode(
            """{"id":"m1","role":"bot","kind":"routine.run","at":1,
               "routineRun":{"runId":"r1","routineName":"Brief","status":"rehearsing"}}""",
        )
        assertEquals("Routine “Brief” rehearsing", message.routineRun?.headline)
        assertEquals(RoutineRunTone.NEUTRAL, message.routineRun?.tone)
    }

    @Test
    fun reEncodesTheKindTheWayTheComputerSpellsIt() {
        val message = Message("m", Message.Role.BOT, Message.Kind.ROUTINE_RUN, 1.0)
        val round = decode(CompanionJson.encodeToString(Message.serializer(), message))
        assertEquals(Message.Kind.ROUTINE_RUN, round.kind)
    }

    // Not a routine run, but the same report problem: a teammate's finished
    // reply rides on its activity chip as `tool.output`.
    @Test
    fun aTeammateReplyChipCarriesItsReport() {
        val message = decode(
            """{"id":"m2","role":"bot","kind":"activity","at":2,
               "tool":{"name":"Engineering lead replied","ok":true,"output":"Shipped the fix.\nTests green."},
               "roomRequest":{"phase":"result"},
               "threadRef":{"botId":"eng","threadId":"t9","title":"Fix login"}}""",
        )
        assertEquals("Shipped the fix.\nTests green.", message.tool?.output)
        assertEquals("t9", message.threadRef?.threadId)
        // The preview stays the chip's name, never the report.
        assertEquals("Engineering lead replied", previewText(message))
        assertNull(decode("""{"id":"m3","role":"bot","kind":"activity","at":3,"tool":{"name":"shell"}}""").tool?.output)
    }

    @Test
    fun wordingPutsTheGoalOutcomeFirst() {
        fun wording(status: String, goal: String? = null, deferred: Double? = null) =
            RoutineRunCard(routineName = "R", status = status, goalStatus = goal, deferredAt = deferred).stateWording
        assertEquals("completed", wording("completed"))
        assertEquals("failed", wording("failed"))
        assertEquals("needs your attention", wording("waiting"))
        assertEquals("was cancelled", wording("cancelled"))
        assertEquals("was missed", wording("missed"))
        assertEquals("deferred: target busy", wording("queued", deferred = 5.0))
        assertEquals("queued", wording("queued"))
        assertEquals("running", wording("running"))
        assertEquals("needs your input", wording("completed", goal = "needs-input"))
        assertEquals("was blocked", wording("completed", goal = "blocked"))
        assertEquals("reached its limit", wording("completed", goal = "limit-reached"))
        assertEquals("completed", wording("completed", goal = "completed"))
    }

    @Test
    fun theReportLineSkipsBlankLines() {
        val run = RoutineRunCard(routineName = "R", status = "completed", summary = "\n\n  Done it.  \nMore")
        assertEquals("Routine “R” completed: Done it.", run.preview)
    }

    @Test
    fun openRunFindsTheHiddenExecutionThreadOnAnyBot() {
        val scout = Bot(
            id = "scout", threadId = "main", name = "Scout", title = "", description = "",
            notifications = true, color = "green", unread = false,
            modelSelection = ModelSelection("i", "m"), createdAt = 0.0,
            tasks = listOf(
                BotTask(threadId = "main", title = "", createdAt = 0.0),
                BotTask(threadId = "t-run", title = "Brief", createdAt = 1.0, routineRunId = "r1"),
            ),
        )
        val state = CompanionState(bots = listOf(scout))
        val card = RoutineRunCard(routineName = "Brief", status = "completed", executionThreadId = "t-run")
        assertEquals(ThreadRef("scout", "t-run", "Brief"), state.routineExecutionRef(card))
        // Still out of the lists: opening it never meant listing it.
        assertEquals(listOf("main"), scout.visibleTasks.map { it.threadId })
        assertNull(state.routineExecutionRef(card.copy(executionThreadId = "gone")))
        assertNull(state.routineExecutionRef(card.copy(executionThreadId = null)))
    }
}
