package com.openmausbot.companion.ui

import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The branching, not the JDK's locale data: the exact rendering of "3:04 PM"
 * belongs to `DateTimeFormatter`, but which of the four shapes a stamp takes is
 * the spec from `ios/App/ChatListView.swift`.
 */
class RelativeStampTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val locale = Locale.US

    /** Thursday 2026-08-20, 15:00 UTC. */
    private val now = LocalDateTime.of(2026, 8, 20, 15, 0).toInstant(ZoneOffset.UTC).toEpochMilli()

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int): Double =
        LocalDateTime.of(year, month, day, hour, minute)
            .toInstant(ZoneOffset.UTC)
            .toEpochMilli()
            .toDouble()

    @Test
    fun `an update stamp is the local date and time, and a missing one is blank`() {
        val stamp = at(2026, 8, 20, 9, 30)
        assertEquals("", RelativeStamp.updated(0.0, zone, locale))
        assertEquals("", RelativeStamp.updated(-1.0, zone, locale))
        val tokyo = ZoneId.of("Asia/Tokyo")
        val newYork = ZoneId.of("America/New_York")
        assertTrue(RelativeStamp.updated(stamp, tokyo, locale) != RelativeStamp.updated(stamp, newYork, locale))
        assertEquals(
            RelativeStamp.updated(stamp, ZoneId.systemDefault(), Locale.getDefault()),
            RelativeStamp.updated(stamp),
        )
    }

    @Test
    fun `a thread that never moved has no stamp`() {
        assertEquals("", RelativeStamp.list(0.0, now, zone, locale))
        assertEquals("", RelativeStamp.list(-1.0, now, zone, locale))
    }

    @Test
    fun `today shows the time`() {
        val stamp = at(2026, 8, 20, 9, 30)
        assertEquals(RelativeStamp.time(stamp, zone, locale), RelativeStamp.list(stamp, now, zone, locale))
    }

    @Test
    fun `yesterday says so`() {
        assertEquals("Yesterday", RelativeStamp.list(at(2026, 8, 19, 23, 59), now, zone, locale))
    }

    @Test
    fun `earlier in the week is the weekday`() {
        assertEquals("Sunday", RelativeStamp.list(at(2026, 8, 16, 12, 0), now, zone, locale))
    }

    @Test
    fun `beyond a week is a date`() {
        assertEquals("Aug 2", RelativeStamp.list(at(2026, 8, 2, 12, 0), now, zone, locale))
    }

    @Test
    fun `the weekday window is six days, not seven`() {
        // Six days back is still inside the window; older than that is a date.
        assertTrue(RelativeStamp.list(at(2026, 8, 14, 16, 0), now, zone, locale).isNotEmpty())
        assertEquals("Aug 13", RelativeStamp.list(at(2026, 8, 13, 12, 0), now, zone, locale))
    }

    @Test
    fun `transcript separators name the day and the time`() {
        val clock = RelativeStamp.time(at(2026, 8, 20, 9, 30), zone, locale)
        assertEquals("Today $clock", RelativeStamp.separator(at(2026, 8, 20, 9, 30), now, zone, locale))
        assertEquals(
            "Yesterday ${RelativeStamp.time(at(2026, 8, 19, 9, 30), zone, locale)}",
            RelativeStamp.separator(at(2026, 8, 19, 9, 30), now, zone, locale),
        )
        assertTrue(
            RelativeStamp.separator(at(2026, 7, 4, 9, 30), now, zone, locale).startsWith("Jul 4 "),
        )
    }
}
