package com.openmausbot.chief

import com.openmausbot.chief.data.Message
import com.openmausbot.chief.data.OptionCard
import com.openmausbot.chief.data.WireJson
import org.junit.Assert.assertEquals
import org.junit.Test

class VisibleChatMessagesTest {
    @Test
    fun removesProtocolOnlyMessagesThatWouldRenderAsEmptyBubbles() {
        val messages = listOf(
            Message(id = "question", role = "user", text = "Any updates?"),
            Message(id = "activity-null", role = "bot", kind = "activity"),
            Message(id = "activity-text", role = "bot", kind = "activity", text = "internal tool event"),
            Message(id = "thinking-blank", role = "bot", kind = "thinking", text = "   \n"),
            Message(id = "empty-card", role = "bot", card = OptionCard()),
            Message(
                id = "approval",
                role = "bot",
                card = OptionCard(title = "Approval needed", options = listOf("Allow", "Deny"), requestId = "request-1"),
            ),
            Message(id = "answer", role = "bot", text = "No new inbound."),
        )

        assertEquals(
            listOf("question", "approval", "answer"),
            visibleChatMessages(messages).map(Message::id),
        )
    }

    @Test
    fun turnsFatalProviderActivityIntoAnActionableMessage() {
        val message = WireJson.decodeFromString<Message>(
            """{"id":"auth-failure","role":"bot","kind":"activity","tool":{"name":"error: Authentication required","ok":false,"setup":true}}""",
        )

        val visible = visibleChatMessages(listOf(message))

        assertEquals(listOf("auth-failure"), visible.map(Message::id))
        assertEquals(
            "This agent needs its model signed in on your computer. Open Agent Centipede, reconnect the model, then retry.",
            visible.single().text,
        )
    }

    @Test
    fun keepsAWorkerBatchVisibleWithoutInventingAChatBubble() {
        val message = WireJson.decodeFromString<Message>(
            """{"id":"batch-message","role":"bot","kind":"activity","workerBatch":{"id":"batch-1","taskId":"thread-1","label":"Today audit","status":"running","terminal":false,"counts":{"total":3,"queued":0,"running":2,"completed":1,"failed":0,"canceled":0},"jobs":[{"id":"job-1","label":"Inventory","status":"completed"},{"id":"job-2","label":"Counterfactual","status":"running"},{"id":"job-3","label":"Adversarial check","status":"running"}],"createdAt":1,"updatedAt":2}}""",
        )

        val visible = visibleChatMessages(listOf(message))

        assertEquals(listOf("batch-message"), visible.map(Message::id))
        assertEquals("Today audit", visible.single().workerBatch?.label)
        assertEquals(3, visible.single().workerBatch?.counts?.total)
    }
}
