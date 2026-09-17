package com.openmausbot.companion.core

/** A saved folder's visible threads, or the unfiled threads after the folders. */
data class BotThreadGroup(val project: BotProject?, val tasks: List<BotTask>) {
    val id: String get() = project?.let { "project:${it.id}" } ?: "unfiled"
}

val BotTask.displayTitle: String
    get() = title.trim().ifEmpty { "Untitled thread" }

/** The thread's own turn is running — the desktop's isWorking exactly.
 * A run counts as work here exactly as its row labels it Working. */
val BotTask.isWorking: Boolean
    get() = activity == "working" || activity == "running" || busy == true

/** Waiting on a dispatched teammate (#1223). The live #1228 wire paints busy
 * and working during a coordination wait, so the flag outranks the painted
 * work: the row shows the wait, never the work spinner. */
val BotTask.isWaitingOnTeammate: Boolean
    get() = waitingOnTeammate == true

val BotTask.demandsAttention: Boolean
    // The activity set is the BotActivity wire contract (working,
    // waiting-on-you, waiting, idle, no-signal, dead) plus the queued wait;
    // work states arrive through isWorking.
    get() = isWaitingOnTeammate || isWorking || busy == true || unread == true || activity in setOf(
        "waiting-on-you", "waiting", "queued",
    )

/**
 * Attention outranks recency within a bot: waiting-on-you needs the person
 * most, then working/busy, then queued, then unread. The thread being looked
 * at rides just above the idle tail; idle threads keep stored order. Mirrors
 * the desktop's orderedSidebarThreads so the tree, the sheet, and the pickers
 * agree on one order.
 */
fun attentionRank(task: BotTask, activeThreadId: String): Int = when {
    task.activity == "waiting-on-you" -> 0
    task.busy == true || task.activity == "working" -> 1
    task.activity == "queued" -> 2
    task.unread == true -> 3
    task.threadId == activeThreadId -> 4
    else -> 5
}

/** Order, never filter: whatever the caller passes stays visible, only the
 * position changes. Sorting is stable, so equal ranks keep stored order. */
fun orderedThreads(tasks: List<BotTask>, activeThreadId: String): List<BotTask> =
    tasks.sortedBy { attentionRank(it, activeThreadId) }

/** Routine results are ordinary threads; only their internal per-run executions are hidden. */
val Bot.visibleTasks: List<BotTask>
    get() = tasks.orEmpty().filter { it.routineRunId == null }

/**
 * Preserve saved folder order; attention floats threads within each group.
 * A missing folder leaves its threads unfiled. Search includes closed threads
 * and matches folder names, and keeps relevance (stored) order.
 */
fun Bot.threadGroups(matching: String = "", includingClosed: Boolean = false): List<BotThreadGroup> {
    val search = matching.trim()
    val threads = when {
        tasks == null -> listOf(BotTask(
            threadId = threadId, title = "", createdAt = createdAt,
            modelSelection = modelSelection, busy = busy, activity = activity, unread = unread,
            waitingOnTeammate = waitingOnTeammate,
            approvalMode = approvalMode, autoApprove = autoApprove, alwaysAllow = alwaysAllow,
        ))
        includingClosed || search.isNotEmpty() -> visibleTasks
        // Closed and archived threads fold away with the same override: one
        // that starts working, waits on the person, or turns unread is back.
        else -> visibleTasks.filter {
            (!it.isClosed && !it.isArchived) || it.demandsAttention || it.threadId == threadId
        }
    }
    val ordered = if (search.isEmpty()) orderedThreads(threads, threadId) else threads
    val projectIds = mutableSetOf<String>()
    val groups = buildList {
        projects.orEmpty().forEach { project ->
            if (projectIds.add(project.id)) {
                val filed = ordered.filter { it.projectId == project.id }
                if (filed.isNotEmpty()) add(BotThreadGroup(project, filed))
            }
        }
        val unfiled = ordered.filter { it.projectId !in projectIds }
        if (unfiled.isNotEmpty()) add(BotThreadGroup(null, unfiled))
    }
    if (search.isEmpty()) return groups
    return groups.mapNotNull { group ->
        if (group.project?.name?.contains(search, ignoreCase = true) == true) group
        else group.tasks.filter { it.displayTitle.contains(search, ignoreCase = true) }
            .takeIf { it.isNotEmpty() }?.let { BotThreadGroup(group.project, it) }
    }
}
