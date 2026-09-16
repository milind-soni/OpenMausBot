package com.astra.companion.ui

import com.astra.companion.core.Bot
import com.astra.companion.core.CompanionState
import com.astra.companion.core.ModelSelection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class SectionRulesTest {
    @Test
    fun selectableLeavesHiddenBotsOutAndKeepsFleetOrder() {
        val visible = bot("visible")
        val hidden = bot("hidden").copy(hidden = true)
        assertEquals(listOf("visible"), SectionRules.selectable(CompanionState(bots = listOf(visible, hidden))).map(Bot::id))
    }

    @Test
    fun idsFollowRosterOrderAndHonorTheServerLimit() {
        val bots = (0..101).map { bot("b$it") }
        val selected = bots.map(Bot::id).toSet()
        assertEquals((0..99).map { "b$it" }, SectionRules.ids(bots, selected))
    }

    @Test
    fun saveRequiresATrimmedNameWithinTheServerLimitAndABot() {
        assertFalse(SectionRules.canSave("", setOf("b1"), saving = false, chiefConflict = false))
        assertFalse(SectionRules.canSave("   ", setOf("b1"), saving = false, chiefConflict = false))
        assertFalse(SectionRules.canSave("Research", emptySet(), saving = false, chiefConflict = false))
        assertFalse(SectionRules.canSave("Research", (0..100).map { "b$it" }.toSet(), saving = false, chiefConflict = false))
        assertFalse(SectionRules.canSave("x".repeat(61), setOf("b1"), saving = false, chiefConflict = false))
        assertFalse(SectionRules.canSave("Research", setOf("b1"), saving = true, chiefConflict = false))
        assertTrue(SectionRules.canSave(" Research ", setOf("b1"), saving = false, chiefConflict = false))
    }

    @Test
    fun `a chief conflict is what the Save button refuses, not the server`() {
        assertFalse(
            SectionRules.canSave("Research", setOf("b1"), saving = false, chiefConflict = true),
            "the guard exists so the phone answers before the request is sent",
        )
    }

    @Test
    fun `two selected chiefs cannot share one section`() {
        val bots = listOf(chief("a"), chief("b"), bot("plain"))
        assertTrue(SectionRules.hasChiefConflict(bots, setOf("a", "b"), "Research"))
    }

    @Test
    fun `a chief moving beside a different incumbent is a conflict`() {
        val bots = listOf(chief("moving"), chief("incumbent").copy(section = "Research"))
        assertTrue(SectionRules.hasChiefConflict(bots, setOf("moving"), "Research"))
        // A different destination has no incumbent, so the same move is fine.
        assertFalse(SectionRules.hasChiefConflict(bots, setOf("moving"), "Ops"))
    }

    @Test
    fun `one chief in total is never a conflict, wherever it is`() {
        val bots = listOf(chief("only"), bot("plain"))
        assertFalse(SectionRules.hasChiefConflict(bots, setOf("only"), "Research"))
        assertFalse(SectionRules.hasChiefConflict(bots, setOf("plain"), "Research"))
        // The incumbent moving into the section it already occupies is one id.
        val settled = listOf(chief("only").copy(section = "Research"))
        assertFalse(SectionRules.hasChiefConflict(settled, setOf("only"), "Research"))
    }

    @Test
    fun `a selection without chiefs never conflicts`() {
        val bots = listOf(bot("a"), bot("b").copy(section = "Research"))
        assertFalse(SectionRules.hasChiefConflict(bots, setOf("a", "b"), "Research"))
    }

    @Test
    fun `the destination is matched on the trimmed name, and an empty one has no incumbent`() {
        val bots = listOf(chief("moving"), chief("incumbent").copy(section = "  Research  "))
        assertTrue(SectionRules.hasChiefConflict(bots, setOf("moving"), "  Research "))
        // Nothing typed yet: an unfiled chief is not the incumbent of "nothing".
        val unfiled = listOf(chief("moving"), chief("floating"))
        assertFalse(SectionRules.hasChiefConflict(unfiled, setOf("moving"), "   "))
    }

    @Test
    fun `a pinned bot in the selection is what earns the pinned note`() {
        val bots = listOf(bot("plain"), bot("pinned").copy(pinned = true), chief("chief").copy(pinned = true))
        assertFalse(SectionRules.hasPinnedSelection(bots, setOf("plain")))
        assertTrue(SectionRules.hasPinnedSelection(bots, setOf("pinned")))
        // A pinned Chief is drawn as the Chief, so it is not what this note is about.
        assertFalse(SectionRules.hasPinnedSelection(bots, setOf("chief")))
    }

    @Test
    fun `an existing heading is one a bot or a channel already carries`() {
        val state = CompanionState(
            bots = listOf(bot("b").copy(section = " Research ")),
            rooms = listOf(room("r").copy(section = "Ops")),
        )
        assertEquals(setOf("Research", "Ops"), SectionRules.existingSections(state))
        assertTrue(SectionRules.joinsExistingSection(state, "Research"))
        assertTrue(SectionRules.joinsExistingSection(state, "Ops"))
        assertFalse(SectionRules.joinsExistingSection(state, "New"))
        assertFalse(SectionRules.joinsExistingSection(state, "   "))
    }

    @Test
    fun `a heading only a hidden bot carries is not one this sheet knows`() {
        // The sheet cannot show, select, or file that bot, so telling the typist
        // the name "adds to an existing section" would point at a section that
        // never appears. iOS reads its already-filtered `bots` for exactly this.
        val state = CompanionState(bots = listOf(bot("ghost").copy(hidden = true, section = "Archive")))

        assertEquals(emptySet<String>(), SectionRules.existingSections(state))
        assertFalse(
            SectionRules.joinsExistingSection(state, "Archive"),
            "a hidden bot's heading was offered as an existing section",
        )
    }

    @Test
    fun `a visible bot in the same state still carries its heading`() {
        // The filter is about hidden bots, not about the lookup: the same call
        // must still find a heading someone can actually see.
        val state = CompanionState(
            bots = listOf(bot("ghost").copy(hidden = true, section = "Archive"), bot("seen").copy(section = "Ops")),
        )

        assertEquals(setOf("Ops"), SectionRules.existingSections(state))
        assertTrue(SectionRules.joinsExistingSection(state, "Ops"))
    }

    @Test
    fun `leaving is refused only while a save is in flight`() {
        // `assignSection` cannot be recalled once it is sent, so the scrim, the
        // drag and the Cancel button all ask this before they let the sheet go.
        assertFalse(SectionRules.canDismiss(saving = true))
        assertTrue(SectionRules.canDismiss(saving = false))
    }

    @Test
    fun `the hundred-and-first mark is refused rather than sent`() {
        val full = (0 until SectionRules.MAX_BOTS).map { "b$it" }.toSet()
        assertSame(full, SectionRules.toggle(full, "one-too-many"))
        assertEquals(full - "b0", SectionRules.toggle(full, "b0"), "unmarking is always allowed")
        assertEquals(setOf("b1"), SectionRules.toggle(emptySet(), "b1"))
    }

    private fun bot(id: String) = Bot(
        id = id,
        threadId = "thread-$id",
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "blue",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
    )

    private fun chief(id: String) = bot(id).copy(chiefOfStaff = true)
}
