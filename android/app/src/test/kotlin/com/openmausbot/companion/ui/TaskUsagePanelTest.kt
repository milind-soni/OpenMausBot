package com.openmausbot.companion.ui

import com.openmausbot.companion.core.TaskContextUsage
import com.openmausbot.companion.core.TaskUsage
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals

class TaskUsagePanelTest {
    @Test
    fun separatesCachedUncachedAndOutputTokens() {
        assertEquals(
            listOf(
                "Uncached input: 1,000",
                "Cached input: 9,000",
                "Output: 250",
                "Reported cost: $0.0123",
                "Context: 8,000 / 128,000",
            ),
            taskUsageLines(
                TaskUsage(10_000, 250, 9_000, 0.0123, 2, TaskContextUsage(8_000, 128_000)),
                Locale.US,
            ),
        )
    }

    @Test
    fun unknownCacheAndCostAreNeverPresentedAsZero() {
        assertEquals(
            listOf("Input: 1,200 (cache split unavailable)", "Output: 50"),
            taskUsageLines(TaskUsage(1_200, 50), Locale.US),
        )
        assertEquals(
            listOf("Input: 1,200 (cache split unavailable)", "Output: 50"),
            taskUsageLines(TaskUsage(1_200, 50, cachedInput = 1_300), Locale.US),
        )
    }
}
