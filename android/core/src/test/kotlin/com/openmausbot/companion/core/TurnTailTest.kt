package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * When the transcript ends with the typing bubble. The same cases as iOS's
 * `TurnTailTests.swift`, read off the desktop's `src/lib/turn-tail.ts` and its call
 * sites in ChatView.tsx and GroupView.tsx.
 */
class TurnTailTest {
    private fun messages(json: String): List<Message> = CompanionJson.decodeFromString(json)

    private fun bot(busy: Boolean, activity: String? = null): Chat = Chat.BotChat(
        Bot(
            id = "scout", threadId = "t1", name = "Scout", title = "Researcher", description = "",
            notifications = true, color = "green", unread = false,
            modelSelection = ModelSelection("engine", "default"), createdAt = 1.0,
            busy = busy, activity = activity,
        ),
    )

    private fun room(speaker: String?): Chat = Chat.RoomChat(
        Room(
            id = "ops", threadId = "ops-thread", name = "Ops", memberIds = listOf("a", "b"),
            defaultResponder = GroupResponder("first"), bulletin = "", unread = false, createdAt = 1.0,
            busyBotId = speaker,
        ),
    )

    private val asked = """{"id":"ask","role":"user","kind":"text","at":1000,"text":"Check the build"}"""
    private val answered = """{"id":"reply","role":"bot","kind":"text","at":2000,"text":"It passes."}"""

    @Test
    fun afterASendTheBusyBotShowsTyping() {
        assertTrue(bot(busy = true).showsTyping(messages("[$asked]")))
        // An empty thread that is already working, too: the first message is still on its way.
        assertTrue(bot(busy = true).showsTyping(emptyList()))
    }

    @Test
    fun anIdleBotNeverShowsTyping() {
        // A queued send while nothing runs: the message waits, nobody types.
        assertFalse(bot(busy = false).showsTyping(messages("[$asked]")))
        assertFalse(bot(busy = false).showsTyping(messages("[$asked]"), streaming = true))
    }

    @Test
    fun aSettledReplyAtTheTailEndsTheTurnBeforeBusyClears() {
        assertFalse(bot(busy = true).showsTyping(messages("[$asked,$answered]")))
    }

    @Test
    fun theTurnsDigestAndLateRowsDoNotBringTheDotsBack() {
        val transcript = messages(
            """
            [$asked,
             {"id":"final","role":"bot","kind":"text","at":2000,"text":"Done.","turnId":"t","turnTerminal":true},
             {"id":"digest","role":"bot","kind":"digest","at":2100,"text":"[digest] · tools: shell ×1","turnId":"t"},
             {"id":"shot","role":"bot","kind":"screen","at":2200,"turnId":"t"}]
            """,
        )
        assertFalse(bot(busy = true).showsTyping(transcript.take(3)))
        assertFalse(bot(busy = true).showsTyping(transcript))
    }

    @Test
    fun aNewStepAfterAReplyShowsTypingAgain() {
        val transcript = messages(
            """
            [$asked,
             {"id":"note","role":"bot","kind":"text","at":2000,"text":"Let me look.","turnId":"t"},
             {"id":"step","role":"bot","kind":"activity","at":2100,"turnId":"t","tool":{"name":"Read build.log"}}]
            """,
        )
        assertTrue(bot(busy = true).showsTyping(transcript))
        // A wake-up turn after a finished one has a turn of its own.
        val wake = messages(
            """
            [{"id":"final","role":"bot","kind":"text","at":2000,"text":"Done.","turnId":"t","turnTerminal":true},
             {"id":"later","role":"bot","kind":"activity","at":3000,"turnId":"u","tool":{"name":"Read inbox"}}]
            """,
        )
        assertTrue(bot(busy = true).showsTyping(wake))
    }

    @Test
    fun aStreamIsAlwaysANewStep() {
        assertTrue(bot(busy = true).showsTyping(messages("[$asked,$answered]"), streaming = true))
    }

    @Test
    fun hiddenNarrationDoesNotCountAsTheTail() {
        val transcript = messages(
            """
            [$asked,
             {"id":"note","role":"bot","kind":"text","at":2000,"text":"Let me look.","turnId":"t"}]
            """,
        )
        assertFalse(bot(busy = true).showsTyping(transcript))
        assertTrue(bot(busy = true).showsTyping(transcript, hiddenIds = setOf("note")))
    }

    @Test
    fun aSteerSentMidTurnPinsTheDotsUnderIt() {
        val steer = """{"id":"steer","role":"user","kind":"text","at":3000,"text":"Also the tests","steered":true}"""
        assertTrue(bot(busy = true).showsTyping(messages("[$asked,$answered,$steer]")))
    }

    @Test
    fun waitingOnThePersonShowsNoDots() {
        assertFalse(bot(busy = true, activity = "waiting-on-you").showsTyping(messages("[$asked]")))
        assertTrue(bot(busy = true, activity = "working").showsTyping(messages("[$asked]")))
        assertTrue(bot(busy = true, activity = "no-signal").showsTyping(messages("[$asked]")))
    }

    @Test
    fun anOpenApprovalOrQuestionShowsNoDots() {
        val approval = """{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Run ls?","subtitle":"","options":["Allow","Deny"],"requestId":"r1","tool":"Bash"}}"""
        val question = """{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Which branch?","subtitle":"","options":["main","dev"],"requestId":"r2"}}"""
        for (card in listOf(approval, question)) {
            assertFalse(bot(busy = true).showsTyping(messages("[$asked,$card]")))
            assertFalse(bot(busy = true).showsTyping(messages("[$asked,$card]"), streaming = true))
        }
        val settled = """{"id":"card","role":"bot","kind":"options","at":2000,"card":{"title":"Run ls?","subtitle":"","options":["Allow","Deny"],"requestId":"r1","tool":"Bash","answered":"allow"}}"""
        assertTrue(bot(busy = true).showsTyping(messages("[$asked,$settled]")))
    }

    @Test
    fun stopOrAFailedTurnClearsTheDots() {
        val failed = """{"id":"err","role":"bot","kind":"activity","at":2000,"tool":{"name":"error: the run ended","ok":false}}"""
        assertFalse(bot(busy = false).showsTyping(messages("[$asked,$failed]")))
        assertFalse(bot(busy = false).showsTyping(messages("[$asked]")))
    }

    @Test
    fun anotherThreadBusyLeavesThisOneQuiet() {
        val profile = (bot(busy = true, activity = "working") as Chat.BotChat).bot.copy(
            tasks = listOf(
                BotTask(threadId = "t1", title = "Busy", createdAt = 1.0, activity = "working", busy = true),
                BotTask(threadId = "t2", title = "Quiet", createdAt = 2.0, activity = "idle", busy = false),
            ),
        )
        val quiet = assertNotNull(profile.forTask("t2"))
        assertFalse(Chat.BotChat(quiet).showsTyping(messages("[$asked]")))
        val working = assertNotNull(profile.forTask("t1"))
        assertTrue(Chat.BotChat(working).showsTyping(messages("[$asked]")))
    }

    @Test
    fun roomsShowTypingForANewSpeakerAfterAnotherMembersReply() {
        val fromA = """{"id":"a1","role":"bot","kind":"text","at":2000,"text":"Done on my side.","from":{"botId":"a","name":"Ada","color":"blue"}}"""
        val transcript = messages("[$asked,$fromA]")
        assertFalse(room(speaker = "a").showsTyping(transcript))
        assertTrue(room(speaker = "b").showsTyping(transcript))
        assertFalse(room(speaker = null).showsTyping(messages("[$asked]")))
        assertTrue(room(speaker = "a").showsTyping(messages("[$asked]")))
    }
}
