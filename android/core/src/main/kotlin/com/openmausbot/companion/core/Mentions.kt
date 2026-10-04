package com.openmausbot.companion.core

/**
 * The composer's @mention picker, ported from iOS `Mentions.swift`.
 *
 * The harness routes on the text alone (`mentionedBots` in server/store.ts),
 * so a tag typed by hand already works — when it is spelled exactly. The
 * picker is what makes that practical on a phone: the names are offered, and
 * the keyboard's corrections never get a chance at them. The rules mirror the
 * desktop composer (`src/components/Composer.tsx`, `src/lib/mentions.ts`).
 *
 * The query is measured to the end of the draft, as on iOS: a tag is typed
 * where the text is being written.
 */
data class MentionChoice(
    val id: String,
    val name: String,
    /** The bot's palette name; null for @everyone. */
    val color: String?,
) {
    val isEveryone: Boolean get() = id == EVERYONE_ID

    companion object {
        const val EVERYONE_ID = "__everyone__"
    }
}

object ComposerMention {
    /** The desktop's limit, in the same UTF-16 units Kotlin strings count. */
    private const val MAX_QUERY = 24

    /** The text after an `@` that starts a word, up to the end of the draft; null while no tag is being typed. */
    fun query(draft: String): String? {
        val at = draft.lastIndexOf('@')
        if (at == -1) return null
        // user@host, not a tag
        if (at > 0 && !draft[at - 1].isWhitespace()) return null
        val query = draft.substring(at + 1)
        if (query.length > MAX_QUERY || query.any { it == '\n' || it == '\r' }) return null
        return query
    }

    /** The pool, filtered by what has been typed. A completed tag ("@Six ") is not a new search, so it closes the picker. */
    fun choices(pool: List<MentionChoice>, query: String): List<MentionChoice> {
        val normalized = query.trim().lowercase()
        if (query.endsWith(" ") && pool.any { it.name.lowercase() == normalized }) return emptyList()
        return pool.filter { normalized.isEmpty() || it.name.lowercase().contains(normalized) }
    }

    fun choicesFor(draft: String, pool: List<MentionChoice>): List<MentionChoice> {
        val query = query(draft) ?: return emptyList()
        return choices(pool, query)
    }

    /** The draft with the tag being typed replaced by the chosen name and a space; null when no tag is being typed. */
    fun complete(draft: String, choice: MentionChoice): String? {
        if (query(draft) == null) return null
        return draft.substring(0, draft.lastIndexOf('@')) + "@" + choice.name + " "
    }

    /**
     * Who can be tagged here. A room offers @everyone (not in a DM) and its
     * members; a bot's chat offers every other bot, which it reaches through
     * ask_bot. Hidden bots are skipped, as the harness skips them.
     */
    fun pool(chat: Chat, bots: List<Bot>): List<MentionChoice> = when (chat) {
        is Chat.RoomChat -> {
            val everyone = if (chat.room.dm == true) emptyList() else listOf(MentionChoice(MentionChoice.EVERYONE_ID, "everyone", null))
            val members = chat.room.memberIds.mapNotNull { id -> bots.firstOrNull { it.id == id && it.hidden != true } }
            everyone + members.map(::choice)
        }
        is Chat.BotChat -> bots.filter { it.id != chat.bot.id && it.hidden != true }.map(::choice)
    }

    private fun choice(bot: Bot) = MentionChoice(bot.id, bot.name, bot.color)
}
