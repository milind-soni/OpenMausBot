package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json

/**
 * Mid-turn sends: what the phone shows between posting a message and the
 * computer actually running it.
 *
 * The harness answers a mid-turn send in one of three ways, and only one of
 * them puts anything in the transcript. These are claims about the other two
 * — the ones that used to leave the screen blank.
 */
class QueuedSendTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun drained(id: String, queueId: String, text: String = "and add tests") = Message(
        id = id,
        role = Message.Role.USER,
        kind = Message.Kind.TEXT,
        at = 10.0,
        text = text,
        queueId = queueId,
    )

    private fun echo(busy: Boolean? = null) = com.openmausbot.companion.core.Bot(
        id = "b1",
        threadId = "t1",
        name = "Echo",
        title = "",
        description = "",
        notifications = true,
        color = "blue",
        unread = false,
        modelSelection = ModelSelection("codex", "gpt-5.5"),
        createdAt = 1.0,
        busy = busy,
    )

    // MARK: - The receipt

    @Test
    fun `a held send decodes as queued`() {
        val body = """{"ok":true,"queued":true,"queueId":"q1","threadId":"t1"}"""
        assertEquals(
            SendReceipt.Queued("q1", "t1"),
            json.decodeFromString<SendReceiptBody>(body).receipt(),
        )
    }

    @Test
    fun `a send taken into the running turn decodes as steered`() {
        val body = """{"ok":true,"steered":true,"threadId":"t1"}"""
        assertEquals(
            SendReceipt.Sent("t1", steered = true),
            json.decodeFromString<SendReceiptBody>(body).receipt(),
        )
    }

    /** An older harness answers `{ok:true}`. That is a plain send. */
    @Test
    fun `an answer without mid-turn detail is a plain send`() {
        assertEquals(
            SendReceipt.Sent(null, steered = false),
            json.decodeFromString<SendReceiptBody>("""{"ok":true}""").receipt(),
        )
    }

    /**
     * `queued` without the id it is identified by is not something this client
     * can track, cancel, or retire. Treating it as queued would strand a row.
     */
    @Test
    fun `queued without an id falls back to a plain send`() {
        val body = """{"ok":true,"queued":true,"threadId":"t1"}"""
        assertEquals(
            SendReceipt.Sent("t1", steered = false),
            json.decodeFromString<SendReceiptBody>(body).receipt(),
        )
    }

    // MARK: - The fold

    @Test
    fun `a held send stays on screen until its line lands`() {
        var state = CompanionState().rememberQueued(QueuedSend("q1", "and add tests"), "t1")
        assertEquals(listOf("and add tests"), state.pendingQueued["t1"]?.map { it.text })

        state = state.apply(Frame.Message("t1", drained("m1", "q1")))
        assertNull(state.pendingQueued["t1"])
        assertEquals(1, state.transcript("t1").size)
    }

    @Test
    fun `holds are kept in send order and never twice`() {
        val state = CompanionState()
            .rememberQueued(QueuedSend("q1", "first"), "t1")
            .rememberQueued(QueuedSend("q2", "second"), "t1")
            .rememberQueued(QueuedSend("q1", "first"), "t1")
        assertEquals(listOf("first", "second"), state.pendingQueued["t1"]?.map { it.text })
    }

    /**
     * The turn can settle before the POST that queued the message has even
     * returned. Its line is already in the transcript by then, so the late
     * receipt must not put a row for it back on screen.
     */
    @Test
    fun `a drain that beats its own receipt does not resurrect the row`() {
        val state = CompanionState()
            .apply(Frame.Message("t1", drained("m1", "q1")))
            .rememberQueued(QueuedSend("q1", "and add tests"), "t1")
        assertNull(state.pendingQueued["t1"])
    }

    /** One tombstone, one use. */
    @Test
    fun `the tombstone is spent once`() {
        val state = CompanionState()
            .apply(Frame.Message("t1", drained("m1", "q1")))
            .rememberQueued(QueuedSend("q1", "first"), "t1")
            .rememberQueued(QueuedSend("q1", "first"), "t1")
        assertEquals(listOf("first"), state.pendingQueued["t1"]?.map { it.text })
    }

    @Test
    fun `cancelling a hold removes it and only it`() {
        var state = CompanionState()
            .rememberQueued(QueuedSend("q1", "first"), "t1")
            .rememberQueued(QueuedSend("q2", "second"), "t1")
        state = state.forgetQueued("q1", "t1")
        assertEquals(listOf("second"), state.pendingQueued["t1"]?.map { it.text })
        state = state.forgetQueued("q2", "t1")
        assertNull(state.pendingQueued["t1"])
    }

    @Test
    fun `holds are kept per thread`() {
        val state = CompanionState()
            .rememberQueued(QueuedSend("q1", "first"), "t1")
            .rememberQueued(QueuedSend("q2", "second"), "t2")
            .apply(Frame.Message("t1", drained("m1", "q1")))
        assertNull(state.pendingQueued["t1"])
        assertEquals(listOf("second"), state.pendingQueued["t2"]?.map { it.text })
    }

    /**
     * A bot frame carrying a whole transcript replaces `messages` outright
     * rather than appending, so it never runs the retirement that `append`
     * does. Without reconciling here the held message sits above the chat bar
     * for ever, long after its line has landed.
     */
    @Test
    fun `a wholesale transcript replacement retires the row`() {
        var state = CompanionState().apply(Frame.Bot(echo()))
        state = state.rememberQueued(QueuedSend("q1", "Count to 5"), "t1")
        assertEquals(1, state.pendingQueued["t1"]?.size)

        state = state.apply(Frame.Bot(echo().copy(messages = listOf(drained("m1", "q1")))))
        assertNull(state.pendingQueued["t1"])
    }

    /**
     * An engine that dies mid-sentence reports the failure as activity, not as
     * a settled reply, so nothing else clears the buffer. Left alone it renders
     * as an answer that streams for ever.
     */
    @Test
    fun `an idle bot has nothing streaming`() {
        var state = CompanionState().apply(Frame.Bot(echo(busy = true)))
        state = state.apply(
            Frame.Runtime(RuntimeEvent("content.delta", "t1", "A History of Comp", "assistant_text")),
        )
        assertTrue(state.streaming["t1"].orEmpty().isNotEmpty())

        state = state.apply(Frame.Bot(echo(busy = false)))
        assertNull(state.streaming["t1"])
    }

    // MARK: - The message

    @Test
    fun `a transcript line carries its mid-turn markers`() {
        val body = """{"id":"m1","role":"user","kind":"text","at":1,"text":"stop","steered":true}"""
        val message = json.decodeFromString<Message>(body)
        assertEquals(true, message.steered)
        assertNull(message.queueId)
    }

    @Test
    fun `an engine that can take words into a turn says so`() {
        val body = """{"images":true,"queueing":true}"""
        assertEquals(true, json.decodeFromString<InstanceCapabilities>(body).queueing)
    }
}
