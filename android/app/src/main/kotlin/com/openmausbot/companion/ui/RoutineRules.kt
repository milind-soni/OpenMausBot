package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Routine
import com.openmausbot.companion.core.RoutineInput
import com.openmausbot.companion.core.RoutineRun
import com.openmausbot.companion.core.RoutineRunAvailability
import com.openmausbot.companion.core.RoutineRunLocation
import com.openmausbot.companion.core.RoutineSchedule
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale

/**
 * Tasks & Routines, as rules — the decision half of
 * `ios/App/TasksRoutinesView.swift`.
 *
 * A task is one conversation and result; a routine runs with fresh context and
 * collects results in one thread. No cron syntax reaches the phone, and the two
 * operations not on the paired allowlist — webhook management, and cancel/seen on a run —
 * have no representation here at all.
 */
object RoutineRules {
    /** `String(name.trimming….prefix(80))` in `RoutineEditorView.save`. */
    const val NAME_LIMIT: Int = 80

    /** `String(prompt.trimming….prefix(20_000))`. */
    const val PROMPT_LIMIT: Int = 20_000

    /** Kept on requests for compatibility with desktop builds that still require the field. */
    const val LEGACY_DURATION_MINUTES: Int = 30

    /** Optional execution guard. It is deliberately separate from cadence and calendar size. */
    val TIMEOUT_RANGE: IntRange = 5..240
    val TIMEOUT_OPTIONS: List<Int> = TIMEOUT_RANGE.step(5).toList()
    const val DEFAULT_INTERVAL_TIMEOUT: Int = 30

    val INTERVAL_RANGE: IntRange = 5..1_440
    val INTERVAL_PRESETS: List<Int> = listOf(5, 10, 15, 30, 60)
    const val DEFAULT_INTERVAL: Int = 15

    /** `.prefix(50)` on the sorted receipts. */
    const val RECEIPT_LIMIT: Int = 50

    /** Sunday-first, exactly as the wire's 0…6 weekdays are indexed. */
    val DAY_LETTERS: List<String> = listOf("S", "M", "T", "W", "T", "F", "S")
    val DAY_NAMES: List<String> = listOf(
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    )
    val DEFAULT_WEEKDAYS: Set<Int> = setOf(1, 2, 3, 4, 5)
    const val DEFAULT_TIME: String = "09:00"

    /** `Date().addingTimeInterval(3_600)` — the default one-time instant. */
    const val ONCE_DEFAULT_OFFSET_MILLIS: Long = 3_600_000L

    const val HEADER_TASK: String = "Thread = one conversation and result"
    const val HEADER_ROUTINE: String = "Routine = scheduled work with one results thread"

    const val HEADER_FOOTER: String =
        "No cron syntax. Every run uses the agent's existing model, tools, permissions, " +
            "computer, and connected apps. Times follow the paired computer's local timezone."

    const val NO_ROUTINES_TITLE: String = "No routines"
    const val NO_ROUTINES_DESCRIPTION: String = "Schedule recurring or one-time agent work."
    const val NO_RECEIPTS: String =
        "Completed, waiting, failed, and manually started runs appear here."

    const val WEBHOOKS_LABEL: String = "Computer only"
    const val WEBHOOKS_FOOTER: String =
        "Creating or rotating a webhook changes an internet-reachable trigger and signing " +
            "secret, so webhook management remains on the paired computer. Webhook run " +
            "receipts still appear above."

    const val DELETE_MESSAGE: String = "Past run receipts remain available."
    const val DELETED_AGENT: String = "Deleted agent"
    const val WAITING_ON_YOU: String = "This thread is waiting for your answer."
    const val UNSUPPORTED_SCHEDULE_ERROR: String =
        "Choose a supported schedule before saving this routine."

    const val SCHEDULE_FOOTER: String =
        "Each occurrence starts with fresh context. Results collect in one thread, " +
            "and full run logs remain available. No cron syntax is used."
    const val INTERVAL_SCHEDULE_FOOTER: String =
        "Each occurrence starts with fresh context. Results collect in one thread, " +
            "and full run logs remain available. If the previous run is still active, " +
            "the next occurrence is skipped instead of queued."
    const val UNKNOWN_SCHEDULE_NOTE: String =
        "This routine uses a schedule added by a newer OpenMausBot. Choose One time, " +
            "Selected days, or Every X minutes before saving."

    const val CHECKING_CLOUD: String = "Checking Cloud VM availability…"
    const val CLOUD_STATUS_UNAVAILABLE: String = "Cloud VM status is unavailable"

    const val MAUS_FOOTER: String =
        "Uses this agent's selected model and computer setting on the paired computer."
    const val CLOUD_READY_FOOTER: String =
        "Runs the agent and its tools inside its Box virtual machine. The VM wakes " +
            "automatically for each run; keep OpenMausBot running so its scheduler can " +
            "launch the job."
    const val CLOUD_BLOCKED_FOOTER: String =
        "This existing Cloud VM choice is preserved, but it cannot run until the paired " +
            "computer has a configured Box API key and an available Box agent."

    /** Soonest first; a routine with no next run sorts last. */
    fun sorted(routines: List<Routine>): List<Routine> =
        routines.sortedBy { it.nextRunAt ?: Double.MAX_VALUE }

    /** Newest scheduled instant first, and only the last [RECEIPT_LIMIT]. */
    fun receipts(runs: List<RoutineRun>): List<RoutineRun> =
        runs.sortedByDescending { it.scheduledFor }.take(RECEIPT_LIMIT)

    fun locationLabel(location: RoutineRunLocation): String = when (location) {
        RoutineRunLocation.MAUS -> "This computer"
        RoutineRunLocation.CLOUD -> "Cloud VM"
    }

    /**
     * The routine's one-line schedule.
     *
     * Two quirks are the Swift's and are mirrored rather than repaired: seven
     * weekdays read as "Every day" whatever the seven are, and only the exact
     * ordered list `[1,2,3,4,5]` reads as "Weekdays".
     */
    fun scheduleSummary(
        schedule: RoutineSchedule,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        when (schedule.type) {
            RoutineSchedule.Kind.ONCE -> {
                val at = schedule.at ?: return "One time · date unavailable"
                return RelativeStamp.dateAndTime(at, zone, locale)
            }
            RoutineSchedule.Kind.INTERVAL -> {
                val minutes = schedule.everyMinutes ?: return "Interval unavailable"
                val cadence = "Every $minutes min"
                val anchor = schedule.anchorAt ?: return cadence
                return "$cadence · starting ${RelativeStamp.dateAndTime(anchor.toDouble(), zone, locale)}"
            }
            RoutineSchedule.Kind.UNKNOWN -> return "Newer schedule"
            RoutineSchedule.Kind.DAILY -> Unit
        }
        val values = schedule.weekdays.orEmpty()
        val dayText = when {
            values.size == 7 -> "Every day"
            values == listOf(1, 2, 3, 4, 5) -> "Weekdays"
            else -> values.mapNotNull { DAY_NAMES.getOrNull(it)?.take(3) }.joinToString(", ")
        }
        return "$dayText at ${schedule.time ?: "—"}"
    }

    /** `"\(bot?.name ?? "Deleted agent") · \(schedule.summary) · \(runLocation.label)"`. */
    fun routineSubtitle(
        routine: Routine,
        botName: String?,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String = listOf(
        botName ?: DELETED_AGENT,
        scheduleSummary(routine.schedule, zone, locale),
        locationLabel(routine.runLocation),
    ).joinToString(" · ")

    fun runSubtitle(
        run: RoutineRun,
        botName: String?,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String = "${botName ?: DELETED_AGENT} · ${RelativeStamp.dateAndTime(run.scheduledFor, zone, locale)}"

    /** What a paused routine's trailing glyph means, or null while it is running. */
    fun pausedBadge(routine: Routine, atMillis: Double): PausedBadge? = when {
        routine.enabled -> null
        routine.canToggle(atMillis) -> PausedBadge.PAUSED
        else -> PausedBadge.COMPLETED
    }

    enum class PausedBadge(val label: String) { PAUSED("Paused"), COMPLETED("Completed") }

    enum class RunStatus { RUNNING, COMPLETED, WAITING, FAILED, CANCELLED, PENDING }

    /** `String.symbol` / `String.tint` in the Swift, as one decision. */
    fun runStatus(status: String): RunStatus = when (status) {
        "running" -> RunStatus.RUNNING
        "completed" -> RunStatus.COMPLETED
        "waiting" -> RunStatus.WAITING
        "failed", "missed" -> RunStatus.FAILED
        "cancelled" -> RunStatus.CANCELLED
        else -> RunStatus.PENDING
    }

    /** `run.status == "waiting" ? "Needs you" : run.status.capitalized`. */
    fun runStatusLabel(status: String): String {
        if (status == "waiting") return "Needs you"
        return status.split(' ').joinToString(" ") { word ->
            word.lowercase(Locale.ROOT).replaceFirstChar { it.titlecase(Locale.ROOT) }
        }
    }

    fun cloudSelectable(
        availability: RoutineRunAvailability?,
        current: RoutineRunLocation,
    ): Boolean = availability?.canSelect(RoutineRunLocation.CLOUD, current)
        ?: (current == RoutineRunLocation.CLOUD)

    fun locationFooter(
        runOn: RoutineRunLocation,
        availability: RoutineRunAvailability?,
    ): String = when {
        runOn == RoutineRunLocation.MAUS -> MAUS_FOOTER
        availability?.cloudReady == true -> CLOUD_READY_FOOTER
        else -> CLOUD_BLOCKED_FOOTER
    }

    fun canSave(
        saving: Boolean,
        kind: RoutineSchedule.Kind,
        name: String,
        prompt: String,
        botId: String,
        weekdays: Set<Int>,
        everyMinutes: Int? = null,
    ): Boolean = !saving &&
        kind != RoutineSchedule.Kind.UNKNOWN &&
        name.trim().isNotEmpty() &&
        prompt.trim().isNotEmpty() &&
        botId.isNotEmpty() &&
        !(kind == RoutineSchedule.Kind.DAILY && weekdays.isEmpty()) &&
        !(kind == RoutineSchedule.Kind.INTERVAL &&
            (everyMinutes == null || everyMinutes !in INTERVAL_RANGE))

    fun intervalMinutes(raw: String): Int? =
        raw.trim().toIntOrNull()?.takeIf { it in INTERVAL_RANGE }

    fun defaultIntervalAnchor(nowMillis: Long, everyMinutes: Int = DEFAULT_INTERVAL): Long =
        nowMillis + everyMinutes * 60_000L

    fun intervalTimeoutOnFirstSelection(current: Int?, defaultAlreadyApplied: Boolean): Int? =
        if (defaultAlreadyApplied) current else DEFAULT_INTERVAL_TIMEOUT

    fun validTimeout(minutes: Int?): Boolean = minutes == null || minutes in TIMEOUT_RANGE

    /** `"%02d:%02d"` — what `DateFormatter("HH:mm")` writes for a wall-clock time. */
    fun timeText(hour: Int, minute: Int): String =
        String.format(Locale.ROOT, "%02d:%02d", hour, minute)

    /**
     * The stored `"HH:mm"` as a picker value. A field the phone cannot read
     * falls back to the current time, which is what `date(bySettingHour:)`
     * returning nil does on iOS.
     */
    fun parseTime(raw: String?, now: LocalTime): LocalTime {
        val parts = (raw ?: DEFAULT_TIME).split(":").mapNotNull { it.toIntOrNull() }
        val hour = parts.firstOrNull() ?: 9
        val minute = if (parts.size > 1) parts[1] else 0
        if (hour !in 0..23 || minute !in 0..59) return now
        return LocalTime.of(hour, minute)
    }

    /**
     * Whether the instant a date and a wall-clock time would produce is inside
     * `DatePicker("Run", selection: $onceAt, in: Date()...)`.
     *
     * The Swift bounds the **instant**, not the day and not the hour-minute
     * pair, and it bounds only what can be *selected* — a value already bound to
     * the picker stays exactly as it is, which is why an already-fired routine
     * re-saves untouched.
     *
     * The comparison is therefore against the candidate instant: at 10:30:45,
     * 10:30 resolves to 10:30:00, which has passed, so the first minute the
     * picker can offer today is 10:31.
     */
    fun onceInstantSelectable(
        date: LocalDate,
        hour: Int,
        minute: Int,
        now: Instant,
        zone: ZoneId,
    ): Boolean = !date.atTime(hour, minute).atZone(zone).toInstant().isBefore(now)

    /**
     * The first minute on [date] whose instant is not already past, or null when
     * the day has none left — a date whose last minute is behind [now], and the
     * seconds after 23:59 on the current day.
     */
    fun earliestSelectableMinute(date: LocalDate, now: Instant, zone: ZoneId): LocalTime? {
        if (!date.atStartOfDay(zone).toInstant().isBefore(now)) return LocalTime.MIN
        val local = now.atZone(zone)
        if (local.toLocalDate() != date) return null
        val onTheMinute = local.toLocalTime().withSecond(0).withNano(0)
        if (onTheMinute == local.toLocalTime()) return onTheMinute
        val next = onTheMinute.plusMinutes(1)
        // 23:59:xx wraps to 00:00, which belongs to the next day, not this one.
        return if (next.isAfter(onTheMinute)) next else null
    }

    /**
     * Where the time picker opens. A bounded picker cannot rest on a position
     * outside its range, so neither does this: a stored time that has already
     * passed opens on the first minute still inside the range. Opening a picker
     * changes nothing until the choice is confirmed.
     */
    fun onceTimeStart(date: LocalDate, time: LocalTime, now: Instant, zone: ZoneId): LocalTime =
        if (onceInstantSelectable(date, time.hour, time.minute, now, zone)) {
            time
        } else {
            earliestSelectableMinute(date, now, zone) ?: time
        }

    fun schedule(
        kind: RoutineSchedule.Kind,
        onceAtMillis: Double,
        hour: Int,
        minute: Int,
        weekdays: Set<Int>,
        everyMinutes: Int = DEFAULT_INTERVAL,
    ): RoutineSchedule = when (kind) {
        RoutineSchedule.Kind.ONCE -> RoutineSchedule.once(onceAtMillis)
        RoutineSchedule.Kind.DAILY ->
            RoutineSchedule.daily(timeText(hour, minute), weekdays.sorted())
        RoutineSchedule.Kind.INTERVAL ->
            RoutineSchedule.interval(everyMinutes, onceAtMillis.toLong())
        RoutineSchedule.Kind.UNKNOWN -> RoutineSchedule(kind)
    }

    fun input(
        name: String,
        prompt: String,
        botId: String,
        runOn: RoutineRunLocation,
        enabled: Boolean?,
        schedule: RoutineSchedule,
        durationMinutes: Int,
        timeoutMinutes: Int? = null,
    ): RoutineInput {
        require(validTimeout(timeoutMinutes)) {
            "Timeout must be empty or a whole number from 5 to 240"
        }
        return RoutineInput(
            name = name.trim().take(NAME_LIMIT),
            prompt = prompt.trim().take(PROMPT_LIMIT),
            botId = botId,
            runOn = runOn.wireValue,
            enabled = enabled,
            schedule = schedule,
            durationMinutes = durationMinutes,
            timeoutMinutes = timeoutMinutes,
            clearTimeout = timeoutMinutes == null,
        )
    }
}

/**
 * The one-time instant while it is being picked.
 *
 * The Swift edits it with a single bounded `DatePicker`, so there is no moment
 * where half a choice exists. Material picks the day and the clock in two
 * dialogs, which creates one: a day the user has chosen and a time they have
 * not yet confirmed. That half lives in [stagedDate] and touches nothing —
 * only [confirm] writes [millis], so cancelling either dialog leaves the
 * instant the routine already had exactly as it was.
 */
data class OnceDraft(
    val millis: Long,
    /** Chosen in the date dialog, waiting for the time dialog. Never saved. */
    val stagedDate: LocalDate? = null,
) {
    /** The day the time dialog is bounding: the staged one, else the committed one. */
    fun date(zone: ZoneId): LocalDate =
        stagedDate ?: Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()

    /** The committed time of day, which the time dialog opens near. */
    fun time(zone: ZoneId): LocalTime =
        Instant.ofEpochMilli(millis).atZone(zone).toLocalTime()

    fun stage(date: LocalDate): OnceDraft = copy(stagedDate = date)

    /** Cancelling, at either step. */
    fun discard(): OnceDraft = copy(stagedDate = null)

    /** The only write: the day being bounded, at the confirmed time. */
    fun confirm(hour: Int, minute: Int, zone: ZoneId): OnceDraft = OnceDraft(
        millis = date(zone)
            .atTime(hour, minute)
            .atZone(zone)
            .toInstant()
            .toEpochMilli(),
    )
}

/**
 * The editor's agent, and whether the one-time default has been applied yet.
 *
 * `onAppear { if botId.isEmpty { botId = …first } }` runs once in the Swift,
 * because a rotation does not rebuild the view. On Android the effect runs again
 * after every recreation, so "no agent has been chosen yet" and "the user chose
 * the empty tag" have to be distinguishable — otherwise restoring a deliberate
 * "Choose an agent" hands it the first agent instead. [applied] is what carries
 * that distinction across the recreation.
 */
data class AgentChoice(val botId: String, val applied: Boolean = false) {
    /**
     * The default, once. Every later call is a no-op whatever was chosen — the
     * Swift's `onAppear` fires once too, so a fleet frame landing afterwards
     * never re-seeds either.
     */
    fun withDefault(firstAgentId: String?): AgentChoice =
        if (applied) this else AgentChoice(botId.ifEmpty { firstAgentId.orEmpty() }, applied = true)

    /** Any pick from the picker is a made choice, the empty tag included. */
    fun choose(id: String): AgentChoice = AgentChoice(id, applied = true)
}
