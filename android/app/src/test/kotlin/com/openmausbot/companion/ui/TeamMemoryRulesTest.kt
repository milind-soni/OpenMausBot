package com.openmausbot.companion.ui

import com.openmausbot.companion.core.TeamMemoryEntry
import com.openmausbot.companion.core.TeamMemorySource
import kotlin.test.Test
import kotlin.test.assertEquals

class TeamMemoryRulesTest {
    private fun entry(kind: String, name: String, status: String = "accepted", aliases: List<String> = emptyList(), bot: String = "") =
        TeamMemoryEntry(
            id = name.lowercase(), kind = kind, name = name, detail = "d", aliases = aliases, status = status,
            source = TeamMemorySource(botId = "", botName = bot, threadId = "", at = 1.0), updatedAt = 1.0,
        )

    @Test
    fun splitsProposalsFromAcceptedEntriesByKind() {
        val entries = listOf(entry("person", "Ada", status = "proposed"), entry("term", "MCHQ"), entry("place", "Plan"))
        assertEquals(listOf("Ada"), TeamMemoryRules.proposed(entries).map { it.name })
        assertEquals(listOf("MCHQ"), TeamMemoryRules.accepted(entries, "term").map { it.name })
        assertEquals(emptyList(), TeamMemoryRules.accepted(entries, "decision"))
    }

    @Test
    fun namesTheSectionAndTheSpeakerLikeIos() {
        assertEquals("Work team memory", TeamMemoryRules.title("Work"))
        assertEquals("Team memory", TeamMemoryRules.title(null))
        assertEquals("Ada Lovelace (also Ada)", TeamMemoryRules.heading(entry("person", "Ada Lovelace", aliases = listOf("Ada"))))
        assertEquals("you", TeamMemoryRules.attribution(entry("term", "MCHQ")))
        assertEquals("Scout", TeamMemoryRules.attribution(entry("term", "MCHQ", bot = "Scout")))
        assertEquals(listOf("person", "place", "decision", "term"), TeamMemoryRules.KINDS.map { it.first })
    }
}
