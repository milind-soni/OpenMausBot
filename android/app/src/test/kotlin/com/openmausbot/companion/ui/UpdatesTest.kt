package com.openmausbot.companion.ui

import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.PendingApproval
import com.openmausbot.companion.core.ToolActivity
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * DELTA-02: the Updates derivation, pinned against `ios/App/Updates.swift`.
 *
 * Every expectation here is the literal value that file's rules produce — the
 * dedup order, the three kinds, and the two line functions, which are not the
 * roster's preview and must not drift into it.
 */
class UpdatesTest {
    @Test
    fun `a bot that is idle and read is not an update`() {
        val state = CompanionState(
            bots = listOf(bot()),
            messages = mapOf("thread-bot-1" to listOf(text("m1", "all done"))),
        )
        assertEquals(emptyList(), state.updates)
    }

    @Test
    fun `a stopped bot leads, carrying its card and the card's subtitle`() {
        val state = CompanionState(
            bots = listOf(bot()),
            messages = mapOf("thread-bot-1" to listOf(options("m1", pendingCard()))),
        )
        val update = state.updates.single()
        assertEquals("bot:bot-1:thread-bot-1", update.id)
        assertEquals(UpdateKind.NEEDS_YOU, update.kind)
        assertEquals("ls -la", update.line)
        assertEquals(listOf("Allow", "Deny"), assertNotNull(update.card).options)
    }

    @Test
    fun `an empty subtitle stays empty rather than falling back to the title`() {
        val state = CompanionState(
            bots = listOf(bot()),
            messages = mapOf(
                "thread-bot-1" to listOf(options("m1", pendingCard().copy(subtitle = ""))),
            ),
        )
        assertEquals("", state.updates.single().line)
    }

    @Test
    fun `one update per chat — the newest approval heads it and the rest are dropped`() {
        val state = CompanionState(
            bots = listOf(bot()),
            messages = mapOf(
                "thread-bot-1" to listOf(
                    options("m1", pendingCard().copy(subtitle = "older ask"), at = 1.0),
                    options("m2", pendingCard().copy(subtitle = "newer ask"), at = 2.0),
                ),
            ),
        )
        val update = state.updates.single()
        assertEquals(UpdateKind.NEEDS_YOU, update.kind)
        assertEquals("newer ask", update.line)
    }

    @Test
    fun `a bot that stopped while working is only listed as needing you`() {
        val state = CompanionState(
            bots = listOf(bot(busy = true).copy(unread = true)),
            messages = mapOf("thread-bot-1" to listOf(options("m1", pendingCard()))),
        )
        assertEquals(listOf(UpdateKind.NEEDS_YOU), state.updates.map { it.kind })
    }

    @Test
    fun `a hidden bot is never working or waiting to be reviewed`() {
        val state = CompanionState(
            bots = listOf(
                bot(id = "bot-1", busy = true).copy(hidden = true),
                bot(id = "bot-2").copy(hidden = true, unread = true),
            ),
        )
        assertEquals(emptyList(), state.updates)
    }

    @Test
    fun `a hidden bot that stopped still needs you, as on iOS`() {
        // The needs-you pass runs over pendingApprovals, which `:core` builds
        // from every bot and room thread — hidden or not. Only the two passes
        // below it skip hidden bots.
        val state = CompanionState(
            bots = listOf(bot().copy(hidden = true)),
            messages = mapOf("thread-bot-1" to listOf(options("m1", pendingCard()))),
        )
        assertEquals(listOf(UpdateKind.NEEDS_YOU), state.updates.map { it.kind })
    }

    @Test
    fun `each sibling keeps its own activity title and transcript`() {
        val state = CompanionState(
            bots = listOf(bot(name = "Pepper").copy(
                tasks = listOf(
                    BotTask("thread-bot-1", "Gmail", 0.0, activity = "waiting-on-you", busy = true),
                    BotTask("icloud", "iCloud", 1.0, busy = true),
                    BotTask("queued", "Outlook", 2.0, activity = "queued", unread = true),
                    BotTask("done", "Calendar", 3.0, unread = true),
                ),
            )),
            streaming = mapOf("icloud" to "Sorting the iCloud inbox"),
            messages = mapOf("done" to listOf(text("done-1", "Calendar is ready"))),
        )

        val updates = state.updates
        assertEquals(listOf("thread-bot-1", "icloud", "queued", "done"), updates.map { it.chat.threadId })
        assertEquals(listOf("Gmail", "iCloud", "Outlook", "Calendar"), updates.map { it.chat.threadTitle })
        assertEquals(listOf("Pepper", "Pepper", "Pepper", "Pepper"), updates.map { it.chat.name })
        assertEquals(
            listOf(UpdateKind.NEEDS_YOU, UpdateKind.WORKING, UpdateKind.WORKING, UpdateKind.TO_REVIEW),
            updates.map { it.kind },
        )
        assertEquals(
            listOf("Waiting on you", "Sorting the iCloud inbox", "Queued — waiting for an available slot", "Calendar is ready"),
            updates.map { it.line },
        )
        assertEquals(4, updates.map { it.id }.toSet().size)
    }

    @Test
    fun `newest approval dedup is per thread and preserves the addressed card`() {
        val state = CompanionState(
            bots = listOf(bot(busy = true).copy(
                tasks = listOf(
                    BotTask("thread-bot-1", "Gmail", 0.0, busy = true),
                    BotTask("icloud", "iCloud", 1.0, busy = true),
                    BotTask("working", "Website", 2.0, busy = true),
                ),
            )),
            messages = mapOf(
                "thread-bot-1" to listOf(
                    options("old", pendingCard().copy(requestId = "old"), at = 1.0),
                    options("gmail", pendingCard().copy(requestId = "gmail"), at = 3.0),
                ),
                "icloud" to listOf(options("icloud", pendingCard().copy(requestId = "icloud"), at = 2.0)),
            ),
        )

        val updates = state.updates
        assertEquals(listOf("thread-bot-1", "icloud", "working"), updates.map { it.chat.threadId })
        assertEquals(listOf("gmail", "icloud", null), updates.map { it.card?.requestId })
        assertEquals(listOf(UpdateKind.NEEDS_YOU, UpdateKind.NEEDS_YOU, UpdateKind.WORKING), updates.map { it.kind })
        assertEquals(3, updates.map { it.id }.toSet().size)
    }

    @Test
    fun `internal routine runs stay hidden until an explicit approval needs an answer`() {
        val state = CompanionState(
            bots = listOf(bot().copy(
                threadId = "internal",
                busy = true,
                unread = true,
                tasks = listOf(
                    BotTask("internal", "Internal run", 0.0, busy = true, unread = true, routineRunId = "run-1"),
                    BotTask("result", "Routine result", 1.0, unread = true),
                ),
            )),
        )
        assertEquals(listOf("result"), state.updates.map { it.chat.threadId })

        val needsAnswer = state.copy(messages = mapOf("internal" to listOf(options("ask", pendingCard()))))
        assertEquals(listOf("internal", "result"), needsAnswer.updates.map { it.chat.threadId })
        assertEquals("Internal run", needsAnswer.updates.first().chat.threadTitle)
        assertEquals(UpdateKind.NEEDS_YOU, needsAnswer.updates.first().kind)
        assertNotNull(needsAnswer.updates.first().card)
    }

    @Test
    fun `an explicit empty task catalog does not resurrect the owner's stale activity`() {
        val state = CompanionState(bots = listOf(bot(busy = true).copy(unread = true, tasks = emptyList())))
        assertEquals(emptyList(), state.updates)
    }

    @Test
    fun `an answered card is not an update`() {
        val state = CompanionState(
            bots = listOf(bot()),
            messages = mapOf(
                "thread-bot-1" to listOf(options("m1", pendingCard().copy(answered = "Allow"))),
            ),
        )
        assertEquals(emptyList(), state.updates)
    }

    @Test
    fun `a working bot reads out the live turn, tail first and on one line`() {
        val live = "a".repeat(100) + "\n" + "b".repeat(50)
        val state = CompanionState(
            bots = listOf(bot(busy = true)),
            streaming = mapOf("thread-bot-1" to live),
        )
        // 151 characters in, the last 120 begin 31 'a's from the end of the run.
        assertEquals("a".repeat(69) + " " + "b".repeat(50), state.updates.single().line)
    }

    @Test
    fun `the tail is counted in characters, the way Swift counts them`() {
        // A Swift String is a collection of Character — extended grapheme
        // clusters — so `suffix(120)` of a 120-character line is that line back,
        // whole. Counting UTF-16 units instead would drop the high surrogate and
        // start the line on half an emoji.
        // U+1F600 GRINNING FACE: one character, two code units.
        val grin = "\uD83D\uDE00"
        val emoji = grin + "a".repeat(119)
        assertEquals(emoji, workingLine(emoji))

        // One character longer, and the emoji goes whole rather than in halves.
        assertEquals("a".repeat(120), workingLine(grin + "a".repeat(120)))

        // e + U+0301: the combining acute belongs to the letter it sits on.
        val combining = "e\u0301" + "b".repeat(119)
        assertEquals(combining, workingLine(combining))
    }

    private fun workingLine(live: String): String = CompanionState(
        bots = listOf(bot(busy = true)),
        streaming = mapOf("thread-bot-1" to live),
    ).updates.single().line

    @Test
    fun `a working bot with no live text names the tool it is running`() {
        val state = CompanionState(
            bots = listOf(bot(busy = true)),
            messages = mapOf("thread-bot-1" to listOf(activity("m1", "Bash"))),
        )
        assertEquals("Bash", state.updates.single().line)
    }

    @Test
    fun `an empty live turn falls through to the transcript`() {
        val state = CompanionState(
            bots = listOf(bot(busy = true)),
            messages = mapOf("thread-bot-1" to listOf(activity("m1", "Bash"))),
            streaming = mapOf("thread-bot-1" to ""),
        )
        assertEquals("Bash", state.updates.single().line)
    }

    @Test
    fun `a working bot with nothing to say says so`() {
        val quiet = CompanionState(bots = listOf(bot(busy = true)))
        assertEquals("Working…", quiet.updates.single().line)

        // An activity without a tool is not a name, so it is not a line either.
        val toolless = CompanionState(
            bots = listOf(bot(busy = true)),
            messages = mapOf(
                "thread-bot-1" to listOf(
                    Message(id = "m1", role = Message.Role.BOT, kind = Message.Kind.ACTIVITY, at = 1.0),
                ),
            ),
        )
        assertEquals("Working…", toolless.updates.single().line)

        // The last message being text does not make it a working line either.
        val talked = CompanionState(
            bots = listOf(bot(busy = true)),
            messages = mapOf("thread-bot-1" to listOf(text("m1", "hello"))),
        )
        assertEquals("Working…", talked.updates.single().line)
    }

    @Test
    fun `an unread bot reads out its last message, by kind`() {
        val cases = listOf(
            text("m1", "the invoice is filed") to "the invoice is filed",
            // Answered: a card still pending would make this a needs-you instead.
            options("m1", pendingCard().copy(answered = "Allow")) to "Run a command",
            activity("m1", "Bash") to "Bash",
            screen("m1") to "Screenshot",
            unknown("m1", "something new") to "something new",
        )
        for ((message, expected) in cases) {
            val state = CompanionState(
                bots = listOf(bot().copy(unread = true)),
                messages = mapOf("thread-bot-1" to listOf(message)),
            )
            val update = state.updates.single()
            assertEquals(UpdateKind.TO_REVIEW, update.kind)
            assertEquals(expected, update.line, "kind ${message.kind}")
        }
    }

    @Test
    fun `an unread bot with an empty thread has no line`() {
        val state = CompanionState(bots = listOf(bot().copy(unread = true)))
        assertEquals("", state.updates.single().line)
    }

    @Test
    fun `the review line reads a card's title, not the subtitle the roster shows`() {
        val state = CompanionState(
            bots = listOf(bot().copy(unread = true)),
            messages = mapOf(
                "thread-bot-1" to listOf(
                    options("m1", pendingCard().copy(answered = "Allow", subtitle = "ls -la")),
                ),
            ),
        )
        assertEquals("Run a command", state.updates.single().line)
    }

    @Test
    fun `the lines follow the branch the chat is actually on`() {
        val state = CompanionState(
            bots = listOf(bot().copy(unread = true, activeLeafId = "m2")),
            messages = mapOf(
                "thread-bot-1" to listOf(
                    text("m1", "root"),
                    text("m2", "the branch you are reading").copy(parentId = "m1"),
                    text("m3", "the branch you are not").copy(parentId = "m1"),
                ),
            ),
        )
        assertEquals("the branch you are reading", state.updates.single().line)
    }

    @Test
    fun `a room is working while a member holds it, and busy beats unread`() {
        val state = CompanionState(
            rooms = listOf(room().copy(busyBotId = "bot-2", unread = true)),
            messages = mapOf("thread-room-1" to listOf(activity("m1", "Read"))),
        )
        val update = state.updates.single()
        assertEquals("room:room-1:thread-room-1", update.id)
        assertEquals(UpdateKind.WORKING, update.kind)
        assertEquals("Read", update.line)
    }

    @Test
    fun `a room nobody is holding is to review while it is unread`() {
        val state = CompanionState(
            rooms = listOf(room().copy(unread = true)),
            messages = mapOf("thread-room-1" to listOf(text("m1", "standup notes"))),
        )
        val update = state.updates.single()
        assertEquals(UpdateKind.TO_REVIEW, update.kind)
        assertEquals("standup notes", update.line)
    }

    @Test
    fun `a busy bot beats its own unread flag`() {
        val state = CompanionState(bots = listOf(bot(busy = true).copy(unread = true)))
        assertEquals(UpdateKind.WORKING, state.updates.single().kind)
    }

    @Test
    fun `the three kinds group in order, and each kind keeps the order it was built in`() {
        val state = CompanionState(
            bots = listOf(
                bot(id = "bot-1").copy(unread = true),
                bot(id = "bot-2", busy = true),
                bot(id = "bot-3").copy(unread = true),
                bot(id = "bot-4"),
            ),
            rooms = listOf(room(id = "room-1").copy(busyBotId = "bot-2")),
            messages = mapOf(
                "thread-bot-4" to listOf(options("m1", pendingCard())),
            ),
        )
        assertEquals(
            listOf("bot-4", "bot-2", "room-1", "bot-1", "bot-3"),
            state.updates.map { it.chat.id },
        )
        assertEquals(
            listOf(
                UpdateKind.NEEDS_YOU,
                UpdateKind.WORKING,
                UpdateKind.WORKING,
                UpdateKind.TO_REVIEW,
                UpdateKind.TO_REVIEW,
            ),
            state.updates.map { it.kind },
        )
    }

    @Test
    fun `an approval on a thread the fleet does not know is skipped`() {
        val state = CompanionState(bots = listOf(bot()))
        val ghost = PendingApproval("thread-ghost", options("m1", pendingCard()))
        assertEquals(emptyList(), state.updates(listOf(ghost)))
    }

    @Test
    fun `handing the approvals in changes nothing about the answer`() {
        val state = CompanionState(
            bots = listOf(bot(id = "bot-1").copy(unread = true), bot(id = "bot-2", busy = true)),
            rooms = listOf(room().copy(unread = true)),
            messages = mapOf("thread-bot-1" to listOf(options("m1", pendingCard()))),
        )
        assertEquals(state.updates, state.updates(state.pendingApprovals))
        assertTrue(state.updates.isNotEmpty())
    }
}

/** The words the pill and the sheet put around the derivation. */
class UpdatesSummaryTest {
    private fun update(kind: UpdateKind, name: String, line: String) = ChatUpdate(
        chat = Chat.BotChat(bot(name = name)),
        kind = kind,
        line = line,
    )

    @Test
    fun `nothing active reads as quiet`() {
        assertEquals("All quiet", UpdatesSummary.headline(emptyList()))
        assertEquals("Nothing needs you", UpdatesSummary.subline(emptyList()))
        assertEquals("All quiet", UpdatesSummary.count(emptyList()))
    }

    @Test
    fun `the headline names the first chat and what it is doing`() {
        assertEquals(
            "Scout needs you",
            UpdatesSummary.headline(listOf(update(UpdateKind.NEEDS_YOU, "Scout", ""))),
        )
        assertEquals(
            "Ada is working",
            UpdatesSummary.headline(listOf(update(UpdateKind.WORKING, "Ada", ""))),
        )
        assertEquals(
            "Iris has an update",
            UpdatesSummary.headline(listOf(update(UpdateKind.TO_REVIEW, "Iris", ""))),
        )
    }

    @Test
    fun `the subline is the one line while it is alone, and a count once it is not`() {
        val first = update(UpdateKind.NEEDS_YOU, "Scout", "may I run ls")
        val second = update(UpdateKind.WORKING, "Ada", "Bash")
        val third = update(UpdateKind.TO_REVIEW, "Iris", "done")

        assertEquals("may I run ls", UpdatesSummary.subline(listOf(first)))
        assertEquals("1 more update", UpdatesSummary.subline(listOf(first, second)))
        assertEquals("2 more updates", UpdatesSummary.subline(listOf(first, second, third)))
    }

    @Test
    fun `a lone update with nothing to say still holds the line's height`() {
        assertEquals(" ", UpdatesSummary.subline(listOf(update(UpdateKind.WORKING, "Ada", ""))))
    }

    @Test
    fun `the sheet counts what is active`() {
        val one = update(UpdateKind.WORKING, "Ada", "")
        assertEquals("1 active", UpdatesSummary.count(listOf(one)))
        assertEquals("2 active", UpdatesSummary.count(listOf(one, one)))
    }

    @Test
    fun `the sections are named the way iOS names them`() {
        assertEquals("Needs you", UpdatesSummary.section(UpdateKind.NEEDS_YOU))
        assertEquals("Working", UpdatesSummary.section(UpdateKind.WORKING))
        assertEquals("To review", UpdatesSummary.section(UpdateKind.TO_REVIEW))
        assertEquals(3, UpdatesSummary.MASCOTS)
    }

    @Test
    fun `the heading is uppercased canonically, not for the reader's locale`() {
        val reader = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag("tr-TR"))
        try {
            // Swift's `uppercased()` is the canonical transform; a localised one
            // would put a dot on the capital I and read WORKİNG here.
            assertEquals("NEEDS YOU", UpdatesSummary.sectionLabel(UpdateKind.NEEDS_YOU))
            assertEquals("WORKING", UpdatesSummary.sectionLabel(UpdateKind.WORKING))
            assertEquals("TO REVIEW", UpdatesSummary.sectionLabel(UpdateKind.TO_REVIEW))
        } finally {
            Locale.setDefault(reader)
        }
    }
}

private fun text(id: String, body: String, at: Double = 1.0) = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.TEXT,
    at = at,
    text = body,
)

private fun unknown(id: String, body: String) = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.UNKNOWN,
    at = 1.0,
    text = body,
)

private fun options(id: String, card: OptionCard, at: Double = 1.0) = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.OPTIONS,
    at = at,
    card = card,
)

private fun activity(id: String, tool: String) = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.ACTIVITY,
    at = 1.0,
    tool = ToolActivity(name = tool),
)

private fun screen(id: String) = Message(
    id = id,
    role = Message.Role.BOT,
    kind = Message.Kind.SCREEN,
    at = 1.0,
)

private fun pendingCard() = OptionCard(
    title = "Run a command",
    subtitle = "ls -la",
    options = listOf("Allow", "Deny"),
    requestId = "req-1",
    tool = "shell",
)
