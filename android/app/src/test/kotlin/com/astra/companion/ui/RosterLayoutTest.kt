package com.astra.companion.ui

import com.astra.companion.core.Chat
import com.astra.companion.core.ChatSummary
import com.astra.companion.core.CompanionState
import com.astra.companion.core.Message
import com.astra.companion.core.OptionCard
import com.astra.companion.core.PendingApproval
import com.astra.companion.core.Session
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * DELTA-04: how the roster arranges itself, pinned against
 * `ios/App/ChatListView.swift`.
 *
 * The rules that matter are the ones a screenshot cannot settle: which chats are
 * rows and which are tiles, which rows wear "Waiting on you", what the header's
 * second line says in each connection state, and what Cancel does to a search.
 */
class RosterLayoutTest {

    @Test
    fun `an unsearched roster has nothing to filter, and keeps the strip`() {
        // The screen assembles the unsearched roster from the fleet's own
        // partition — chief, pinned, strips, unsectioned, sections — and asks
        // for rows only once there is a query. So an empty query filters
        // nothing rather than standing for a list the screen never renders.
        val summaries = listOf(botSummary(), roomSummary())
        assertEquals(summaries, RosterLayout.rows(summaries, ""))
        assertTrue(RosterLayout.showsGroups(""))
    }

    @Test
    fun `no bots yet is about bots, because rooms live in the strip`() {
        // What the empty state under an unsearched roster asks.
        assertTrue(RosterLayout.listsAnyBot(listOf(botSummary(), roomSummary())))
        assertFalse(RosterLayout.listsAnyBot(listOf(roomSummary())))
        assertFalse(RosterLayout.listsAnyBot(emptyList()))
    }

    @Test
    fun `a search reaches both kinds, and puts the strip away`() {
        // iOS filters `all` — bots and rooms alike — once the query is not empty.
        val rows = RosterLayout.rows(listOf(botSummary(), roomSummary()), "s")
        assertEquals(listOf("bot-1", "room-1"), rows.map { it.id })
        assertFalse(RosterLayout.showsGroups("s"))
    }

    @Test
    fun `a search matches the name, the role chip and the preview`() {
        val rows = listOf(botSummary(preview = "shipped the release"))
        assertEquals(1, RosterLayout.rows(rows, "Scout").size)
        assertEquals(1, RosterLayout.rows(rows, "research").size)
        assertEquals(1, RosterLayout.rows(rows, "SHIPPED").size)
        assertEquals(0, RosterLayout.rows(rows, "kangaroo").size)
    }

    @Test
    fun `the rows waiting on you are the ones a pending card is in`() {
        // iOS: `Set(pendingApprovals.compactMap { chat(forThread:)?.id })`.
        val state = CompanionState(bots = listOf(bot(), bot(id = "bot-2")), cursor = "s:1")
        val pending = listOf(PendingApproval("thread-bot-2", pendingCardMessage()))
        assertEquals(setOf("bot-2"), RosterLayout.waitingChats(state, pending))
        assertEquals(emptySet(), RosterLayout.waitingChats(state, emptyList()))
    }

    @Test
    fun `an approval on a thread the fleet does not know is dropped, not guessed`() {
        val state = CompanionState(bots = listOf(bot()), cursor = "s:1")
        val pending = listOf(PendingApproval("thread-gone", pendingCardMessage()))
        assertEquals(emptySet(), RosterLayout.waitingChats(state, pending))
    }

    @Test
    fun `a tile stacks its member bots, in the room's own order`() {
        // iOS: `room.memberIds.compactMap { session.state.bot($0) }` — the whole
        // record, because the tile now draws each member's own avatar, and an
        // unresolvable member falls out rather than leaving a hole.
        val state = CompanionState(
            bots = listOf(
                bot(id = "a").copy(color = "red"),
                bot(id = "b").copy(color = "cyan"),
                bot(id = "c").copy(color = "pink", avatarUrl = "/api/attachments/c.png"),
            ),
        )
        val room = room().copy(memberIds = listOf("c", "a", "missing", "b"))
        val members = RosterLayout.memberBots(state, room)
        assertEquals(listOf("c", "a", "b"), members.map { it.id })
        assertEquals(listOf("pink", "red", "cyan"), members.map { it.color })
        assertEquals("/api/attachments/c.png", members.first().avatarUrl)
    }

    @Test
    fun `a hidden member still lends the tile its face`() {
        // The Swift looks the member up in `state.bot(_:)`, which does not care
        // whether the roster hides it.
        val state = CompanionState(bots = listOf(bot(id = "a").copy(color = "teal", hidden = true)))
        assertEquals(
            listOf("teal"),
            RosterLayout.memberBots(state, room().copy(memberIds = listOf("a"))).map { it.color },
        )
    }

    @Test
    fun `the header's second line names the computer and how it is doing`() {
        assertEquals("Studio · connected", RosterLayout.headerSubtitle("Studio", Session.Status.Live))
        assertEquals(
            "Studio · connecting…",
            RosterLayout.headerSubtitle("Studio", Session.Status.Connecting),
        )
        assertEquals(
            "Studio · offline",
            RosterLayout.headerSubtitle("Studio", Session.Status.Offline("No route to the computer")),
        )
        assertEquals(
            "Studio · unpaired",
            RosterLayout.headerSubtitle("Studio", Session.Status.Unauthorized),
        )
    }

    @Test
    fun `unpaired says so and nothing else, even with a name to hand`() {
        // iOS returns the literal "Not paired" for `.unpaired`, ignoring the name.
        assertEquals("Not paired", RosterLayout.headerSubtitle("Studio", Session.Status.Unpaired))
        // With no connection at all, the name itself falls back to the same words.
        assertEquals(
            "Not paired · offline",
            RosterLayout.headerSubtitle(null, Session.Status.Offline("x")),
        )
    }

    @Test
    fun `section headings uppercase by the invariant rules`() {
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"))
            // `text.uppercased()` in Swift is canonical, not localised: a Turkish
            // reader must still see BOTS and CHATS, not a dotted capital I.
            assertEquals("BOTS", RosterLayout.sectionLabel("Bots"))
            assertEquals("GROUPS", RosterLayout.sectionLabel("Groups"))
            assertEquals("CHATS", RosterLayout.sectionLabel("Chats"))
            assertEquals("MESSAGES", RosterLayout.sectionLabel("Messages"))
        } finally {
            Locale.setDefault(original)
        }
    }
}

/**
 * The bottom bar's two faces and the one transition that changes what the list
 * shows — `bottomBar` in `ios/App/ChatListView.swift`.
 */
class RosterBarTest {

    @Test
    fun `the bar starts closed and empty`() {
        val bar = RosterBar()
        assertFalse(bar.searchOpen)
        assertEquals("", bar.query)
    }

    @Test
    fun `opening search keeps whatever was typed`() {
        // iOS's magnifying-glass button sets `searchOpen` and the focus, nothing else.
        val bar = RosterBar(query = "scout").openSearch()
        assertTrue(bar.searchOpen)
        assertEquals("scout", bar.query)
    }

    @Test
    fun `Cancel closes the field and clears the query`() {
        // iOS: `query = ""; searchOpen = false; searchFocused = false`. Clearing
        // the query is what puts the groups strip back and returns the list to
        // bots only, so the two belong to one transition.
        val bar = RosterBar(searchOpen = true, query = "scout").cancelSearch()
        assertFalse(bar.searchOpen)
        assertEquals("", bar.query)
        assertTrue(RosterLayout.showsGroups(bar.query))
    }

    @Test
    fun `the clear button empties the field without closing it`() {
        // iOS's `xmark.circle.fill` sets `query = ""` and nothing else.
        val bar = RosterBar(searchOpen = true, query = "scout").clearQuery()
        assertTrue(bar.searchOpen)
        assertEquals("", bar.query)
    }

    @Test
    fun `typing does not disturb whether the field is open`() {
        assertTrue(RosterBar(searchOpen = true).typed("no").searchOpen)
        assertFalse(RosterBar().typed("no").searchOpen)
    }
}

private fun botSummary(preview: String = ""): ChatSummary =
    ChatSummary(chat = Chat.BotChat(bot()), preview = preview, lastActivity = 2.0, pinned = false)

private fun roomSummary(): ChatSummary =
    ChatSummary(chat = Chat.RoomChat(room()), preview = "", lastActivity = 1.0, pinned = false)

private fun pendingCardMessage(): Message = Message(
    id = "m1",
    role = Message.Role.BOT,
    kind = Message.Kind.OPTIONS,
    at = 1.0,
    card = OptionCard(
        title = "Run a command",
        subtitle = "ls -la",
        options = listOf("Allow", "Deny"),
        requestId = "req-1",
    ),
)
