package com.astra.companion.ui

import com.astra.companion.core.Chat
import com.astra.companion.core.CompanionState
import com.astra.companion.core.Message
import com.astra.companion.core.OptionCard
import com.astra.companion.core.ToolActivity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Which face a bot wears, in the desktop's order: a pinned expression, then a
 * failure, then work, then unread, then a question, then its role. The order is
 * the point — it is what makes "this one stopped and needs you" louder than "this
 * one is busy", so each rung is tested against the one below it.
 *
 * Ported alongside `ios/App/MascotState.swift`; a divergence here is a bot wearing
 * one face on the laptop and another on the phone.
 */
class MascotStateTest {
    private val idle = bot(title = "", name = "Bot")

    @Test
    fun `a pinned expression wins over everything the bot is doing`() {
        val pinned = idle.copy(
            mascotExpression = "celebrate",
            busy = true,
            unread = true,
        )
        assertEquals(AstraState.CELEBRATE, AstraState.forBot(pinned, failedActivity))
    }

    @Test
    fun `the desktop's legacy expression names still resolve`() {
        assertEquals(AstraState.IDLE, AstraState.normalize("deadpan"))
        assertEquals(AstraState.HAPPY, AstraState.normalize("friendly"))
        assertEquals(AstraState.WORKING, AstraState.normalize("focused"))
        assertEquals(AstraState.THINKING, AstraState.normalize("thinking"))
        assertEquals(AstraState.EXCITED, AstraState.normalize("excited"))
        assertEquals(AstraState.DROWSY, AstraState.normalize("sleepy"))
        assertEquals(AstraState.SURPRISED, AstraState.normalize("surprised"))
        assertEquals(AstraState.SUSPICIOUS, AstraState.normalize("skeptical"))
        assertEquals(AstraState.SCARED, AstraState.normalize("worried"))
        assertEquals(AstraState.PLAYFUL, AstraState.normalize("mischievous"))
    }

    @Test
    fun `every current expression name resolves to itself`() {
        for (state in AstraState.entries) {
            assertEquals(state, AstraState.normalize(state.id), state.id)
        }
    }

    @Test
    fun `an unknown or missing expression is not a pin`() {
        assertNull(AstraState.normalize(null))
        assertNull(AstraState.normalize(""))
        assertNull(AstraState.normalize("smouldering"))
        // and so the bot falls through to the rest of the ladder
        assertEquals(
            AstraState.WORKING,
            AstraState.forBot(idle.copy(mascotExpression = "smouldering", busy = true), null),
        )
    }

    @Test
    fun `a failed tool beats being busy`() {
        val busy = idle.copy(busy = true, unread = true)
        assertEquals(AstraState.ALERTING, AstraState.forBot(busy, failedActivity))
    }

    @Test
    fun `an activity that did not fail is not an alert`() {
        val ok = message(Message.Kind.ACTIVITY, tool = ToolActivity(name = "grep", ok = true))
        val unknown = message(Message.Kind.ACTIVITY, tool = ToolActivity(name = "grep"))
        assertEquals(AstraState.IDLE, AstraState.forBot(idle, ok))
        assertEquals(AstraState.IDLE, AstraState.forBot(idle, unknown))
    }

    @Test
    fun `a failure only counts on an activity`() {
        val text = message(Message.Kind.TEXT, tool = ToolActivity(name = "grep", ok = false))
        assertEquals(AstraState.IDLE, AstraState.forBot(idle, text))
    }

    @Test
    fun `busy beats unread`() {
        assertEquals(AstraState.WORKING, AstraState.forBot(idle.copy(busy = true, unread = true), null))
    }

    @Test
    fun `unread beats a question waiting on you`() {
        assertEquals(AstraState.NOTIFYING, AstraState.forBot(idle.copy(unread = true), optionsCard))
    }

    @Test
    fun `a question waiting on you beats the bot's role`() {
        val researcher = bot(title = "research", name = "Bot")
        assertEquals(AstraState.SEARCHING, AstraState.forBot(researcher, null))
        assertEquals(AstraState.CURIOUS, AstraState.forBot(researcher, optionsCard))
    }

    @Test
    fun `the role is read from name, title and description alike`() {
        assertEquals(AstraState.WORKING, AstraState.forBot(idle.copy(name = "Debug"), null))
        assertEquals(AstraState.WORKING, AstraState.forBot(idle.copy(title = "engineer"), null))
        assertEquals(AstraState.WORKING, AstraState.forBot(idle.copy(description = "writes software"), null))
    }

    @Test
    fun `each role wears the desktop's face for it`() {
        assertEquals(AstraState.WORKING, roleFace("engineering"))
        assertEquals(AstraState.SEARCHING, roleFace("investigate"))
        assertEquals(AstraState.EXCITED, roleFace("campaign"))
        assertEquals(AstraState.DROWSY, roleFace("overnight"))
        assertEquals(AstraState.RADAR, roleFace("uptime"))
        assertEquals(AstraState.SUSPICIOUS, roleFace("qa"))
        assertEquals(AstraState.SCARED, roleFace("compliance"))
        assertEquals(AstraState.PLAYFUL, roleFace("illustration"))
        assertEquals(AstraState.HAPPY, roleFace("onboarding"))
    }

    @Test
    fun `the first matching role wins, in the desktop's order`() {
        // "security" is checked before "design", and "code" before either
        assertEquals(AstraState.SCARED, roleFace("security design"))
        assertEquals(AstraState.WORKING, roleFace("code security design"))
    }

    @Test
    fun `a role matches whole words only`() {
        assertEquals(AstraState.IDLE, roleFace("codebase"))
        assertEquals(AstraState.IDLE, roleFace("aqua"))
        assertEquals(AstraState.SUSPICIOUS, roleFace("runs qa, mostly"))
        assertEquals(AstraState.DROWSY, roleFace("long-running errands"))
    }

    @Test
    fun `a bot with nothing to go on is idle`() {
        assertEquals(AstraState.IDLE, AstraState.forBot(idle, null))
    }

    @Test
    fun `a room always looks happy`() {
        val state = CompanionState(rooms = listOf(room()))
        assertEquals(AstraState.HAPPY, AstraState.forChat(Chat.RoomChat(room()), state))
    }

    @Test
    fun `a chat is resolved from its last visible message`() {
        val waiting = idle.copy(id = "bot-1")
        val state = CompanionState(
            bots = listOf(waiting),
            messages = mapOf(waiting.threadId to listOf(message(Message.Kind.TEXT), optionsCard)),
        )
        assertEquals(AstraState.CURIOUS, AstraState.forChat(Chat.BotChat(waiting), state))
    }

    @Test
    fun `a chat with no transcript still resolves`() {
        val state = CompanionState(bots = listOf(idle))
        assertEquals(AstraState.IDLE, AstraState.forChat(Chat.BotChat(idle), state))
    }

    private fun roleFace(description: String): AstraState =
        AstraState.forBot(idle.copy(description = description), null)

    private val failedActivity = message(
        Message.Kind.ACTIVITY,
        tool = ToolActivity(name = "shell", ok = false),
    )

    private val optionsCard = message(
        Message.Kind.OPTIONS,
        card = OptionCard(title = "Deploy?", subtitle = "", options = listOf("Yes"), requestId = "r1"),
    )

    private fun message(
        kind: Message.Kind,
        tool: ToolActivity? = null,
        card: OptionCard? = null,
    ) = Message(
        id = "m-${kind.name}-${tool?.ok}",
        role = Message.Role.BOT,
        kind = kind,
        at = 0.0,
        tool = tool,
        card = card,
    )
}
