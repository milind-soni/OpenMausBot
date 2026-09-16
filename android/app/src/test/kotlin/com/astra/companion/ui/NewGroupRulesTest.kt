package com.astra.companion.ui

import com.astra.companion.core.CompanionState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * DELTA-01: who a group can be made from and in what order, pinned against
 * `ios/App/NewGroupSheet.swift`.
 *
 * The name is not tested here on purpose — the rule that a blank one is left out
 * of the request lives in `:core`'s `Client.createRoom`, and this screen's job is
 * to hand the field over untouched so the harness can name the room after its
 * first member.
 */
class NewGroupRulesTest {
    private val fleet = CompanionState(
        bots = listOf(
            bot(id = "bot-1", name = "Scout"),
            bot(id = "bot-2", name = "Ada").copy(hidden = true),
            bot(id = "bot-3", name = "Iris"),
            bot(id = "bot-4", name = "Mo"),
        ),
    )

    @Test
    fun `the picker offers every bot that is not hidden, in roster order`() {
        assertEquals(listOf("bot-1", "bot-3", "bot-4"), NewGroupRules.selectable(fleet).map { it.id })
    }

    @Test
    fun `a fleet of only hidden bots offers nobody`() {
        val hidden = CompanionState(bots = listOf(bot(id = "bot-1").copy(hidden = true)))
        assertEquals(emptyList(), NewGroupRules.selectable(hidden))
    }

    @Test
    fun `members go out in the order they were listed, not the order they were tapped`() {
        val bots = NewGroupRules.selectable(fleet)
        // Tapped bottom-up; the request still leads with the topmost pick, which
        // is the one the harness names the room after.
        val tapped = linkedSetOf("bot-4", "bot-1")
        assertEquals(listOf("bot-1", "bot-4"), NewGroupRules.members(bots, tapped))
    }

    @Test
    fun `a selection the picker never offered is not sent`() {
        val bots = NewGroupRules.selectable(fleet)
        assertEquals(listOf("bot-3"), NewGroupRules.members(bots, setOf("bot-2", "bot-3")))
    }

    @Test
    fun `nothing selected sends nothing`() {
        assertEquals(emptyList(), NewGroupRules.members(NewGroupRules.selectable(fleet), emptySet()))
    }

    @Test
    fun `create needs at least one member`() {
        assertFalse(NewGroupRules.canCreate(emptySet(), creating = false))
        assertTrue(NewGroupRules.canCreate(setOf("bot-1"), creating = false))
        assertTrue(NewGroupRules.canCreate(setOf("bot-1", "bot-3"), creating = false))
    }

    @Test
    fun `create goes quiet while a room is already being made`() {
        assertFalse(NewGroupRules.canCreate(setOf("bot-1"), creating = true))
    }

    @Test
    fun `a selection the fleet has dropped still leaves create lit, as on iOS`() {
        // `NewGroupSheet.swift:67` disables Create on the raw set and recomputes
        // the members only at press time, so a pick that has left the fleet keeps
        // the button lit over a request that goes out empty. Pinned as the source
        // behaves, not as this port would prefer.
        val bots = NewGroupRules.selectable(fleet)
        assertEquals(emptyList(), NewGroupRules.members(bots, setOf("bot-2")))
        assertTrue(NewGroupRules.canCreate(setOf("bot-2"), creating = false))
    }
}
