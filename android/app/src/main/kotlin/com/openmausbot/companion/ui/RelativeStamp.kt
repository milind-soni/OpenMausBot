package com.openmausbot.companion.ui

import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Timestamps the way a messaging app writes them — the port of
 * `RelativeStamp` in `ios/App/ChatListView.swift`.
 *
 * Every function takes "now" rather than reading the clock, so the branching —
 * which is the actual spec — is unit-testable without a fake clock.
 */
object RelativeStamp {

    /** Roster: time today, "Yesterday", weekday within the week, date beyond that. */
    fun list(
        atMillis: Double,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        if (atMillis <= 0) return ""
        val at = zoned(atMillis, zone)
        val now = zoned(nowMillis.toDouble(), zone)
        return when {
            at.toLocalDate() == now.toLocalDate() -> time(atMillis, zone, locale)
            at.toLocalDate() == now.toLocalDate().minusDays(1) -> "Yesterday"
            at.isAfter(now.minusDays(6)) -> weekdayFormatter(locale).format(at)
            else -> dateFormatter(locale).format(at)
        }
    }

    /** In a transcript: enough to place a gap in the conversation. */
    fun separator(
        atMillis: Double,
        nowMillis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        val at = zoned(atMillis, zone)
        val now = zoned(nowMillis.toDouble(), zone)
        val clock = time(atMillis, zone, locale)
        return when {
            at.toLocalDate() == now.toLocalDate() -> "Today $clock"
            at.toLocalDate() == now.toLocalDate().minusDays(1) -> "Yesterday $clock"
            else -> "${dateFormatter(locale).format(at)} $clock"
        }
    }

    /** Thread row: short date and short time. The default zone is the OS zone. */
    fun updated(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        if (atMillis <= 0.0 || !atMillis.isFinite()) return ""
        return DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT, FormatStyle.SHORT)
            .withLocale(locale)
            .format(zoned(atMillis, zone))
    }

    fun time(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
        .withLocale(locale)
        .format(zoned(atMillis, zone))

    /**
     * A schedule's instant, spelled out — Swift's
     * `.formatted(date: .abbreviated, time: .shortened)`, which is a medium
     * date beside a short time in the reader's locale.
     */
    fun dateAndTime(
        atMillis: Double,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withLocale(locale)
        .format(zoned(atMillis, zone))

    private fun zoned(millis: Double, zone: ZoneId): ZonedDateTime =
        ZonedDateTime.ofInstant(Instant.ofEpochMilli(millis.toLong()), zone)

    private fun weekdayFormatter(locale: Locale) = DateTimeFormatter.ofPattern("EEEE", locale)

    private fun dateFormatter(locale: Locale) = DateTimeFormatter.ofPattern("MMM d", locale)
}
