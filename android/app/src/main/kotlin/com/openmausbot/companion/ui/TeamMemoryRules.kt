package com.openmausbot.companion.ui

import com.openmausbot.companion.core.TeamMemoryEntry

/**
 * Team memory, as rules — the copy behind [TeamMemoryScreen]. The screen
 * shows what the computer stores: proposals waiting for a tap, then the
 * accepted entries by kind. Matches `ios/App/TeamMemoryView.swift`.
 */
object TeamMemoryRules {
    const val PROFILE_ROW: String = "Team memory"
    const val WAITING: String = "Waiting for you"
    const val REMEMBER: String = "Remember"
    const val SKIP: String = "Skip"
    const val ADD: String = "Add an entry"
    const val FAILED: String = "Couldn't load team memory."
    const val EMPTY: String =
        "Nothing shared yet. Bots add entries as they learn who is who and where things live, or add one below."

    /** Section order and titles, one per kind the computer knows. */
    val KINDS: List<Pair<String, String>> = listOf(
        "person" to "People",
        "place" to "Places",
        "decision" to "Decisions",
        "term" to "Terms",
    )

    fun title(label: String?): String = if (label.isNullOrBlank()) "Team memory" else "$label team memory"

    fun proposed(entries: List<TeamMemoryEntry>): List<TeamMemoryEntry> = entries.filter { it.status == "proposed" }

    fun accepted(entries: List<TeamMemoryEntry>, kind: String): List<TeamMemoryEntry> =
        entries.filter { it.status == "accepted" && it.kind == kind }

    /** "Ada Lovelace (also Ada)" */
    fun heading(entry: TeamMemoryEntry): String =
        if (entry.aliases.isEmpty()) entry.name else "${entry.name} (also ${entry.aliases.joinToString(", ")})"

    /** Who said it: the bot, or "you" for an entry added by hand. */
    fun attribution(entry: TeamMemoryEntry): String = entry.source.botName.ifBlank { "you" }
}
