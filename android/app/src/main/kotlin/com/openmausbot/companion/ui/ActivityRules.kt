package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ActivityRow
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * A bot's activity log, as rules — the copy and the grouping behind
 * [BotActivityScreen]. Rows arrive newest first from the computer; the
 * screen shows them under day headings with an outcome chip, matching
 * `ios/App/BotActivityView.swift` and the desktop's Activity panel.
 */
object ActivityRules {
    const val PROFILE_ROW: String = "Activity"
    const val FAILED: String = "Couldn't load the activity log."

    fun title(name: String): String = "$name activity"

    fun empty(name: String): String = "Nothing yet. Once $name runs a tool or asks for an approval, it shows up here."

    /** One short word per outcome, and whether it reads as good, bad, live, or waiting. */
    enum class Tone { GOOD, BAD, LIVE, WAITING, PLAIN }

    data class Chip(val text: String, val tone: Tone)

    fun chip(outcome: String): Chip = when (outcome) {
        "ran" -> Chip("Ran", Tone.GOOD)
        "allowed" -> Chip("Allowed", Tone.GOOD)
        "failed" -> Chip("Failed", Tone.BAD)
        "denied" -> Chip("Denied", Tone.BAD)
        "running" -> Chip("Running", Tone.LIVE)
        "waiting" -> Chip("Needs you", Tone.WAITING)
        else -> Chip(outcome, Tone.PLAIN)
    }

    data class Day(val key: LocalDate, val label: String, val rows: List<ActivityRow>)

    private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE d MMM")
    private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun instant(iso: String): Instant? = try {
        Instant.parse(iso)
    } catch (_: DateTimeParseException) {
        null
    }

    /** "09:00" in the viewer's zone, or nothing when the stamp is unreadable. */
    fun time(iso: String, zone: ZoneId = ZoneId.systemDefault()): String =
        instant(iso)?.atZone(zone)?.toLocalTime()?.format(timeFormat).orEmpty()

    /** Group newest-first rows under their local day, keeping that order. */
    fun days(rows: List<ActivityRow>, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): List<Day> {
        val result = mutableListOf<Day>()
        for (row in rows) {
            val date = instant(row.at)?.atZone(zone)?.toLocalDate() ?: today
            val last = result.lastOrNull()
            if (last != null && last.key == date) {
                result[result.lastIndex] = last.copy(rows = last.rows + row)
            } else {
                val label = when (date) {
                    today -> "Today"
                    today.minusDays(1) -> "Yesterday"
                    else -> date.format(dayFormat)
                }
                result += Day(date, label, listOf(row))
            }
        }
        return result
    }
}
