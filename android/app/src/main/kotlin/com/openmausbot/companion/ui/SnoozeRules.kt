package com.openmausbot.companion.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.nextSnoozeExpiry
import kotlinx.coroutines.delay
import java.util.Calendar

/**
 * The snooze presets behind the thread sheet's clock — `onSnooze` in
 * `SidebarThreadRow.tsx`, worded as `src/locales/en.json` words them.
 */
object SnoozeRules {
    const val UNTIL_NEW_ACTIVITY = "Until new activity"
    const val UNTIL_SIX_PM = "Until 6 PM"
    const val UNTIL_NINE_AM_TOMORROW = "Until 9 AM tomorrow"
    const val STOP_SNOOZING = "Stop snoozing"

    enum class Preset(val label: String) {
        NEW_ACTIVITY(UNTIL_NEW_ACTIVITY),
        SIX_PM(UNTIL_SIX_PM),
        NINE_AM_TOMORROW(UNTIL_NINE_AM_TOMORROW);

        /** Resolve at selection time, even if the menu has been open overnight. */
        fun until(now: Long): Long = when (this) {
            NEW_ACTIVITY -> 0L
            SIX_PM -> sixPm(now)
            NINE_AM_TOMORROW -> nineAmTomorrow(now)
        }
    }

    /**
     * The presets, in the desktop's order: activity first, then time. The
     * sentinel travels as 0; the times are epoch milliseconds.
     */
    val presets: List<Preset> = Preset.entries

    /** Tonight's 6 PM, or tomorrow's once tonight's has already passed. */
    fun sixPm(now: Long): Long = atHour(now, daysAhead = 0, hour = 18, rollPastNow = true)

    /** Tomorrow morning at 9 local: a clean overnight break. */
    fun nineAmTomorrow(now: Long): Long = atHour(now, daysAhead = 1, hour = 9, rollPastNow = false)

    /**
     * Local on purpose: it is the person's evening and the person's morning;
     * the server stores the absolute moment either way.
     */
    private fun atHour(now: Long, daysAhead: Int, hour: Int, rollPastNow: Boolean): Long {
        val calendar = Calendar.getInstance().apply {
            timeInMillis = now
            add(Calendar.DAY_OF_MONTH, daysAhead)
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (rollPastNow && timeInMillis <= now) add(Calendar.DAY_OF_MONTH, 1)
        }
        return calendar.timeInMillis
    }
}

/**
 * A timed snooze ends on the wall clock, not on a server ping: a `now` that
 * re-reads the clock when the nearest expiry passes (`useSnoozeExpiry` in
 * `SidebarThreadRow.tsx`), so a row folds back in without waiting for the
 * next snapshot. The 0 sentinel never ticks and schedules nothing.
 */
@Composable
fun rememberSnoozeNow(tasks: List<BotTask>): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val next = nextSnoozeExpiry(tasks, now)
    LaunchedEffect(next) {
        if (next != null) {
            delay(next - System.currentTimeMillis() + 1)
            now = System.currentTimeMillis()
        }
    }
    return now
}
