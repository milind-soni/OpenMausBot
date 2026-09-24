package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskUsageTest {
    @Test
    fun decodesExistingWireUsageAndOldHostWithoutUsage() {
        val task = CompanionJson.decodeFromString<BotTask>(
            """{"threadId":"t1","title":"Work","createdAt":1,"usage":{"input":1000,"output":80,"cachedInput":750,"costUsd":0.012,"turns":2,"lastTurn":{"input":400,"output":50,"costUsd":null},"context":{"tokens":900,"window":8192}}}""",
        )
        assertEquals(1_000L, task.usage?.input)
        assertEquals(750L, task.usage?.cachedInput)
        assertEquals(80L, task.usage?.output)
        assertEquals(0.012, task.usage?.costUsd)
        assertEquals(8_192L, task.usage?.context?.window)

        val oldTask = CompanionJson.decodeFromString<BotTask>(
            """{"threadId":"t2","title":"Old","createdAt":1}""",
        )
        assertNull(oldTask.usage)
    }
}
