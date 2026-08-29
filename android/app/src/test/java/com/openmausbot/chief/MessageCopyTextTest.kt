package com.openmausbot.chief

import com.openmausbot.chief.data.Message
import com.openmausbot.chief.data.OptionCard
import org.junit.Assert.assertEquals
import org.junit.Test

class MessageCopyTextTest {
    @Test
    fun copiesPlainUserOrAssistantTextExactly() {
        val message = Message(id = "message-1", text = "Select or copy this message")

        assertEquals("Select or copy this message", copyableMessageText(message))
    }

    @Test
    fun includesVisibleCardContentWithoutCopyingActionButtons() {
        val message = Message(
            id = "message-2",
            text = "Approval needed",
            card = OptionCard(
                title = "Run deployment",
                subtitle = "Production",
                options = listOf("Allow", "Deny"),
                answered = "Allow",
            ),
        )

        assertEquals(
            "Approval needed\n\nRun deployment\nProduction\nAnswered: Allow",
            copyableMessageText(message),
        )
    }
}
