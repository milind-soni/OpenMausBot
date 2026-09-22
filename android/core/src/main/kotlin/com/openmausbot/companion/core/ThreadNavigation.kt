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

/** Running, needing the person, unread, or holding a queued send — client
 * state passed in, because the harness reports queues out-of-band, never as
 * task activity. */
fun BotTask.demandsAttention(queued: Boolean = false): Boolean =
    // The activity set is the BotActivity wire contract (working,
    // waiting-on-you, waiting, idle, no-signal, dead) plus the queued wait;
    // work states arrive through isWorking.
    isWaitingOnTeammate || isWorking || busy == true || unread == true || queued ||
        activity in setOf("waiting-on-you", "waiting", "queued")

/**
 * Attention outranks recency within a bot: waiting-on-you needs the person
 * most, then working/busy, then queued, then unread. A held send is client
 * state, so it ranks in the queued tier the way the wire value does. The
 * thread being looked at rides just above the idle tail; idle threads keep
 * stored order. Mirrors the desktop's orderedSidebarThreads so the tree, the
 * sheet, and the pickers agree on one order.
 */
fun attentionRank(task: BotTask, activeThreadId: String, queued: Boolean = false): Int = when {
    task.activity == "waiting-on-you" -> 0
    task.busy == true || task.activity == "working" -> 1
    task.activity == "queued" || queued -> 2
    task.unread == true -> 3
    task.threadId == activeThreadId -> 4
    else -> 5
}

/** Pin, then newest update. Equal stamps keep the caller's order. Attention
 * does not move a row — [orderedThreads] still does, for activity surfaces. */
fun listedThreads(tasks: List<BotTask>): List<BotTask> =
    tasks.withIndex().sortedWith(
        compareByDescending<IndexedValue<BotTask>> { it.value.pinned == true }
            .thenByDescending { it.value.listStamp }
            .thenBy { it.index },
    ).map { it.value }

/** Order, never filter: whatever the caller passes stays visible, only the
 * position changes. Sorting is stable, so equal ranks keep stored order. */
fun orderedThreads(
    tasks: List<BotTask>,
    activeThreadId: String,
    queuedThreadIds: Set<String> = emptySet(),
): List<BotTask> =
    tasks.sortedBy { attentionRank(it, activeThreadId, queued = it.threadId in queuedThreadIds) }

/** Routine results are ordinary threads; only their internal per-run executions are hidden. */
val Bot.visibleTasks: List<BotTask>
    get() = tasks.orEmpty().filter { it.routineRunId == null }

/**
 * Preserve saved folder order; attention floats threads within each group.
 * A missing folder leaves its threads unfiled. Search includes closed threads
 * and matches folder names, and keeps relevance (stored) order.
 */
fun Bot.threadGroups(
    matching: String = "",
    includingClosed: Boolean = false,
    /** Threads holding a queued send. A closed thread with a held send stays
     * in the list the way a running one does (Sidebar.tsx 865). */
    queuedThreadIds: Set<String> = emptySet(),
): List<BotThreadGroup> {
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
        // that starts working, waits on the person, turns unread, or is
        // holding a queued send is back.
        else -> visibleTasks.filter {
            it.pinned == true ||
                (!it.isClosed && !it.isArchived) ||
                it.demandsAttention(queued = queuedThreadIds.contains(it.threadId)) ||
                it.threadId == threadId
        }
    }
    val ordered = listedThreads(threads)
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
