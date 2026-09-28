package com.openmausbot.companion.ui

import java.util.Calendar
import kotlin.test.Test
import kotlin.test.assertEquals

/** The clock presets, worded and ordered as the desktop words them. */
class SnoozeRulesTest {
    private fun at(month: Int, day: Int, hour: Int, minute: Int = 0): Long =
        Calendar.getInstance().apply {
            clear()
            set(2026, month, day, hour, minute, 0)
        }.timeInMillis

    @Test
    fun presetsLeadWithActivityAndTravelTheSentinelAsZero() {
        val presets = SnoozeRules.presets
        assertEquals(
            listOf(
                SnoozeRules.UNTIL_NEW_ACTIVITY,
                SnoozeRules.UNTIL_SIX_PM,
                SnoozeRules.UNTIL_NINE_AM_TOMORROW,
            ),
            presets.map { it.label },
        )
        assertEquals(0L, presets[0].until(at(Calendar.SEPTEMBER, 14, 12)))
    }

    @Test
    fun retainedPresetsResolveAgainstTheSelectionTimeAfterMidnight() {
        val tomorrow = SnoozeRules.Preset.NINE_AM_TOMORROW
        assertEquals(at(Calendar.SEPTEMBER, 15, 9), tomorrow.until(at(Calendar.SEPTEMBER, 14, 23)))
        assertEquals(at(Calendar.SEPTEMBER, 16, 9), tomorrow.until(at(Calendar.SEPTEMBER, 15, 0)))
    }

    @Test
    fun sixPmIsTonightWhileItIsStillAheadAndTomorrowOnceItHasPassed() {
        val sixToday = at(Calendar.SEPTEMBER, 14, 18)
        val sixTomorrow = at(Calendar.SEPTEMBER, 15, 18)
        assertEquals(sixToday, SnoozeRules.sixPm(at(Calendar.SEPTEMBER, 14, 17)))
        assertEquals(sixTomorrow, SnoozeRules.sixPm(at(Calendar.SEPTEMBER, 14, 18)))
        assertEquals(sixTomorrow, SnoozeRules.sixPm(at(Calendar.SEPTEMBER, 14, 19)))
    }

    @Test
    fun nineAmTomorrowIsAlwaysTheNextMorningEvenLateAtNight() {
        val expected = at(Calendar.SEPTEMBER, 15, 9)
        assertEquals(expected, SnoozeRules.nineAmTomorrow(at(Calendar.SEPTEMBER, 14, 8)))
        assertEquals(expected, SnoozeRules.nineAmTomorrow(at(Calendar.SEPTEMBER, 14, 22)))
    }
}
