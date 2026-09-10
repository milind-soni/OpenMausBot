package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.GroupResponder
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.ModelSelection
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.Reaction
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.target
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Regression for the cold-start notification tap: an empty pre-hydrate state is
 * "not yet", not "deleted". Concluding the latter popped the chat screen the
 * instant it opened, so the tap led back to the roster.
 */
class ThreadResolutionTest {
    private val hydratedEmpty = CompanionState(cursor = "stream-1:12")

    @Test
    fun `an empty state before the first hello is not an answer`() {
        assertEquals(
            ThreadResolution.Result.Waiting,
            ThreadResolution.resolve(CompanionState(), "thread-bot-1"),
        )
        assertNull(ThreadResolution.chatOrNull(CompanionState(), "thread-bot-1"))
    }

    @Test
    fun `a hydrated fleet without the thread means it is gone`() {
        assertEquals(
            ThreadResolution.Result.Gone,
            ThreadResolution.resolve(hydratedEmpty, "thread-bot-1"),
        )
    }

    @Test
    fun `a cursor is not the only proof of hydration`() {
        // A stream resumed from a cursor that was never committed still has bots.
        val withBots = CompanionState(bots = listOf(bot()))
        assertEquals(
            ThreadResolution.Result.Gone,
            ThreadResolution.resolve(withBots, "thread-missing"),
        )
        assertTrue(ThreadResolution.hydrated(withBots))
        assertFalse(ThreadResolution.hydrated(CompanionState()))
    }

    @Test
    fun `a known bot thread resolves to its chat`() {
        val state = CompanionState(bots = listOf(bot()), cursor = "stream-1:1")
        val resolved = ThreadResolution.resolve(state, "thread-bot-1")
        assertEquals(Chat.BotChat(bot()), (resolved as ThreadResolution.Result.Open).chat)
    }

    @Test
    fun `a remote task switch keeps the original task open`() {
        val tasks = listOf(
            BotTask(threadId = "thread-bot-1", title = "First", createdAt = 0.0),
            BotTask(threadId = "thread-two", title = "Second", createdAt = 1.0),
        )
        // The chat was opened on the bot's first task.
        val before = CompanionState(bots = listOf(bot().copy(tasks = tasks)), cursor = "s:1")
        assertEquals(
            "thread-bot-1",
            ThreadResolution.chatOrNull(before, "thread-bot-1")?.threadId,
        )

        // A desktop switch moves its pointer, not this phone's destination.
        val after = CompanionState(
            bots = listOf(bot().copy(threadId = "thread-two", tasks = tasks)),
            cursor = "s:2",
        )
        val resolved = ThreadResolution.resolve(after, "thread-bot-1")
        assertTrue(resolved is ThreadResolution.Result.Open, "resolved to $resolved")
        assertEquals("thread-bot-1", (resolved as ThreadResolution.Result.Open).chat.threadId)
        assertEquals("bot-1", resolved.chat.id)
    }

    @Test
    fun `a thread belonging to no bot's tasks is still gone`() {
        val state = CompanionState(
            bots = listOf(
                bot().copy(
                    tasks = listOf(BotTask("thread-bot-1", "First", 0.0)),
                ),
            ),
            cursor = "s:1",
        )
        assertEquals(ThreadResolution.Result.Gone, ThreadResolution.resolve(state, "thread-alien"))
    }

    @Test
    fun `the open thread wins over a task list that also contains it`() {
        // Two bots, one of which lists the other's thread — the live owner wins.
        val state = CompanionState(
            bots = listOf(
                bot(id = "bot-2").copy(
                    threadId = "thread-shared",
                    tasks = listOf(BotTask("thread-shared", "Mine", 0.0)),
                ),
                bot(id = "bot-1").copy(
                    threadId = "thread-elsewhere",
                    tasks = listOf(BotTask("thread-shared", "Stale", 0.0)),
                ),
            ),
            cursor = "s:1",
        )
        assertEquals("bot-2", ThreadResolution.chatOrNull(state, "thread-shared")?.id)
    }

    @Test
    fun `a known room thread resolves to its chat`() {
        val state = CompanionState(rooms = listOf(room()), cursor = "stream-1:1")
        assertEquals(
            Chat.RoomChat(room()),
            ThreadResolution.chatOrNull(state, "thread-room-1"),
        )
    }
}

/** The local task stays addressed by both owner and thread, including deletion. */
class ConversationResolutionTest {
    private val hydrated = "stream-1:1"

    @Test
    fun `deleting the open task closes it without choosing another`() {
        val bot = bot().copy(
            threadId = "task-2",
            tasks = listOf(BotTask("task-1", "First", 0.0), BotTask("task-2", "Second", 1.0)),
        )
        val opened = Destination.Chat(Chat.BotChat(bot).target)

        // The desktop deleted task-2, the one on screen, and selected task-1.
        val after = CompanionState(
            bots = listOf(bot.copy(threadId = "task-1", tasks = listOf(BotTask("task-1", "First", 0.0)))),
            cursor = hydrated,
        )

        val resolved = ThreadResolution.resolve(after, opened)
        assertEquals(ThreadResolution.Result.Gone, resolved)
    }

    @Test
    fun `a bot that was removed closes the chat`() {
        val opened = Destination.Chat(Chat.BotChat(bot()).target)
        val after = CompanionState(bots = listOf(bot(id = "bot-2")), cursor = hydrated)
        assertEquals(ThreadResolution.Result.Gone, ThreadResolution.resolve(after, opened))
    }

    @Test
    fun `a restored stack waits for the fleet rather than closing itself`() {
        val opened = Destination.Chat(Chat.BotChat(bot()).target)
        assertEquals(
            ThreadResolution.Result.Waiting,
            ThreadResolution.resolve(CompanionState(), opened),
        )
    }

    @Test
    fun `an addressed chat never picks another owner that holds the same thread`() {
        val opened = Destination.Chat(ChatTarget.Bot("bot-1", "thread-shared"))
        val state = CompanionState(
            bots = listOf(
                bot(id = "bot-2").copy(
                    threadId = "thread-shared",
                    tasks = listOf(BotTask("thread-shared", "Mine", 0.0)),
                ),
            ),
            cursor = hydrated,
        )
        assertEquals(ThreadResolution.Result.Gone, ThreadResolution.resolve(state, opened))
    }

    @Test
    fun `a room is addressed by its own id`() {
        val opened = Destination.Chat(Chat.RoomChat(room()).target)
        val state = CompanionState(rooms = listOf(room()), cursor = hydrated)
        assertEquals(
            Chat.RoomChat(room()),
            (ThreadResolution.resolve(state, opened) as ThreadResolution.Result.Open).chat,
        )
        assertEquals(
            ThreadResolution.Result.Gone,
            ThreadResolution.resolve(CompanionState(rooms = emptyList(), cursor = hydrated), opened),
        )
    }

    @Test
    fun `a notification resolves to its exact task and owner`() {
        val bot = bot().copy(
            threadId = "task-1",
            tasks = listOf(BotTask("task-1", "First", 0.0), BotTask("task-2", "Second", 1.0)),
        )
        val state = CompanionState(bots = listOf(bot), cursor = hydrated)

        val resolved = ThreadResolution.resolve(state, Destination.Thread("task-2"))
        assertTrue(resolved is ThreadResolution.Result.Open, "resolved to $resolved")
        assertEquals(
            ChatTarget.Bot("bot-1", "task-2"),
            (resolved as ThreadResolution.Result.Open).chat.target,
        )
    }
}

class TranscriptLayoutTest {
    private fun message(id: String, at: Double) = Message(
        id = id,
        role = Message.Role.BOT,
        kind = Message.Kind.TEXT,
        at = at,
    )

    @Test
    fun `the first message always opens a stretch`() {
        assertTrue(TranscriptLayout.startsNewStretch(listOf(message("a", 0.0)), 0))
    }

    @Test
    fun `messages closer than thirty minutes share a stretch`() {
        val messages = listOf(message("a", 0.0), message("b", 29 * 60 * 1000.0))
        assertFalse(TranscriptLayout.startsNewStretch(messages, 1))
    }

    @Test
    fun `exactly thirty minutes is not yet a gap`() {
        val messages = listOf(message("a", 0.0), message("b", 30 * 60 * 1000.0))
        assertFalse(TranscriptLayout.startsNewStretch(messages, 1))
    }

    @Test
    fun `more than thirty minutes opens a new stretch`() {
        val messages = listOf(message("a", 0.0), message("b", 30 * 60 * 1000.0 + 1))
        assertTrue(TranscriptLayout.startsNewStretch(messages, 1))
    }

    @Test
    fun `an index past the end is not a stretch`() {
        assertFalse(TranscriptLayout.startsNewStretch(listOf(message("a", 0.0)), 4))
    }
}

class SearchPolicyTest {
    @Test
    fun `one character never reaches the computer`() {
        assertEquals(SearchPolicy.Decision.Clear, SearchPolicy.decide(""))
        assertEquals(SearchPolicy.Decision.Clear, SearchPolicy.decide("a"))
        assertEquals(SearchPolicy.Decision.Clear, SearchPolicy.decide("  a  "))
    }

    @Test
    fun `two characters do, and the raw query is what is sent`() {
        assertEquals(SearchPolicy.Decision.Remote("ab"), SearchPolicy.decide("ab"))
        assertEquals(SearchPolicy.Decision.Remote(" ab "), SearchPolicy.decide(" ab "))
    }

    @Test
    fun `the debounce matches the desktop`() {
        assertEquals(250L, SearchPolicy.DEBOUNCE_MILLIS)
        assertEquals(2, SearchPolicy.MIN_LENGTH)
    }

    @Test
    fun `local filtering looks at name, role chip and preview`() {
        val summary = summary(name = "Scout", title = "research", preview = "found the invoice")
        assertTrue(SearchPolicy.matches(summary, "sco"))
        assertTrue(SearchPolicy.matches(summary, "RESEARCH"))
        assertTrue(SearchPolicy.matches(summary, "invoice"))
        assertFalse(SearchPolicy.matches(summary, "zebra"))
    }

    @Test
    fun `an empty query keeps everything`() {
        val all = listOf(summary("Scout", "research", "x"), summary("Ada", "builds", "y"))
        assertEquals(all, SearchPolicy.filter(all, ""))
    }

    private fun summary(name: String, title: String, preview: String) = ChatSummary(
        chat = Chat.BotChat(bot(name = name, title = title)),
        preview = preview,
        lastActivity = 0.0,
        pinned = false,
    )
}

class ApprovalChoicesTest {
    @Test
    fun `the conventional label wins when the card offers it`() {
        assertEquals("Allow", ApprovalChoices.allowChoice(listOf("Allow", "Deny")))
        assertEquals("allow", ApprovalChoices.allowChoice(listOf("Deny", "allow")))
    }

    @Test
    fun `otherwise the first option that is not the refusal`() {
        assertEquals("Approve", ApprovalChoices.allowChoice(listOf("Approve", "Deny")))
        assertEquals("Yes", ApprovalChoices.allowChoice(listOf("Deny", "Yes", "Maybe")))
    }

    @Test
    fun `a card offering only a refusal has no allow choice`() {
        assertNull(ApprovalChoices.allowChoice(listOf("Deny")))
        assertNull(ApprovalChoices.allowChoice(emptyList()))
    }

    @Test
    fun `deny is the refusal, case-insensitively and after trimming`() {
        // `OptionCard.isRefusal` in `ios/Sources/CompanionCore/Models.swift`
        // trims `.whitespacesAndNewlines` before comparing, so padding is not a
        // different answer.
        for (deny in listOf("Deny", "DENY", " deny ", "\nDeNy\t", "\r\ndeny")) {
            assertTrue(ApprovalChoices.isRefusal(deny), deny)
        }
        assertFalse(ApprovalChoices.isRefusal("Decline"))
        assertFalse(ApprovalChoices.isRefusal("Deny once"))
    }

    @Test
    fun `a padded refusal is not mistaken for the allow choice`() {
        assertEquals("Approve", ApprovalChoices.allowChoice(listOf(" deny ", "Approve")))
        assertNull(ApprovalChoices.allowChoice(listOf(" deny ", "\nDENY\n")))
    }

    @Test
    fun `always allow needs a key from the card and a bot to hang it on`() {
        val withKey = card(allowKey = "shell:ls")
        val withoutKey = card(allowKey = null)
        assertTrue(ApprovalChoices.showsAlwaysAllow(withKey, Chat.BotChat(bot())))
        assertFalse(ApprovalChoices.showsAlwaysAllow(withoutKey, Chat.BotChat(bot())))
        // A room shows the card but never a standing grant (§12).
        assertFalse(ApprovalChoices.showsAlwaysAllow(withKey, Chat.RoomChat(room())))
    }

    @Test
    fun `an answered card offers no standing grant`() {
        val answered = card(allowKey = "shell:ls").copy(answered = "Allow")
        assertFalse(ApprovalChoices.showsAlwaysAllow(answered, Chat.BotChat(bot())))
        assertNull(ApprovalChoices.alwaysAllowChoice(answered))
    }

    // The standing grant answers with one of the card's own options — for a
    // permission card as much as for a question. `ios/App/ChatView.swift` builds
    // that button's choice from `allowChoice` alone and shows it only when
    // `allowChoice` exists; nothing is fabricated for a card that offered no way
    // to say yes.

    @Test
    fun `always allow answers with an option the card offered`() {
        val expected = mapOf(
            listOf("Allow", "Deny") to "Allow",
            listOf("allow", "Deny") to "allow",
            listOf("Approve", "Deny") to "Approve",
            listOf("Always allow", "Allow once", "Deny") to "Always allow",
            listOf("Yes", "No") to "Yes",
        )
        for ((options, choice) in expected) {
            assertEquals(
                choice,
                ApprovalChoices.alwaysAllowChoice(
                    card(allowKey = "shell:ls").copy(options = options),
                ),
                "options $options",
            )
        }
    }

    @Test
    fun `a card that offered no way to say yes hides the standing grant`() {
        for (options in listOf(listOf("Deny"), listOf(" deny "), emptyList())) {
            val card = card(allowKey = "shell:ls").copy(options = options)
            assertNull(ApprovalChoices.alwaysAllowChoice(card), "options $options")
            assertFalse(ApprovalChoices.showsAlwaysAllow(card, Chat.BotChat(bot())), "options $options")
        }
    }

    @Test
    fun `a question card may only answer with one of its own options`() {
        val question = OptionCard(
            title = "Which branch?",
            subtitle = "",
            options = listOf("main", "Deny"),
            requestId = "req-1",
            tool = null,
            allowKey = "question:1",
        )
        assertEquals("main", ApprovalChoices.alwaysAllowChoice(question))
        assertNull(ApprovalChoices.alwaysAllowChoice(question.copy(options = listOf("Deny"))))
    }

    private fun card(allowKey: String?) = OptionCard(
        title = "Run a command",
        subtitle = "ls -la",
        options = listOf("Allow", "Deny"),
        requestId = "req-1",
        tool = "shell",
        allowKey = allowKey,
    )
}

class ReactionsTest {
    @Test
    fun `reactions group by emoji, sorted, with yours flagged`() {
        val grouped = Reactions.group(
            listOf(
                Reaction("👍", "user"),
                Reaction("👍", "bot-1"),
                Reaction("🎉", "bot-1"),
            ),
        )
        assertEquals(2, grouped.size)
        val thumbs = grouped.first { it.emoji == "👍" }
        assertEquals(2, thumbs.count)
        assertTrue(thumbs.mine)
        assertFalse(grouped.first { it.emoji == "🎉" }.mine)
    }

    @Test
    fun `the five choices match the desktop`() {
        assertEquals(listOf("👍", "❤️", "😂", "🎉", "👀"), Reactions.CHOICES)
    }
}

internal fun bot(
    id: String = "bot-1",
    name: String = "Scout",
    title: String = "research",
    busy: Boolean? = null,
) = Bot(
    id = id,
    threadId = "thread-$id",
    name = name,
    title = title,
    description = "",
    notifications = true,
    color = "green",
    unread = false,
    modelSelection = ModelSelection("instance-1", "model-1"),
    createdAt = 0.0,
    busy = busy,
)

internal fun room(id: String = "room-1") = Room(
    id = id,
    threadId = "thread-$id",
    name = "Standup",
    memberIds = listOf("bot-1", "bot-2"),
    defaultResponder = GroupResponder("auto"),
    bulletin = "",
    unread = false,
    createdAt = 0.0,
)

/** GAP-03: the role a hit carries must survive into what the row shows. */
class SearchHitRoleTest {
    @Test
    fun `a user hit and a bot hit are told apart`() {
        assertTrue(SearchHitRole.isFromUser(Message.Role.USER))
        assertFalse(SearchHitRole.isFromUser(Message.Role.BOT))
    }

    @Test
    fun `the glyph carries a description, because it carries meaning`() {
        assertEquals("Your message", SearchHitRole.contentDescription(Message.Role.USER, "Scout"))
        assertEquals(
            "Message from Scout",
            SearchHitRole.contentDescription(Message.Role.BOT, "Scout"),
        )
    }

    @Test
    fun `an unknown role is attributed to the bot, never to you`() {
        // Message.Role decodes anything unrecognised as BOT (§8), and the row
        // must not claim you said something you did not.
        assertFalse(SearchHitRole.isFromUser(Message.Role.BOT))
    }
}

/** GAP-05: the refusal is the one option that does not get accent weight. */
class OptionEmphasisTest {
    @Test
    fun `deny is secondary, case-insensitively and after trimming`() {
        for (deny in listOf("Deny", "deny", "DENY", "DeNy", " deny ", "\nDeNy\t")) {
            assertEquals(OptionEmphasis.SECONDARY, ApprovalChoices.emphasis(deny), deny)
        }
    }

    @Test
    fun `the tint and the answer read the same refusal`() {
        // A padded refusal must not be drawn with accent weight while
        // `OptionCard.responseBehavior` puts it on the wire as a deny.
        for (option in listOf("Deny", " deny ", "\nDENY\n", "Approve", " Approve ")) {
            val secondary = ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY
            val denied = OptionCard.responseBehavior(option, isPermission = true) == "deny"
            assertEquals(denied, secondary, option)
        }
    }

    @Test
    fun `everything else keeps accent weight`() {
        for (option in listOf("Allow", "allow", "Approve", "Yes", "Allow once", "Deny once")) {
            assertEquals(OptionEmphasis.PRIMARY, ApprovalChoices.emphasis(option), option)
        }
    }

    @Test
    fun `the same isRefusal drives both the choice and the styling`() {
        val options = listOf("Approve", "Deny")
        val allow = ApprovalChoices.allowChoice(options)
        assertEquals("Approve", allow)
        // The option that means "go ahead" is the one drawn with accent weight.
        assertEquals(OptionEmphasis.PRIMARY, ApprovalChoices.emphasis(allow!!))
        assertEquals(
            OptionEmphasis.SECONDARY,
            ApprovalChoices.emphasis(options.first { ApprovalChoices.isRefusal(it) }),
        )
    }

    @Test
    fun `a card with no refusal draws every option the same`() {
        for (option in listOf("Yes", "Later")) {
            assertEquals(OptionEmphasis.PRIMARY, ApprovalChoices.emphasis(option))
        }
    }
}

/** GAP-04: what the Copy action puts on the clipboard. */
class MessageActionsTest {
    private fun message(
        kind: Message.Kind,
        text: String? = null,
        card: OptionCard? = null,
    ) = Message(id = "m1", role = Message.Role.BOT, kind = kind, at = 0.0, text = text, card = card)

    @Test
    fun `settled text is copyable`() {
        assertEquals("ls -la", MessageActions.copyableText(message(Message.Kind.TEXT, "ls -la")))
    }

    @Test
    fun `copy and selection text omit attachment transport paths`() {
        val attached = message(
            Message.Kind.TEXT,
            """Please review this.
<attached-file path="/Users/alice/private/report.md" name="report.md" />""",
        )

        assertEquals("Please review this.", MessageActions.copyableText(attached))
        assertFalse(MessageActions.copyableText(attached).orEmpty().contains("/Users/alice"))
    }

    @Test
    fun `an attachment-only message offers no raw transport text to copy`() {
        val attached = message(
            Message.Kind.TEXT,
            """<attached-image path="C:\\Users\\alice\\secret.png" name="secret.png" />""",
        )

        assertNull(MessageActions.copyableText(attached))
    }

    @Test
    fun `an unknown kind carrying text is copyable, like it is renderable`() {
        assertEquals("hello", MessageActions.copyableText(message(Message.Kind.UNKNOWN, "hello")))
    }

    @Test
    fun `empty or absent text offers nothing`() {
        assertNull(MessageActions.copyableText(message(Message.Kind.TEXT, null)))
        assertNull(MessageActions.copyableText(message(Message.Kind.TEXT, "   ")))
    }

    @Test
    fun `an approval card copies what it is asking to do`() {
        val card = OptionCard(
            title = "Run a command",
            subtitle = "rm -rf build",
            options = listOf("Allow", "Deny"),
            requestId = "r1",
            tool = "shell",
        )
        assertEquals(
            "Run a command\n\nrm -rf build",
            MessageActions.copyableText(message(Message.Kind.OPTIONS, card = card)),
        )
    }

    @Test
    fun `a card with only a subtitle copies just that`() {
        val card = OptionCard(title = "", subtitle = "Which branch?", options = listOf("main"))
        assertEquals(
            "Which branch?",
            MessageActions.copyableText(message(Message.Kind.OPTIONS, card = card)),
        )
    }

    @Test
    fun `a tool chip and a screenshot offer nothing to copy`() {
        assertNull(MessageActions.copyableText(message(Message.Kind.ACTIVITY, "shell")))
        assertNull(MessageActions.copyableText(message(Message.Kind.SCREEN)))
    }

    @Test
    fun `plain user text can be edited but attachment messages cannot`() {
        val plain = Message(
            id = "plain",
            role = Message.Role.USER,
            kind = Message.Kind.TEXT,
            at = 0.0,
            text = "Try this again",
        )
        val attached = plain.copy(
            id = "attached",
            text = """Try this again
<attached-file path="/Users/alice/private/report.md" name="report.md" />""",
        )

        assertEquals("Try this again", MessageActions.editableText(plain))
        assertNull(MessageActions.editableText(attached))
        assertNull(MessageActions.editableText(plain.copy(role = Message.Role.BOT)))
    }
}
