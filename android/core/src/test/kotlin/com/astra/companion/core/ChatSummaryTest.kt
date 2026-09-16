package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatSummaryTest {
    @Test
    fun sortsPinnedThenUnreadThenActivityAndHidesHiddenBots() {
        val state = CompanionState(
            bots = listOf(
                sampleBot("hidden", "th", hidden = true, unread = true, pinned = true),
                sampleBot("pinned", "tp", pinned = true, unread = false, at = 10.0),
                sampleBot("unread", "tu", pinned = false, unread = true, at = 5.0),
                sampleBot("old", "to", pinned = false, unread = false, at = 1.0),
                sampleBot("new", "tn", pinned = false, unread = false, at = 20.0),
            ),
            rooms = listOf(
                Room(
                    id = "r1",
                    threadId = "tr",
                    name = "Room",
                    memberIds = listOf("a", "b"),
                    defaultResponder = GroupResponder("bot", "a"),
                    bulletin = "",
                    unread = true,
                    createdAt = 1.0,
                ),
            ),
            messages = mapOf(
                "tp" to listOf(text("m1", 10.0, "pinned preview")),
                "tu" to listOf(text("m2", 5.0, "unread preview")),
                "to" to listOf(text("m3", 1.0, "old preview")),
                "tn" to listOf(text("m4", 20.0, "new preview")),
                "tr" to listOf(
                    Message(
                        id = "m5",
                        role = Message.Role.BOT,
                        kind = Message.Kind.OPTIONS,
                        at = 15.0,
                        card = OptionCard(
                            title = "Allow shell?",
                            subtitle = "",
                            options = listOf("Allow", "Deny"),
                            requestId = "req",
                        ),
                    ),
                ),
            ),
        )

        val summaries = state.chatSummaries()
        // pinned → unread (by activity: room@15 before bot@5) → read (new@20 before old@1)
        assertEquals(
            listOf("pinned", "r1", "unread", "new", "old"),
            summaries.map { it.id },
        )
        assertEquals("Allow shell?", summaries.first { it.id == "r1" }.preview)
        assertEquals(false, summaries.first { it.id == "r1" }.pinned)
        assertTrue(summaries.none { it.id == "hidden" })
    }

    @Test
    fun optionPreviewUsesThePendingQuestionOtherwiseTheTitle() {
        assertEquals(
            "Run the shell command?",
            optionPreview(OptionCard(
                title = "Allow shell?",
                subtitle = "Run the shell command?",
                options = listOf("Allow", "Deny"),
                requestId = "req",
            )),
        )
        assertEquals(
            "Allow shell?",
            optionPreview(OptionCard(
                title = "Allow shell?",
                subtitle = "",
                options = listOf("Allow", "Deny"),
                requestId = "req",
            )),
        )
        assertEquals(
            "   ",
            optionPreview(OptionCard(
                title = "Allow shell?",
                subtitle = "   ",
                options = listOf("Allow", "Deny"),
                requestId = "req",
            )),
        )
        assertEquals(
            "Choose a mode",
            optionPreview(OptionCard(
                title = "Choose a mode",
                subtitle = "Which mode should run?",
                options = listOf("Fast", "Safe"),
                answered = "Safe",
                requestId = "req",
            )),
        )
        assertEquals(
            "Dismissed question",
            optionPreview(OptionCard(
                title = "Dismissed question",
                subtitle = "Question details",
                options = listOf("Allow", "Deny"),
                dismissed = true,
                requestId = "req",
            )),
        )
        assertEquals("", optionPreview(null))
    }

    @Test
    fun previewRulesMatchIos() {
        val textState = CompanionState(
            bots = listOf(sampleBot("b", "t")),
            messages = mapOf("t" to listOf(text("m", 1.0, "hello"))),
        )
        assertEquals("hello", textState.chatSummaries().single().preview)

        val activity = CompanionState(
            bots = listOf(sampleBot("b", "t")),
            messages = mapOf(
                "t" to listOf(
                    Message(
                        id = "m",
                        role = Message.Role.BOT,
                        kind = Message.Kind.ACTIVITY,
                        at = 1.0,
                        tool = ToolActivity(name = "Bash"),
                    ),
                ),
            ),
        )
        assertEquals("Bash", activity.chatSummaries().single().preview)

        val screen = CompanionState(
            bots = listOf(sampleBot("b", "t")),
            messages = mapOf(
                "t" to listOf(
                    Message(
                        id = "m",
                        role = Message.Role.BOT,
                        kind = Message.Kind.SCREEN,
                        at = 1.0,
                    ),
                ),
            ),
        )
        assertEquals("Screenshot", screen.chatSummaries().single().preview)
    }
}

private fun sampleBot(
    id: String,
    threadId: String,
    hidden: Boolean? = null,
    unread: Boolean = false,
    pinned: Boolean? = null,
    at: Double = 0.0,
) = Bot(
    id = id,
    threadId = threadId,
    name = id,
    title = "role",
    description = "",
    notifications = true,
    color = "green",
    unread = unread,
    modelSelection = ModelSelection("i", "m"),
    createdAt = at,
    pinned = pinned,
    hidden = hidden,
)

private fun text(id: String, at: Double, body: String) = Message(
    id = id,
    role = Message.Role.USER,
    kind = Message.Kind.TEXT,
    at = at,
    text = body,
)

private fun optionPreview(card: OptionCard?): String {
    val state = CompanionState(
        bots = listOf(sampleBot("b", "t")),
        messages = mapOf(
            "t" to listOf(Message(
                id = "m",
                role = Message.Role.BOT,
                kind = Message.Kind.OPTIONS,
                at = 1.0,
                card = card,
            )),
        ),
    )
    return state.chatSummaries().single().preview
}
