package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The composer's @mention picker, against the desktop's rules
 * (`src/components/Composer.tsx`, `src/lib/mentions.ts`) and the iOS port:
 * the same words open it, the same names fill it, and a pick writes the same
 * text the harness routes on.
 */
class MentionTest {
    private val pool = listOf(
        MentionChoice(MentionChoice.EVERYONE_ID, "everyone", null),
        MentionChoice("a", "Atlas", "blue"),
        MentionChoice("s", "Six", "green"),
        MentionChoice("n", "New Bot", "pink"),
    )

    @Test
    fun anAtThatStartsAWordOpensAQuery() {
        assertEquals("", ComposerMention.query("@"))
        assertEquals("at", ComposerMention.query("hey @at"))
        assertEquals("Six", ComposerMention.query("line one\n@Six"))
        assertEquals("New Bot", ComposerMention.query("@New Bot"))
    }

    @Test
    fun anAtInsideAWordOrAFinishedTagDoesNot() {
        assertNull(ComposerMention.query("hello"))
        assertNull(ComposerMention.query("mail me at ada@example"), "user@host is not a tag")
        assertNull(ComposerMention.query("@Atlas look at this\nand that"))
        assertNull(ComposerMention.query("@" + "x".repeat(25)))
    }

    @Test
    fun choicesFilterCaseInsensitivelyAndCloseOnACompletedTag() {
        assertEquals(pool, ComposerMention.choices(pool, ""))
        assertEquals(listOf("Six"), ComposerMention.choices(pool, "si").map { it.name })
        assertEquals(listOf("New Bot"), ComposerMention.choices(pool, "BOT").map { it.name })
        assertEquals(emptyList(), ComposerMention.choices(pool, "Six "))
        assertEquals(emptyList(), ComposerMention.choices(pool, "zzz"))
    }

    @Test
    fun pickingReplacesTheQueryWithTheTagAndASpace() {
        val atlas = pool[1]
        assertEquals("ask @Atlas ", ComposerMention.complete("ask @at", atlas))
        assertEquals("@New Bot ", ComposerMention.complete("@", pool[3]))
        assertNull(ComposerMention.complete("no tag here", atlas))
        // The completed draft no longer offers the same bot again.
        val done = requireNotNull(ComposerMention.complete("ask @at", atlas))
        assertEquals(emptyList(), ComposerMention.choicesFor(done, pool))
    }

    @Test
    fun aRoomOffersEveryoneAndItsVisibleMembers() {
        val room = Room(
            "r", "rt", "Team", listOf("b2", "b1", "gone", "b3"),
            GroupResponder("mentions"), "", false, 1.0,
        )
        val bots = listOf(bot("b1", "Atlas"), bot("b2", "Six"), bot("b3", "Ghost", hidden = true), bot("b4", "Outsider"))
        assertEquals(
            listOf("everyone", "Six", "Atlas"),
            ComposerMention.pool(Chat.RoomChat(room), bots).map { it.name },
            "members in room order; hidden, missing and non-members left out",
        )
        assertEquals(
            listOf("Six", "Atlas"),
            ComposerMention.pool(Chat.RoomChat(room.copy(dm = true)), bots).map { it.name },
        )
    }

    @Test
    fun aBotChatOffersEveryOtherVisibleBot() {
        val bots = listOf(bot("b1", "Atlas"), bot("b2", "Six"), bot("b3", "Ghost", hidden = true))
        assertEquals(listOf("Six"), ComposerMention.pool(Chat.BotChat(bots[0]), bots).map { it.name })
    }

    private fun bot(id: String, name: String, hidden: Boolean = false) = Bot(
        id, "t-$id", name, "", "", true, "green", false,
        ModelSelection("engine", "default"), 1.0,
        hidden = hidden,
    )
}
