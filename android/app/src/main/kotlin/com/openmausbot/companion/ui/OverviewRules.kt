package com.openmausbot.companion.ui

/**
 * "What this bot does", as rules — the copy behind [BotOverviewScreen].
 *
 * Everything the screen shows is server-authored prose (`who`, `does`,
 * `reaches`, `wont`, `recent`): there is nothing here to validate or compute,
 * only what to say. Section names and the empty-state copy for `does` and
 * `recent` match `ios/App/BotOverviewView.swift` — `reaches` and `wont` carry
 * no empty-state copy there either, so an empty list there is simply a header
 * with nothing under it, on both phones.
 */
object OverviewRules {
    fun title(name: String): String = "What $name does"

    const val EMPTY_DOES: String = "Nothing scheduled or learned yet."
    const val EMPTY_RECENT: String = "No changes recorded yet."
    const val FAILED: String = "Couldn't load the overview."

    const val WHO: String = "Who"
    const val DOES: String = "Does"
    const val REACHES: String = "Can reach"
    const val WONT: String = "Won't"
    const val RECENT: String = "Recent changes"
}
