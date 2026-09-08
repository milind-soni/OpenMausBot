package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ActivityRow
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class ActivityRulesTest {
    private fun row(at: String, outcome: String = "ran") =
        ActivityRow(at = at, threadId = "t1", tool = "Bash", app = null, label = "Ran a command", outcome = outcome)

    @Test
    fun groupsNewestFirstRowsUnderTheirDayWithTodayAndYesterdayNamed() {
        val today = LocalDate.of(2026, 9, 7)
        val days = ActivityRules.days(
            listOf(row("2026-09-07T18:00:00.000Z"), row("2026-09-07T09:00:00.000Z"), row("2026-09-06T12:00:00.000Z"), row("2026-09-05T12:00:00.000Z")),
            today,
            ZoneOffset.UTC,
        )
        assertEquals(listOf("Today" to 2, "Yesterday" to 1, "Sat 5 Sep" to 1), days.map { it.label to it.rows.size })
    }

    @Test
    fun givesEveryOutcomeAWordAndAToneMatchingIos() {
        assertEquals(ActivityRules.Chip("Ran", ActivityRules.Tone.GOOD), ActivityRules.chip("ran"))
        assertEquals(ActivityRules.Chip("Allowed", ActivityRules.Tone.GOOD), ActivityRules.chip("allowed"))
        assertEquals(ActivityRules.Chip("Failed", ActivityRules.Tone.BAD), ActivityRules.chip("failed"))
        assertEquals(ActivityRules.Chip("Denied", ActivityRules.Tone.BAD), ActivityRules.chip("denied"))
        assertEquals(ActivityRules.Chip("Running", ActivityRules.Tone.LIVE), ActivityRules.chip("running"))
        assertEquals(ActivityRules.Chip("Needs you", ActivityRules.Tone.WAITING), ActivityRules.chip("waiting"))
    }

    @Test
    fun formatsTimesInTheViewersZoneAndShrugsAtJunk() {
        assertEquals("09:05", ActivityRules.time("2026-09-07T09:05:00.000Z", ZoneOffset.UTC))
        assertEquals("", ActivityRules.time("not a time", ZoneOffset.UTC))
        assertEquals("Maus activity", ActivityRules.title("Maus"))
    }
}
