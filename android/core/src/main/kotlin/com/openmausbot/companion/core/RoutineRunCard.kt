package com.openmausbot.companion.core

import kotlinx.serialization.Serializable

/**
 * One background routine run, as the computer upserts it into the thread that
 * created the routine (`kind == "routine.run"`). The same message id is
 * patched as the run moves, so the card always reads the latest state. Port of
 * `RoutineRunCardData` in `shared/routine-run.ts`.
 *
 * Every field defaults: a newer computer may drop or rename one, and a card
 * that half-decodes is still better than a message list that fails to.
 * [status] and [goalStatus] stay strings for the same reason — an unknown
 * state is shown as the computer spelled it.
 */
@Serializable
data class RoutineRunCard(
    val runId: String = "",
    val routineId: String = "",
    val routineName: String = "",
    val scheduledFor: Double? = null,
    val status: String = "",
    /** A queued run held because its target bot or room is busy. */
    val deferredAt: Double? = null,
    /** The exact team-goal outcome when the run targeted a room. */
    val goalStatus: String? = null,
    /** The run's own isolated thread, which the thread lists never show. */
    val executionThreadId: String? = null,
    /** The run's real output, up to 2000 characters. */
    val summary: String? = null,
    val error: String? = null,
) {
    /**
     * The words after the routine's name. The goal outcome is the more exact
     * fact, so it wins; `completed` and `paused` goals say nothing the status
     * does not. Port of `routineRunFallbackText` in `server/index.ts`.
     */
    val stateWording: String
        get() = when (goalStatus) {
            "needs-input" -> "needs your input"
            "blocked" -> "was blocked"
            "limit-reached" -> "reached its limit"
            "stopped" -> "was stopped"
            "failed" -> "failed"
            else -> when {
                status == "waiting" -> "needs your attention"
                status == "completed" -> "completed"
                status == "failed" -> "failed"
                status == "cancelled" -> "was cancelled"
                status == "missed" -> "was missed"
                status == "queued" && deferredAt != null -> "deferred: target busy"
                status.isBlank() -> "updated"
                else -> status
            }
        }

    val tone: RoutineRunTone
        get() = when {
            goalStatus in setOf("blocked", "failed") || status in setOf("failed", "missed") -> RoutineRunTone.ERROR
            goalStatus in setOf("needs-input", "limit-reached", "paused") || status == "waiting" ||
                (status == "queued" && deferredAt != null) -> RoutineRunTone.ATTENTION
            goalStatus == null && status == "running" -> RoutineRunTone.ACTIVE
            else -> RoutineRunTone.NEUTRAL
        }

    /** The same sentence the computer writes into the message's `text`. */
    val headline: String
        get() = "Routine “$routineName” $stateWording"

    /** The first line of the report with anything to say, if there is one. */
    val firstSummaryLine: String?
        get() = summary?.lineSequence()?.map { it.trim() }?.firstOrNull { it.isNotEmpty() }

    /** What a roster row or an update line says about the run. */
    val preview: String
        get() = firstSummaryLine?.let { "$headline: $it" } ?: headline

    /** A person is asked to look, so the button says so. */
    val openLabel: String
        get() = if (goalStatus == "needs-input") "Review" else "Open run"
}

enum class RoutineRunTone { NEUTRAL, ACTIVE, ATTENTION, ERROR }

/** A routine-run message reads as its card; one without a card, as its text. */
val Message.routineRunPreview: String
    get() = routineRun?.preview ?: text.orEmpty()

/**
 * Where "Open run" goes: the execution thread on whichever bot holds it. The
 * lookup reads every task, including the run threads [visibleTasks] leaves out
 * of the lists, so opening one never needs it listed. Null — no button — when
 * the phone does not know the thread, the way desktop offers navigation only
 * while the execution task still exists.
 */
fun CompanionState.routineExecutionRef(card: RoutineRunCard): ThreadRef? {
    val threadId = card.executionThreadId?.takeIf { it.isNotEmpty() } ?: return null
    val bot = bots.firstOrNull { bot ->
        bot.threadId == threadId || bot.tasks.orEmpty().any { it.threadId == threadId }
    } ?: return null
    return ThreadRef(botId = bot.id, threadId = threadId, title = card.routineName)
}
