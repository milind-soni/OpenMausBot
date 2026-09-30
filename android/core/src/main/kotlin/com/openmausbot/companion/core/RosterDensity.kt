package com.openmausbot.companion.core

/**
 * How much each row on the home list says, and what a compact row shows. The
 * rules mirror the iPhone companion's compact list.
 *
 * The phone follows the desktop sidebar's density setting
 * (`src/lib/sidebar-preferences.ts`) without its avatars-only mode, which a
 * phone has no room to need. Comfortable is the original two-line row with a
 * "Threads" disclosure beneath every bot, and it keeps the logic it shipped
 * with in its own composables; compact is one line per bot, status as small
 * marks, and a thread list only where there is one to open.
 *
 * The compact decisions live here, away from Compose, so they can be tested
 * without a screen.
 */
enum class RosterDensity(val wireValue: String, val label: String, val caption: String) {
    COMFORTABLE(
        "comfortable",
        "Comfortable",
        "Larger faces, with each bot's latest message under its name.",
    ),
    COMPACT(
        "compact",
        "Compact",
        "One line per bot. Bots with more than one active thread show how many; tap the number to list them.",
    ),
    ;

    companion object {
        /** What a new install shows. */
        val DEFAULT: RosterDensity = COMPACT

        /**
         * A stored choice, read defensively: anything this build cannot read —
         * a typo, a later build's choice — lands on the default rather than a
         * surprise.
         */
        fun fromWire(value: String?): RosterDensity =
            entries.firstOrNull { it.wireValue == value } ?: DEFAULT
    }
}

/** The one live signal a bot's row carries, most urgent first — the desktop row's order. */
enum class RosterRowStatus {
    /** Nothing is happening: the row shows when the bot last spoke. */
    IDLE,

    /** A thread is mid-turn. */
    WORKING,

    /**
     * The bot stopped for the person. Outranks work: the harness counts a wait
     * on the person as busy, and the person is who the row is for.
     */
    WAITING_ON_YOU,
}

/**
 * The threads the home list would show for this bot when it is opened: the
 * same fold as the thread tree, so the count never disagrees with the list it
 * opens. Routine runs and put-away threads stay out.
 */
fun Bot.rosterThreadCount(
    queuedThreadIds: Set<String> = emptySet(),
    now: Long = System.currentTimeMillis(),
): Int = threadGroups(now = now, queuedThreadIds = queuedThreadIds).sumOf { it.tasks.size }

/**
 * Read from every visible thread, not just the one open on the desktop, so a
 * bot working in the background still shows it.
 *
 * The bot's own `activity` belongs to its current thread: it stands in when
 * that thread's task carries none, as it does when the chat opens
 * ([Bot.forTask]), and an older computer's bot without a task list is its own
 * one thread, as in the tree.
 *
 * @param hasPendingCard an unanswered approval or question sits in one of
 * this bot's threads. Cards live in transcripts, which the bot record does
 * not carry.
 */
fun Bot.rosterStatus(hasPendingCard: Boolean): RosterRowStatus {
    val threads = if (tasks == null) {
        listOf(legacyTask)
    } else {
        visibleTasks.map { task ->
            if (task.threadId == threadId && task.activity == null) task.copy(activity = activity) else task
        }
    }
    if (hasPendingCard || threads.any { it.activity == "waiting-on-you" }) {
        return RosterRowStatus.WAITING_ON_YOU
    }
    // A teammate wait is painted busy on the wire; the flag alone decides
    // that it is a quiet wait, never the work spinner.
    val botWorks = busy == true && waitingOnTeammate != true
    if (botWorks || threads.any { it.isWorking && !it.isWaitingOnTeammate }) {
        return RosterRowStatus.WORKING
    }
    return RosterRowStatus.IDLE
}

/**
 * Whether an opened thread list gives its unfiled threads a quiet "Threads"
 * label: only when a folder header sits above them, or they would read as that
 * folder's threads (the desktop's `task.list` label does the same).
 */
fun labelsUnfiledThreads(groups: List<BotThreadGroup>): Boolean =
    groups.any { it.project != null } && groups.any { it.project == null }

/** Everything one compact bot row decides, as data. */
data class RosterBotRow(
    val status: RosterRowStatus,
    /** Threads behind the "› N" control. */
    val threadCount: Int,
    val isChief: Boolean,
    val unread: Boolean,
    /** The bot's own busy flag — the one the comfortable row's dot has always read. */
    val busy: Boolean,
) {
    constructor(
        bot: Bot,
        hasPendingCard: Boolean,
        queuedThreadIds: Set<String> = emptySet(),
        now: Long = System.currentTimeMillis(),
    ) : this(
        status = bot.rosterStatus(hasPendingCard),
        threadCount = bot.rosterThreadCount(queuedThreadIds, now),
        isChief = bot.chiefOfStaff == true,
        unread = bot.unread,
        busy = bot.busy == true,
    )

    /**
     * The "› N" control only for a bot with a list to open. One thread is the
     * bot itself: tapping the row already opens it.
     */
    val showsThreadControl: Boolean get() = threadCount >= 2

    /** The Chief of Staff crown after the name. */
    val showsChiefBadge: Boolean get() = isChief

    /** The spinner stands where the time was. */
    val showsTime: Boolean get() = status != RosterRowStatus.WORKING

    val showsSpinner: Boolean get() = status == RosterRowStatus.WORKING

    val showsWaiting: Boolean get() = status == RosterRowStatus.WAITING_ON_YOU

    /** The dot as it has always been: unread, and hidden while the bot itself is busy. */
    val showsUnreadDot: Boolean get() = unread && !busy

    /**
     * Whether the bot's threads are listed beneath its row. A search lists
     * what matched under every bot, as the desktop does; otherwise only a bot
     * the person opened with its "› N" control.
     */
    fun listsThreads(expanded: Boolean, searching: Boolean): Boolean =
        searching || (expanded && showsThreadControl)

    /**
     * An opened list ends with "+ New thread". Search results are not a place
     * to create one.
     */
    fun endsWithNewThread(expanded: Boolean, searching: Boolean): Boolean =
        !searching && expanded && showsThreadControl

    /**
     * An opened list whose control has gone — its threads closed or deleted
     * down to one — is dropped, so that a later second thread does not reopen
     * it by itself.
     */
    fun dropsExpansion(expanded: Boolean): Boolean = expanded && !showsThreadControl
}
