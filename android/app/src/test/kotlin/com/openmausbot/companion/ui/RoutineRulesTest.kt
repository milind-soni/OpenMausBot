package com.openmausbot.companion.ui

import androidx.compose.runtime.saveable.SaverScope
import com.openmausbot.companion.core.ConfigFlag
import com.openmausbot.companion.core.ConfigStatus
import com.openmausbot.companion.core.Instance
import com.openmausbot.companion.core.ModelCatalog
import com.openmausbot.companion.core.ProviderSnapshot
import com.openmausbot.companion.core.Routine
import com.openmausbot.companion.core.RoutineRun
import com.openmausbot.companion.core.RoutineRunAvailability
import com.openmausbot.companion.core.RoutineRunLocation
import com.openmausbot.companion.core.RoutineSchedule
import java.time.LocalDate
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * D2-07: what Tasks & Routines decides.
 *
 * Expectations come from `ios/App/TasksRoutinesView.swift` — the two sorts at
 * `:107-113` and `:62`, `RoutineSchedule.summary` and the status symbol/tint
 * extensions at the foot of the file, and `RoutineEditorView`'s Save gate and
 * `RoutineInput` construction at `:330-350`.
 */
class RoutineRulesTest {
    private val utc = ZoneId.of("UTC")
    private val en = Locale.US

    @Test
    fun `routine copy distinguishes fresh context from the shared results thread`() {
        assertEquals("Routine = scheduled work with one results thread", RoutineRules.HEADER_ROUTINE)
        for (footer in listOf(RoutineRules.SCHEDULE_FOOTER, RoutineRules.INTERVAL_SCHEDULE_FOOTER)) {
            assertTrue(footer.contains("fresh context"))
            assertTrue(footer.contains("Results collect in one thread"))
            assertTrue(footer.contains("full run logs remain available"))
        }
        assertTrue(RoutineRules.INTERVAL_SCHEDULE_FOOTER.contains("skipped instead of queued"))
    }

    @Test
    fun `routines sort by next run, and one with none sorts last`() {
        val soon = routine(id = "soon", nextRunAt = 1_000.0)
        val later = routine(id = "later", nextRunAt = 9_000.0)
        val never = routine(id = "never", nextRunAt = null)

        assertEquals(
            listOf("soon", "later", "never"),
            RoutineRules.sorted(listOf(never, later, soon)).map { it.id },
        )
    }

    @Test
    fun `receipts are newest first and stop at fifty`() {
        val runs = (1..60).map { run(id = "run-$it", scheduledFor = it.toDouble()) }

        val shown = RoutineRules.receipts(runs)

        assertEquals(50, shown.size)
        assertEquals("run-60", shown.first().id)
        assertEquals("run-11", shown.last().id)
    }

    @Test
    fun `a one-time schedule reads as its instant`() {
        // Swift: `Date(timeIntervalSince1970: at / 1_000).formatted(date:
        // .abbreviated, time: .shortened)`. Pinned as a literal rather than
        // against the same helper production calls, so a shared formatting
        // change cannot agree with itself. 1_700_000_000_000 ms is
        // 2023-11-14T22:13:20Z: an abbreviated date and a short 12-hour time.
        //
        // Only the *class* of space before the meridiem is normalised. CLDR
        // moved it from U+0020 to U+202F between JDK 17 and 25 — two runtimes on
        // one machine disagree, Android's ICU decides for itself, and the Swift
        // pins no such character. Everything the Swift does specify is compared
        // literally.
        val summary = RoutineRules.scheduleSummary(
            RoutineSchedule.once(1_700_000_000_000.0),
            utc,
            en,
        )

        assertEquals("Nov 14, 2023, 10:13 PM", spacesNormalized(summary))
    }

    @Test
    fun `a one-time schedule with no instant says so`() {
        val schedule = RoutineSchedule(RoutineSchedule.Kind.ONCE, at = null)

        assertEquals(
            "One time · date unavailable",
            RoutineRules.scheduleSummary(schedule, utc, en),
        )
    }

    @Test
    fun `an unknown schedule stays visible as a newer one`() {
        val schedule = RoutineSchedule(RoutineSchedule.Kind.UNKNOWN)

        assertEquals("Newer schedule", RoutineRules.scheduleSummary(schedule, utc, en))
    }

    @Test
    fun `an interval schedule reads as its cadence`() {
        assertEquals(
            "Every 5 min · starting Nov 14, 2023, 10:13 PM",
            spacesNormalized(
                RoutineRules.scheduleSummary(
                    RoutineSchedule.interval(5, 1_700_000_000_000L),
                    utc,
                    en,
                ),
            ),
        )
        assertEquals(
            "Interval unavailable",
            RoutineRules.scheduleSummary(RoutineSchedule(RoutineSchedule.Kind.INTERVAL), utc, en),
        )
    }

    @Test
    fun `seven days read as every day and the working week as weekdays`() {
        assertEquals(
            "Every day at 09:00",
            RoutineRules.scheduleSummary(
                RoutineSchedule.daily("09:00", listOf(0, 1, 2, 3, 4, 5, 6)),
                utc,
                en,
            ),
        )
        assertEquals(
            "Weekdays at 07:30",
            RoutineRules.scheduleSummary(RoutineSchedule.daily("07:30", listOf(1, 2, 3, 4, 5)), utc, en),
        )
    }

    @Test
    fun `any other selection lists three-letter days in the given order`() {
        assertEquals(
            "Sun, Sat at 10:00",
            RoutineRules.scheduleSummary(RoutineSchedule.daily("10:00", listOf(0, 6)), utc, en),
        )
    }

    @Test
    fun `out-of-range weekdays are dropped from the summary`() {
        assertEquals(
            "Mon at 10:00",
            RoutineRules.scheduleSummary(RoutineSchedule.daily("10:00", listOf(1, 9)), utc, en),
        )
    }

    @Test
    fun `the Swift's two schedule quirks are mirrored, not repaired`() {
        // Seven of anything is "Every day", even seven of the same day…
        assertEquals(
            "Every day at 08:00",
            RoutineRules.scheduleSummary(
                RoutineSchedule.daily("08:00", listOf(3, 3, 3, 3, 3, 3, 3)),
                utc,
                en,
            ),
        )
        // …and only the exact ordered [1,2,3,4,5] is "Weekdays".
        assertEquals(
            "Fri, Thu, Wed, Tue, Mon at 08:00",
            RoutineRules.scheduleSummary(
                RoutineSchedule.daily("08:00", listOf(5, 4, 3, 2, 1)),
                utc,
                en,
            ),
        )
    }

    @Test
    fun `a missing time falls back to an em dash`() {
        val schedule = RoutineSchedule(RoutineSchedule.Kind.DAILY, weekdays = listOf(1))

        assertEquals("Mon at —", RoutineRules.scheduleSummary(schedule, utc, en))
    }

    @Test
    fun `a routine subtitle names the agent, the schedule and where it runs`() {
        val routine = routine(schedule = RoutineSchedule.daily("09:00", listOf(1, 2, 3, 4, 5)))

        assertEquals(
            "Scout · Weekdays at 09:00 · This computer",
            RoutineRules.routineSubtitle(routine, "Scout", utc, en),
        )
        assertEquals(
            "Deleted agent · Weekdays at 09:00 · This computer",
            RoutineRules.routineSubtitle(routine, null, utc, en),
        )
    }

    @Test
    fun `an unrecognised run location falls back to the computer`() {
        assertEquals(
            "This computer",
            RoutineRules.locationLabel(routine(runOn = "moon").runLocation),
        )
        assertEquals(
            "Cloud VM",
            RoutineRules.locationLabel(routine(runOn = "cloud").runLocation),
        )
    }

    @Test
    fun `a paused daily routine can resume, a spent one-time routine cannot`() {
        val now = 5_000.0
        val daily = routine(enabled = false, schedule = RoutineSchedule.daily("09:00", listOf(1)))
        val past = routine(enabled = false, schedule = RoutineSchedule.once(1_000.0))
        val future = routine(enabled = false, schedule = RoutineSchedule.once(9_000.0))

        assertEquals(RoutineRules.PausedBadge.PAUSED, RoutineRules.pausedBadge(daily, now))
        assertEquals(RoutineRules.PausedBadge.COMPLETED, RoutineRules.pausedBadge(past, now))
        assertEquals(RoutineRules.PausedBadge.PAUSED, RoutineRules.pausedBadge(future, now))
        assertNull(
            RoutineRules.pausedBadge(routine(enabled = true), now),
            "a running routine wears no badge",
        )
    }

    @Test
    fun `an unknown schedule can never be toggled`() {
        val unknown = routine(
            enabled = false,
            schedule = RoutineSchedule(RoutineSchedule.Kind.UNKNOWN),
        )

        assertFalse(unknown.canToggle(0.0))
        assertEquals(RoutineRules.PausedBadge.COMPLETED, RoutineRules.pausedBadge(unknown, 0.0))
    }

    @Test
    fun `every run status maps to the Swift's symbol group`() {
        assertEquals(RoutineRules.RunStatus.RUNNING, RoutineRules.runStatus("running"))
        assertEquals(RoutineRules.RunStatus.COMPLETED, RoutineRules.runStatus("completed"))
        assertEquals(RoutineRules.RunStatus.WAITING, RoutineRules.runStatus("waiting"))
        assertEquals(RoutineRules.RunStatus.FAILED, RoutineRules.runStatus("failed"))
        assertEquals(RoutineRules.RunStatus.FAILED, RoutineRules.runStatus("missed"))
        assertEquals(RoutineRules.RunStatus.CANCELLED, RoutineRules.runStatus("cancelled"))
        assertEquals(RoutineRules.RunStatus.PENDING, RoutineRules.runStatus("pending"))
        assertEquals(RoutineRules.RunStatus.PENDING, RoutineRules.runStatus("something-newer"))
    }

    @Test
    fun `waiting reads as Needs you and everything else is capitalized`() {
        assertEquals("Needs you", RoutineRules.runStatusLabel("waiting"))
        assertEquals("Completed", RoutineRules.runStatusLabel("completed"))
        assertEquals("Failed", RoutineRules.runStatusLabel("FAILED"))
        assertEquals("Something Newer", RoutineRules.runStatusLabel("something newer"))
    }

    @Test
    fun `Cloud VM needs both the credential and an available agent`() {
        val ready = RoutineRunAvailability(cloudConfigured = true, cloudInstanceAvailable = true)
        val noAgent = RoutineRunAvailability(cloudConfigured = true, cloudInstanceAvailable = false)

        assertTrue(RoutineRules.cloudSelectable(ready, RoutineRunLocation.MAUS))
        assertFalse(RoutineRules.cloudSelectable(noAgent, RoutineRunLocation.MAUS))
    }

    @Test
    fun `an existing cloud routine keeps its choice while the VM is away`() {
        val noAgent = RoutineRunAvailability(cloudConfigured = false, cloudInstanceAvailable = false)

        assertTrue(RoutineRules.cloudSelectable(noAgent, RoutineRunLocation.CLOUD))
        assertTrue(
            RoutineRules.cloudSelectable(null, RoutineRunLocation.CLOUD),
            "status not loaded yet must not move an existing cloud routine",
        )
        assertFalse(RoutineRules.cloudSelectable(null, RoutineRunLocation.MAUS))
    }

    @Test
    fun `the run-location footer says what the choice actually means`() {
        val ready = RoutineRunAvailability(cloudConfigured = true, cloudInstanceAvailable = true)
        val blocked = RoutineRunAvailability(cloudConfigured = true, cloudInstanceAvailable = false)

        assertEquals(
            RoutineRules.MAUS_FOOTER,
            RoutineRules.locationFooter(RoutineRunLocation.MAUS, blocked),
        )
        assertEquals(
            RoutineRules.CLOUD_READY_FOOTER,
            RoutineRules.locationFooter(RoutineRunLocation.CLOUD, ready),
        )
        assertEquals(
            RoutineRules.CLOUD_BLOCKED_FOOTER,
            RoutineRules.locationFooter(RoutineRunLocation.CLOUD, blocked),
        )
        assertEquals(
            RoutineRules.CLOUD_BLOCKED_FOOTER,
            RoutineRules.locationFooter(RoutineRunLocation.CLOUD, null),
        )
    }

    @Test
    fun `Cloud VM availability is derived from the paired-safe status only`() {
        val instances = listOf(
            instance(driverKind = "boxAgent", state = "available"),
            instance(driverKind = "local", state = "available"),
        )
        val configured = ConfigStatus(box = ConfigFlag(configured = true))

        assertTrue(RoutineRunAvailability(configured, instances).cloudReady)
        assertFalse(RoutineRunAvailability(configured, emptyList()).cloudReady)
        assertFalse(RoutineRunAvailability(null, instances).cloudReady)
        assertFalse(
            RoutineRunAvailability(
                configured,
                listOf(instance(driverKind = "boxAgent", state = "unavailable")),
            ).cloudReady,
            "a Box agent that is not available is not a Cloud VM to run on",
        )
    }

    @Test
    fun `Save needs a name, a prompt, an agent, and days when it repeats`() {
        val ok = { kind: RoutineSchedule.Kind, days: Set<Int> ->
            RoutineRules.canSave(false, kind, "Nightly", "Do the thing", "bot-1", days)
        }

        assertTrue(ok(RoutineSchedule.Kind.DAILY, setOf(1)))
        assertFalse(ok(RoutineSchedule.Kind.DAILY, emptySet()))
        assertTrue(ok(RoutineSchedule.Kind.ONCE, emptySet()), "one-time needs no weekdays")
        assertFalse(ok(RoutineSchedule.Kind.INTERVAL, emptySet()), "an interval needs its cadence")
        assertTrue(
            RoutineRules.canSave(
                false,
                RoutineSchedule.Kind.INTERVAL,
                "n",
                "p",
                "b",
                emptySet(),
                everyMinutes = 5,
            ),
        )
        assertFalse(
            RoutineRules.canSave(
                false,
                RoutineSchedule.Kind.INTERVAL,
                "n",
                "p",
                "b",
                emptySet(),
                everyMinutes = 4,
            ),
        )
        assertFalse(ok(RoutineSchedule.Kind.UNKNOWN, setOf(1)))

        assertFalse(RoutineRules.canSave(true, RoutineSchedule.Kind.ONCE, "n", "p", "b", setOf(1)))
        assertFalse(RoutineRules.canSave(false, RoutineSchedule.Kind.ONCE, " ", "p", "b", setOf(1)))
        assertFalse(RoutineRules.canSave(false, RoutineSchedule.Kind.ONCE, "n", "\t", "b", setOf(1)))
        assertFalse(RoutineRules.canSave(false, RoutineSchedule.Kind.ONCE, "n", "p", "", setOf(1)))
    }

    @Test
    fun `the input is trimmed and capped at the wire's limits`() {
        val input = RoutineRules.input(
            name = "  " + "n".repeat(200) + "  ",
            prompt = "\n" + "p".repeat(30_000),
            botId = "bot-1",
            runOn = RoutineRunLocation.CLOUD,
            enabled = false,
            schedule = RoutineSchedule.daily("09:00", listOf(1)),
            durationMinutes = 5,
            timeoutMinutes = 45,
        )

        assertEquals(80, input.name.length)
        assertEquals(20_000, input.prompt.length)
        assertEquals("cloud", input.runOn)
        assertEquals(false, input.enabled)
        assertEquals(5, input.durationMinutes)
        assertEquals(45, input.timeoutMinutes)
        assertFalse(input.clearTimeout)
    }

    @Test
    fun `a new routine sends no enabled flag at all`() {
        val input = RoutineRules.input(
            name = "Nightly",
            prompt = "Do the thing",
            botId = "bot-1",
            runOn = RoutineRunLocation.MAUS,
            enabled = null,
            schedule = RoutineSchedule.daily("09:00", listOf(1)),
            durationMinutes = RoutineRules.LEGACY_DURATION_MINUTES,
        )

        assertNull(input.enabled)
        assertEquals(30, input.durationMinutes)
        assertNull(input.timeoutMinutes)
        assertTrue(input.clearTimeout)
    }

    @Test
    fun `on today, selection is bounded by the instant, not the wall clock`() {
        // `in: Date()...` bounds the instant. At 10:30:45 the minute 10:30
        // resolves to 10:30:00, which has already gone, so the first minute the
        // picker can offer is 10:31. Comparing only hour and minute would have
        // let 10:30 through and written a past instant.
        val now = Instant.parse("2026-03-03T10:30:45Z")
        val today = LocalDate.of(2026, 3, 3)

        assertFalse(RoutineRules.onceInstantSelectable(today, 10, 30, now, utc))
        assertFalse(RoutineRules.onceInstantSelectable(today, 10, 29, now, utc))
        assertFalse(RoutineRules.onceInstantSelectable(today, 0, 0, now, utc))
        assertTrue(RoutineRules.onceInstantSelectable(today, 10, 31, now, utc))
        assertTrue(RoutineRules.onceInstantSelectable(today, 23, 59, now, utc))
    }

    @Test
    fun `exactly on the minute, that minute is still inside the range`() {
        // `Date()...` is closed at its lower bound.
        val now = Instant.parse("2026-03-03T10:30:00Z")
        val today = LocalDate.of(2026, 3, 3)

        assertTrue(RoutineRules.onceInstantSelectable(today, 10, 30, now, utc))
        assertFalse(RoutineRules.onceInstantSelectable(today, 10, 29, now, utc))
    }

    @Test
    fun `on any later day, every minute is selectable`() {
        val now = Instant.parse("2026-03-03T10:30:45Z")

        assertTrue(RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 4), 0, 0, now, utc))
        assertTrue(RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 4), 10, 29, now, utc))
        assertTrue(RoutineRules.onceInstantSelectable(LocalDate.of(2027, 1, 1), 3, 15, now, utc))
    }

    @Test
    fun `a day already gone offers no minute at all`() {
        val now = Instant.parse("2026-03-03T10:30:45Z")

        assertFalse(
            RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 2), 23, 59, now, utc),
        )
    }

    @Test
    fun `the bound is read in the picker's own zone`() {
        // 2026-03-03T23:30:00Z is already 2026-03-04 in Tokyo, so a Tokyo user
        // picking 03-04 at 00:00 is choosing a moment that has passed.
        val now = Instant.parse("2026-03-03T23:30:00Z")
        val tokyo = ZoneId.of("Asia/Tokyo")

        assertFalse(
            RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 4), 0, 0, now, tokyo),
        )
        assertTrue(
            RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 4), 9, 0, now, tokyo),
        )
        assertTrue(
            RoutineRules.onceInstantSelectable(LocalDate.of(2026, 3, 4), 0, 0, now, utc),
            "the same wall clock is still ahead in UTC",
        )
    }

    @Test
    fun `the first minute still inside the range is the one after a partial one`() {
        val today = LocalDate.of(2026, 3, 3)

        assertEquals(
            LocalTime.of(10, 31),
            RoutineRules.earliestSelectableMinute(today, Instant.parse("2026-03-03T10:30:45Z"), utc),
        )
        assertEquals(
            LocalTime.of(10, 30),
            RoutineRules.earliestSelectableMinute(today, Instant.parse("2026-03-03T10:30:00Z"), utc),
            "a whole minute has not started to pass yet",
        )
        assertEquals(
            LocalTime.MIN,
            RoutineRules.earliestSelectableMinute(
                LocalDate.of(2026, 3, 4),
                Instant.parse("2026-03-03T10:30:45Z"),
                utc,
            ),
            "a later day starts at midnight",
        )
    }

    @Test
    fun `a day with no minute left answers with none`() {
        // 23:59:xx: the next representable minute belongs to tomorrow.
        assertNull(
            RoutineRules.earliestSelectableMinute(
                LocalDate.of(2026, 3, 3),
                Instant.parse("2026-03-03T23:59:30Z"),
                utc,
            ),
        )
        assertNull(
            RoutineRules.earliestSelectableMinute(
                LocalDate.of(2026, 3, 2),
                Instant.parse("2026-03-03T10:30:45Z"),
                utc,
            ),
            "yesterday has nothing left either",
        )
    }

    @Test
    fun `the time picker opens inside the range, never below it`() {
        val now = Instant.parse("2026-03-03T10:30:45Z")
        val today = LocalDate.of(2026, 3, 3)
        val tomorrow = LocalDate.of(2026, 3, 4)

        // A stored time that has passed opens on the first minute still in range…
        assertEquals(
            LocalTime.of(10, 31),
            RoutineRules.onceTimeStart(today, LocalTime.of(8, 15), now, utc),
        )
        assertEquals(
            LocalTime.of(10, 31),
            RoutineRules.onceTimeStart(today, LocalTime.of(10, 30), now, utc),
            "10:30 is exactly the minute the instant comparison rejects",
        )
        // …and one that has not is left exactly where it was.
        assertEquals(
            LocalTime.of(18, 45),
            RoutineRules.onceTimeStart(today, LocalTime.of(18, 45), now, utc),
        )
        assertEquals(
            LocalTime.of(2, 0),
            RoutineRules.onceTimeStart(tomorrow, LocalTime.of(2, 0), now, utc),
            "a later day is unbounded, so nothing moves",
        )
    }

    @Test
    fun `with no minute left in the day the picker stays where it was`() {
        // Nothing to move to; the OK button is what refuses.
        val now = Instant.parse("2026-03-03T23:59:30Z")
        val today = LocalDate.of(2026, 3, 3)

        assertEquals(
            LocalTime.of(8, 15),
            RoutineRules.onceTimeStart(today, LocalTime.of(8, 15), now, utc),
        )
        assertFalse(RoutineRules.onceInstantSelectable(today, 8, 15, now, utc))
    }

    @Test
    fun `Next then cancelling the time leaves a routine that fired earlier today alone`() {
        // The exact flow that used to lose a value: a one-time routine that
        // already ran this morning, open the picker, change nothing, tap Next,
        // cancel the clock. Carrying the time across used to pull it forward to
        // the current minute — the bound belongs to the picker, not to the value.
        val now = Instant.parse("2026-03-03T10:30:45Z")
        val firedThisMorning = Instant.parse("2026-03-03T08:00:00Z").toEpochMilli()
        val draft = OnceDraft(firedThisMorning)
        val today = draft.date(utc)
        assertEquals(LocalDate.of(2026, 3, 3), today)

        // The clock does open forward, on the first minute still in range…
        assertEquals(
            LocalTime.of(10, 31),
            RoutineRules.onceTimeStart(today, draft.time(utc), now, utc),
        )

        // …and staging that same day writes nothing, because staging has no clock.
        val staged = draft.stage(today)
        assertEquals(firedThisMorning, staged.millis, "Next must not write")
        assertEquals(today, staged.stagedDate)

        val cancelled = staged.discard()
        assertEquals(firedThisMorning, cancelled.millis)
        assertNull(cancelled.stagedDate)
    }

    @Test
    fun `cancelling after choosing a different day writes nothing either`() {
        val fired = Instant.parse("2026-03-01T08:00:00Z").toEpochMilli()
        val draft = OnceDraft(fired)

        val staged = draft.stage(LocalDate.of(2026, 6, 9))
        assertEquals(fired, staged.millis)
        assertEquals(LocalDate.of(2026, 6, 9), staged.date(utc), "the clock is bounded by the new day")

        assertEquals(fired, staged.discard().millis)
    }

    @Test
    fun `only OK writes, and it writes the staged day at the confirmed time`() {
        val draft = OnceDraft(Instant.parse("2026-03-01T08:00:00Z").toEpochMilli())

        val confirmed = draft.stage(LocalDate.of(2026, 6, 9)).confirm(9, 30, utc)

        assertEquals(
            Instant.parse("2026-06-09T09:30:00Z").toEpochMilli(),
            confirmed.millis,
        )
        assertNull(confirmed.stagedDate, "the staged half is spent")
    }

    @Test
    fun `confirming without staging keeps the day the routine already had`() {
        // The daily flow never stages, and neither does a user who only wants a
        // different time on the same day.
        val draft = OnceDraft(Instant.parse("2026-03-01T08:00:00Z").toEpochMilli())

        assertEquals(
            Instant.parse("2026-03-01T23:15:00Z").toEpochMilli(),
            draft.confirm(23, 15, utc).millis,
        )
    }

    @Test
    fun `the confirmed instant is built in the picker's zone`() {
        val draft = OnceDraft(Instant.parse("2026-03-01T08:00:00Z").toEpochMilli())
        val tokyo = ZoneId.of("Asia/Tokyo")

        assertEquals(
            Instant.parse("2026-03-01T00:30:00Z").toEpochMilli(),
            draft.stage(LocalDate.of(2026, 3, 1)).confirm(9, 30, tokyo).millis,
        )
    }

    @Test
    fun `the committed time is what the clock opens near, staged day or not`() {
        val draft = OnceDraft(Instant.parse("2026-03-01T08:45:00Z").toEpochMilli())

        assertEquals(LocalTime.of(8, 45), draft.time(utc))
        assertEquals(
            LocalTime.of(8, 45),
            draft.stage(LocalDate.of(2026, 6, 9)).time(utc),
            "staging a day does not move the time",
        )
    }

    @Test
    fun `choosing no agent survives a recreation instead of taking the first one`() {
        // "Choose an agent" is the empty tag, and picking it is a decision. The
        // seeding effect re-runs after every Activity recreation, so without the
        // applied flag the restored empty would be replaced by the first agent —
        // the one draft field that used to be lost.
        val chosen = AgentChoice("").withDefault("bot-1").choose("")

        assertEquals("", chosen.botId)
        assertTrue(chosen.applied)

        val restored = rotate(chosen)
        assertEquals(chosen, restored, "the distinction has to be in what is saved")
        assertEquals(
            "",
            restored.withDefault("bot-1").botId,
            "the effect runs again after the recreation and must do nothing",
        )
    }

    @Test
    fun `a new routine takes the first agent, once`() {
        val fresh = AgentChoice("")
        assertFalse(fresh.applied)

        val seeded = fresh.withDefault("bot-1")
        assertEquals("bot-1", seeded.botId)
        assertTrue(seeded.applied)

        // A later fleet frame must not walk back over a pick, as `onAppear` does
        // not fire twice in the Swift.
        assertEquals("bot-2", seeded.choose("bot-2").withDefault("bot-1").botId)
        assertEquals("bot-1", rotate(seeded).withDefault("bot-9").botId)
    }

    @Test
    fun `an edit keeps the agent the routine already had`() {
        val editing = AgentChoice("bot-9")

        assertEquals("bot-9", editing.withDefault("bot-1").botId)
        assertEquals("bot-9", rotate(editing.withDefault("bot-1")).botId)
    }

    @Test
    fun `appearing with an empty fleet still counts as having run`() {
        // Swift: `?? ""` inside a once-only `onAppear`.
        val none = AgentChoice("").withDefault(null)

        assertEquals("", none.botId)
        assertTrue(none.applied)
        assertEquals("", none.withDefault("bot-1").botId)
    }

    @Test
    fun `an already-fired routine still saves its past instant untouched`() {
        // iOS bounds the *selection*, not the bound value: a one-time routine
        // whose instant has passed re-saves as it stands while the pickers stay
        // closed. Nothing about `at` feeds the Save gate.
        val past = 1_600_000_000_000.0
        val schedule = RoutineRules.schedule(
            RoutineSchedule.Kind.ONCE,
            onceAtMillis = past,
            hour = 9,
            minute = 0,
            weekdays = emptySet(),
        )

        assertEquals(past, schedule.at)
        assertTrue(
            RoutineRules.canSave(
                saving = false,
                kind = RoutineSchedule.Kind.ONCE,
                name = "Nightly",
                prompt = "Do the thing",
                botId = "bot-1",
                weekdays = emptySet(),
            ),
        )
        assertEquals(
            past,
            RoutineRules.input(
                name = "Nightly",
                prompt = "Do the thing",
                botId = "bot-1",
                runOn = RoutineRunLocation.MAUS,
                enabled = true,
                schedule = schedule,
                durationMinutes = 30,
            ).schedule.at,
        )
    }

    @Test
    fun `the built schedule carries only the fields its kind uses`() {
        val once = RoutineRules.schedule(
            RoutineSchedule.Kind.ONCE,
            onceAtMillis = 1_700_000_000_000.0,
            hour = 9,
            minute = 30,
            weekdays = setOf(1, 2),
        )
        assertEquals(1_700_000_000_000.0, once.at)
        assertNull(once.time)
        assertNull(once.weekdays)

        val daily = RoutineRules.schedule(
            RoutineSchedule.Kind.DAILY,
            onceAtMillis = 1_700_000_000_000.0,
            hour = 7,
            minute = 5,
            weekdays = setOf(3, 1),
        )
        assertNull(daily.at)
        assertEquals("07:05", daily.time)
        assertEquals(listOf(1, 3), daily.weekdays, "weekdays go out sorted")

        val interval = RoutineRules.schedule(
            RoutineSchedule.Kind.INTERVAL,
            onceAtMillis = 1_700_000_000_000.0,
            hour = 7,
            minute = 5,
            weekdays = setOf(1),
            everyMinutes = 15,
        )
        assertNull(interval.at)
        assertNull(interval.time)
        assertNull(interval.weekdays)
        assertEquals(15, interval.everyMinutes)
        assertEquals(1_700_000_000_000L, interval.anchorAt)
    }

    @Test
    fun `interval minutes accept five minutes through one day`() {
        assertEquals(listOf(5, 10, 15, 30, 60), RoutineRules.INTERVAL_PRESETS)
        assertEquals(15, RoutineRules.DEFAULT_INTERVAL)
        assertEquals(5, RoutineRules.intervalMinutes("5"))
        assertEquals(1_440, RoutineRules.intervalMinutes(" 1440 "))
        assertNull(RoutineRules.intervalMinutes(""))
        assertNull(RoutineRules.intervalMinutes("4"))
        assertNull(RoutineRules.intervalMinutes("1441"))
        assertNull(RoutineRules.intervalMinutes("five"))
    }

    @Test
    fun `a new interval starts one default cadence from now and gets one timeout default`() {
        val now = 1_700_000_000_000L

        assertEquals(
            now + 15 * 60_000L,
            RoutineRules.defaultIntervalAnchor(now),
        )
        assertEquals(
            30,
            RoutineRules.intervalTimeoutOnFirstSelection(null, defaultAlreadyApplied = false),
        )
        assertNull(
            RoutineRules.intervalTimeoutOnFirstSelection(null, defaultAlreadyApplied = true),
            "an existing routine with no timeout must stay at No limit",
        )
        assertEquals(
            45,
            RoutineRules.intervalTimeoutOnFirstSelection(45, defaultAlreadyApplied = true),
        )
    }

    @Test
    fun `a wall-clock time is written zero padded, in 24 hours`() {
        assertEquals("00:00", RoutineRules.timeText(0, 0))
        assertEquals("09:05", RoutineRules.timeText(9, 5))
        assertEquals("23:59", RoutineRules.timeText(23, 59))
    }

    @Test
    fun `a stored time is read back, and a broken one falls back like the Swift`() {
        val now = LocalTime.of(13, 37)

        assertEquals(LocalTime.of(9, 0), RoutineRules.parseTime("09:00", now))
        assertEquals(LocalTime.of(9, 5), RoutineRules.parseTime("9:5", now))
        assertEquals(LocalTime.of(9, 0), RoutineRules.parseTime(null, now), "the default is 09:00")
        assertEquals(LocalTime.of(9, 0), RoutineRules.parseTime("nine", now), "no numbers means 9:00")
        assertEquals(now, RoutineRules.parseTime("99:00", now), "an impossible hour falls to now")
        assertEquals(now, RoutineRules.parseTime("09:88", now))
    }

    @Test
    fun `timeout is optional and only offers valid five-minute choices`() {
        assertEquals(30, RoutineRules.LEGACY_DURATION_MINUTES)
        assertEquals(30, RoutineRules.DEFAULT_INTERVAL_TIMEOUT)
        assertEquals(5, RoutineRules.TIMEOUT_RANGE.first)
        assertEquals(240, RoutineRules.TIMEOUT_RANGE.last)
        assertEquals(5, RoutineRules.TIMEOUT_OPTIONS.first())
        assertEquals(240, RoutineRules.TIMEOUT_OPTIONS.last())
        assertEquals(48, RoutineRules.TIMEOUT_OPTIONS.size)
        assertTrue(RoutineRules.validTimeout(null))
        assertTrue(RoutineRules.validTimeout(5))
        assertTrue(RoutineRules.validTimeout(240))
        assertFalse(RoutineRules.validTimeout(4))
        assertFalse(RoutineRules.validTimeout(241))

        assertFailsWith<IllegalArgumentException> {
            RoutineRules.input(
                name = "Nightly",
                prompt = "Do the thing",
                botId = "bot-1",
                runOn = RoutineRunLocation.MAUS,
                enabled = null,
                schedule = RoutineSchedule.daily("09:00", listOf(1)),
                durationMinutes = RoutineRules.LEGACY_DURATION_MINUTES,
                timeoutMinutes = 4,
            )
        }
    }

    @Test
    fun `the weekday row is Sunday-first, matching the wire's indices`() {
        assertEquals(listOf("S", "M", "T", "W", "T", "F", "S"), RoutineRules.DAY_LETTERS)
        assertEquals("Sunday", RoutineRules.DAY_NAMES.first())
        assertEquals("Saturday", RoutineRules.DAY_NAMES.last())
        assertEquals(setOf(1, 2, 3, 4, 5), RoutineRules.DEFAULT_WEEKDAYS)
    }

    /** An Activity recreation, as the saved state actually sees it. */
    private fun rotate(choice: AgentChoice): AgentChoice {
        val saved = with(AgentChoiceSaver) { SaverScope { true }.save(choice) }
        return requireNotNull(AgentChoiceSaver.restore(requireNotNull(saved)))
    }

    /** Any Unicode space separator reads as a plain space. */
    private fun spacesNormalized(text: String): String = buildString {
        text.forEach {
            append(if (Character.getType(it) == Character.SPACE_SEPARATOR.toInt()) ' ' else it)
        }
    }

    private fun routine(
        id: String = "routine-1",
        enabled: Boolean = true,
        runOn: String = "maus",
        nextRunAt: Double? = null,
        schedule: RoutineSchedule = RoutineSchedule.daily("09:00", listOf(1)),
    ) = Routine(
        id = id,
        name = "Nightly",
        prompt = "Do the thing",
        botId = "bot-1",
        runOn = runOn,
        enabled = enabled,
        schedule = schedule,
        durationMinutes = 30,
        nextRunAt = nextRunAt,
        createdAt = 0.0,
        updatedAt = 0.0,
    )

    private fun run(id: String, scheduledFor: Double) = RoutineRun(
        id = id,
        routineId = "routine-1",
        routineName = "Nightly",
        botId = "bot-1",
        runOn = "maus",
        scheduledFor = scheduledFor,
        status = "completed",
        manual = false,
        createdAt = 0.0,
    )

    private fun instance(driverKind: String, state: String) = Instance(
        instanceId = "instance-$driverKind",
        driverKind = driverKind,
        snapshot = ProviderSnapshot(state = state),
        models = ModelCatalog(defaultModel = "model-1", options = emptyList()),
    )
}
