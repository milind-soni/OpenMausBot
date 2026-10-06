package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The phone's short form of an approval card: headline, summary line, Details,
 * and the settled verdict in words. Mirrors `ios/Tests/CompanionCoreTests/ApprovalCardTests.swift`.
 */
class ApprovalCardTest {
    /** The subtitle the computer writes for two held Linear comments: heading, then raw arguments. */
    private val linearSubtitle = """
        Linear · Create linear comment
        {"issueId":"2f04bc73","body":"**In flight** — open PR"}… [arguments truncated]

        Linear · Create linear comment
        {"issueId":"1c2755f","body":"Adjacent request from Discord"}… [arguments truncated]
    """.trimIndent()

    private val linear = OutboundCall("Linear", "Create linear comment")

    private fun outbound(
        calls: List<OutboundCall>?,
        subtitle: String = linearSubtitle,
        answered: String? = null,
    ) = OptionCard(
        title = "Send on your behalf?",
        subtitle = subtitle,
        options = listOf("Allow", "Deny"),
        requestId = "req",
        tool = "LINEAR_CREATE_LINEAR_COMMENT",
        held = "This sends something on your behalf, so it always asks first.",
        heldCode = "approval.held.outbound",
        outboundRequest = OutboundRequest("LINEAR_CREATE_LINEAR_COMMENT", "Linear", calls),
        answered = answered,
    )

    private fun decode(json: String): OptionCard = CompanionJson.decodeFromString(OptionCard.serializer(), json)

    // Decoding

    @Test
    fun `decodes outbound calls and the markers that pick a layout`() {
        val card = decode(
            """{"title":"Send on your behalf?","subtitle":"Linear · Create linear comment","options":["Allow","Deny"],
               "requestId":"r","tool":"LINEAR_CREATE_LINEAR_COMMENT","held":"x","heldCode":"approval.held.outbound",
               "outboundRequest":{"tool":"LINEAR_CREATE_LINEAR_COMMENT","app":"Linear","calls":[{"app":"Linear","label":"Create linear comment"}]}}""",
        )
        assertEquals(listOf(linear), card.outboundRequest?.calls)
        assertEquals("approval.held.outbound", card.heldCode)
        assertEquals(CardPresentation.OUTBOUND, card.presentation)

        val memory = decode(
            """{"title":"Remember this for the team?","subtitle":"Person: Ana","options":["Remember","Skip"],
               "requestId":"m","tool":"propose_team_memory","teamMemoryRequest":{"section":"s","entryId":"m","kind":"person"}}""",
        )
        assertNotNull(memory.teamMemoryRequest)
        assertEquals(CardPresentation.STANDARD, memory.presentation)

        val permission = decode(
            """{"title":"Approval needed","subtitle":"git push","options":["Allow","Deny"],"requestId":"p","requestType":"permission","tool":"Bash"}""",
        )
        assertEquals(CardPresentation.APPROVAL, permission.presentation)
    }

    @Test
    fun `an older card without calls still decodes and is read from its subtitle`() {
        val card = decode(
            """{"title":"Send on your behalf?","subtitle":"Gmail · Send email","options":["Allow","Deny"],
               "requestId":"r","outboundRequest":{"tool":"GMAIL_SEND_EMAIL","app":"Gmail"}}""",
        )
        assertNull(card.outboundRequest?.calls)
        assertEquals(listOf(OutboundCall("Gmail", "Send email")), card.outboundCalls)
    }

    // Outbound

    @Test
    fun `two calls to one app collapse with a count`() {
        val card = outbound(listOf(linear, linear))
        assertEquals(CardPresentation.OUTBOUND, card.presentation)
        assertEquals("Linear", card.outboundApp)
        assertEquals("Send to Linear?", card.headline)
        assertEquals("Create linear comment ×2", card.summaryLine)
        assertEquals("Linear · Create linear comment ×2", card.previewLine)
        assertTrue(card.hasDetails, "the raw request stays one tap away")
        assertFalse("{" in card.previewLine)
    }

    @Test
    fun `without calls the subtitle headings are read back`() {
        val card = outbound(null)
        assertEquals(2, card.outboundCalls.size)
        assertEquals("Send to Linear?", card.headline)
        assertEquals("Create linear comment ×2", card.summaryLine)
    }

    @Test
    fun `several apps use the generic headline and name each app`() {
        val gmail = OutboundCall("Gmail", "Send email")
        val card = outbound(listOf(gmail, OutboundCall("Stripe", "Create refund"), gmail))
        assertNull(card.outboundApp)
        assertEquals("Send on your behalf?", card.headline)
        assertEquals("Gmail · Send email ×2, Stripe · Create refund", card.summaryLine)
        assertEquals("Gmail · Send email ×2, Stripe · Create refund", card.previewLine)
    }

    @Test
    fun `many distinct actions name three and count the rest`() {
        val calls = (1..5).map { OutboundCall("Linear", "Action $it") }
        assertEquals("Action 1, Action 2, Action 3, +2 more", outbound(calls).summaryLine)
    }

    @Test
    fun `an unreadable subtitle falls back to the generic headline and keeps Details`() {
        val card = outbound(null, subtitle = "\n\nsomething odd")
        assertTrue(card.outboundCalls.isEmpty())
        assertEquals("Send on your behalf?", card.headline)
        assertEquals("", card.summaryLine)
        assertEquals("Send on your behalf?", card.previewLine)
        assertTrue(card.hasDetails)
    }

    @Test
    fun `a tool with no app is named by its label`() {
        val card = outbound(null, subtitle = "Send a message\n{\"to\":\"x\"}")
        assertEquals(listOf(OutboundCall(null, "Send a message")), card.outboundCalls)
        assertEquals("Send on your behalf?", card.headline)
        assertEquals("Send a message", card.summaryLine)
    }

    @Test
    fun `the held note never shows on an outbound card`() {
        assertFalse(outbound(null).showsHeldNote)
        assertFalse(outbound(null, answered = "allow").showsHeldNote)
    }

    // Provider and teammate approvals

    @Test
    fun `a permission card leads with its first line`() {
        val card = OptionCard(
            title = "Approval needed",
            subtitle = "git commit -m 'x' \\\n  && git push origin main",
            options = listOf("Allow", "Deny"),
            requestId = "p",
            requestType = "permission",
            tool = "Bash",
            held = "The provider requires your approval for this action.",
            heldCode = "approval.held.native",
        )
        assertEquals(CardPresentation.APPROVAL, card.presentation)
        assertEquals("Approval needed", card.headline)
        assertEquals("git commit -m 'x' \\", card.summaryLine)
        assertTrue(card.hasDetails)
        assertTrue(card.showsHeldNote, "while pending the note explains the stop")
        val settled = card.copy(answered = "deny")
        assertFalse(settled.showsHeldNote, "once settled it has done its job")
        assertEquals(CardOutcome.Denied, settled.outcome)
    }

    @Test
    fun `a one line request has no Details and a long one is cut`() {
        val card = OptionCard(
            title = "Approval needed",
            subtitle = "Upload build 1 to TestFlight?",
            options = listOf("Allow", "Deny"),
            tool = "App Store Connect",
        )
        assertEquals(CardPresentation.APPROVAL, card.presentation, "older computers send no requestType")
        assertFalse(card.hasDetails)
        val long = card.copy(subtitle = "a".repeat(300))
        assertEquals(ApprovalCards.SUMMARY_LIMIT, long.summaryLine.length)
        assertTrue(long.summaryLine.endsWith("…"))
        assertTrue(long.hasDetails)
    }

    @Test
    fun `a teammate approval is an approval`() {
        val card = OptionCard(
            title = "@Scout wants to contact @Forge",
            subtitle = "Can you check the build?",
            options = listOf("Allow", "Deny", "Always allow"),
            tool = "ask_bot",
            answered = "allow",
        )
        assertEquals(CardPresentation.APPROVAL, card.presentation)
        assertEquals(CardOutcome.Allowed, card.outcome)
    }

    // Standard cards keep their layout

    @Test
    fun `proposals show in full and read as their option`() {
        val routine = OptionCard(
            title = "Create routine?",
            subtitle = "Every weekday at 9\nSummarise inbox",
            options = listOf("Confirm", "Cancel"),
            requestId = "r",
            tool = "create_routine",
        )
        assertEquals(CardPresentation.STANDARD, routine.presentation)
        assertEquals(routine.subtitle, routine.summaryLine)
        assertFalse(routine.hasDetails)
        assertEquals(CardOutcome.Chose("Confirm", true), routine.copy(answered = "allow").outcome)
        assertEquals(CardOutcome.Chose("Cancel", false), routine.copy(answered = "deny").outcome)
    }

    @Test
    fun `a skill card stays standard even though it has a tool`() {
        val skill = OptionCard(
            title = "Enable skill?",
            subtitle = "Release notes",
            options = listOf("Enable", "Deny"),
            tool = "propose_skill",
            skillRequest = SkillRequestCardData(
                version = 1, requestId = "s", botId = "b", threadId = "t", stagedId = "x", action = "create",
                name = "notes", gist = "g", warnings = emptyList(), createdAt = 0,
            ),
        )
        assertEquals(CardPresentation.STANDARD, skill.presentation)
        assertEquals(CardOutcome.Denied, skill.copy(answered = "deny").outcome)
    }

    @Test
    fun `an error written after a proposal settled stays visible`() {
        val setup = OptionCard(
            title = "Apply setup for 2 bots?",
            subtitle = "…",
            options = listOf("Apply setup", "Cancel"),
            tool = "set_up_team",
            answered = "allow",
            held = "The decision was recorded, but the Chief could not continue: offline",
        )
        assertTrue(setup.showsHeldNote)
        assertEquals(CardOutcome.Chose("Apply setup", true), setup.outcome)
    }

    @Test
    fun `team memory reads as remembered or skipped`() {
        val memory = OptionCard(
            title = "Remember this for the team?",
            subtitle = "Person: Ana",
            options = listOf("Remember", "Skip"),
            tool = "propose_team_memory",
            teamMemoryRequest = TeamMemoryRequest("s", "e", "person"),
        )
        assertEquals(CardOutcome.Remembered, memory.copy(answered = "allow").outcome)
        assertEquals(CardOutcome.Skipped, memory.copy(answered = "deny").outcome)
    }

    // Outcome words

    @Test
    fun `verdicts read as words`() {
        val card = outbound(null)
        assertNull(card.outcome)
        assertEquals(CardOutcome.Allowed, card.copy(answered = "allow").outcome)
        assertTrue(assertNotNull(card.copy(answered = "allow").outcome).isPositive)
        assertEquals(CardOutcome.Denied, card.copy(answered = "deny").outcome)
        assertEquals(CardOutcome.Unavailable, card.copy(answered = "unavailable").outcome)
        assertFalse(assertNotNull(card.copy(answered = "unavailable").outcome).isPositive)
        assertEquals(CardOutcome.Allowed, card.copy(answered = "Allow").outcome, "case does not matter")
        assertEquals(CardOutcome.Other("something new"), card.copy(answered = "something new").outcome)
    }

    @Test
    fun `a legacy question reads as its answer`() {
        val question = OptionCard(
            title = "Your bot has a question",
            subtitle = "Which branch?",
            options = listOf("main", "dev"),
            requestType = "question",
            answered = "answer",
            answeredText = "dev",
        )
        assertEquals(CardPresentation.STANDARD, question.presentation)
        assertEquals(CardOutcome.Answered("dev"), question.outcome)
    }

    // Surfaces

    @Test
    fun `the roster preview uses the short line`() {
        val message = Message(
            id = "m",
            role = Message.Role.BOT,
            kind = Message.Kind.OPTIONS,
            at = 0.0,
            card = outbound(listOf(linear)),
        )
        assertEquals("Linear · Create linear comment", previewText(message))
        assertEquals("Send to Linear?", previewText(message.copy(card = message.card?.copy(answered = "allow"))))
    }

    @Test
    fun `answered approvals leave the transcript below Full`() {
        fun row(id: String, card: OptionCard) = Message(id = id, role = Message.Role.BOT, kind = Message.Kind.OPTIONS, at = 0.0, card = card)
        val permission = OptionCard(
            title = "Approval needed",
            subtitle = "git push origin main",
            options = listOf("Allow", "Deny"),
            requestId = "p",
            tool = "Bash",
            requestType = "permission",
            answered = "deny",
        )
        val proposal = OptionCard(
            title = "Add this routine?",
            subtitle = "Every morning",
            options = listOf("Confirm", "Cancel"),
            requestId = "r",
            answered = "Confirm",
        )
        val messages = listOf(
            row("sent", outbound(null, answered = "allow")),
            row("denied", permission),
            row("waiting", outbound(null)),
            row("proposal", proposal),
        )
        for (detail in listOf(ActivityDetail.HIDDEN, ActivityDetail.REDUCED)) {
            assertEquals(listOf("waiting", "proposal"), transcriptRows(messages, detail).map { it.id }, detail.name)
        }
        assertEquals(listOf("sent", "denied", "waiting", "proposal"), transcriptRows(messages, ActivityDetail.FULL).map { it.id })
    }
}

