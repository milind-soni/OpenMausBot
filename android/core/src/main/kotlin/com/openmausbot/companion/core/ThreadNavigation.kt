package com.openmausbot.companion.core

/** A saved folder's visible threads, or the unfiled threads after the folders. */
data class BotThreadGroup(val project: BotProject?, val tasks: List<BotTask>) {
    val id: String get() = project?.let { "project:${it.id}" } ?: "unfiled"
}

val BotTask.displayTitle: String
    get() = title.trim().ifEmpty { "Untitled thread" }

val BotTask.demandsAttention: Boolean
    get() = busy == true || unread == true || activity in setOf(
        "waiting-on-you", "waiting", "working", "running", "queued",
    )

/** Routine results are ordinary threads; only their internal per-run executions are hidden. */
val Bot.visibleTasks: List<BotTask>
    get() = tasks.orEmpty().filter { it.routineRunId == null }

/**
 * Preserve saved folder order and server thread order. A missing folder leaves
 * its threads unfiled. Search includes closed threads and matches folder names.
 */
fun Bot.threadGroups(matching: String = "", includingClosed: Boolean = false): List<BotThreadGroup> {
    val search = matching.trim()
    val threads = when {
        tasks == null -> listOf(BotTask(
            threadId = threadId, title = "", createdAt = createdAt,
            modelSelection = modelSelection, busy = busy, activity = activity, unread = unread,
            approvalMode = approvalMode, autoApprove = autoApprove, alwaysAllow = alwaysAllow,
        ))
        includingClosed || search.isNotEmpty() -> visibleTasks
        else -> visibleTasks.filter { !it.isClosed || it.demandsAttention || it.threadId == threadId }
    }
    val projectIds = mutableSetOf<String>()
    val groups = buildList {
        projects.orEmpty().forEach { project ->
            if (projectIds.add(project.id)) {
                val filed = threads.filter { it.projectId == project.id }
                if (filed.isNotEmpty()) add(BotThreadGroup(project, filed))
            }
        }
        val unfiled = threads.filter { it.projectId !in projectIds }
        if (unfiled.isNotEmpty()) add(BotThreadGroup(null, unfiled))
    }
    if (search.isEmpty()) return groups
    return groups.mapNotNull { group ->
        if (group.project?.name?.contains(search, ignoreCase = true) == true) group
        else group.tasks.filter { it.displayTitle.contains(search, ignoreCase = true) }
            .takeIf { it.isNotEmpty() }?.let { BotThreadGroup(group.project, it) }
    }
}
