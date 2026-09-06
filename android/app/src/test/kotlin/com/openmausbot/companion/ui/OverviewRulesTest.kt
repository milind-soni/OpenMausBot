package com.openmausbot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * "What this bot does" — the one piece of copy [OverviewRules] computes
 * rather than states outright. The rest of the object is constants, pinned
 * here only insofar as [BotOverviewScreen] reads them by name.
 */
class OverviewRulesTest {
    @Test
    fun `the title names the bot`() {
        assertEquals("What Maus does", OverviewRules.title("Maus"))
    }
}
