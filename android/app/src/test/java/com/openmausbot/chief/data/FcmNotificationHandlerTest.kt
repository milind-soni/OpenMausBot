package com.openmausbot.chief.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmNotificationHandlerTest {
    @Test
    fun validDataPayloadIsValidatedAndDisplayedOnce() {
        val shown = mutableListOf<NotificationPayload>()
        val handler = FcmNotificationHandler(onNotification = shown::add)
        val data = mapOf(
            "notification" to """{"id":"evt-1","kind":"done","botId":"chief","botName":"Chief","threadId":"thread-1","title":"Chief finished","body":"The report is ready."}""",
        )

        assertTrue(handler.handle(data))
        assertFalse(handler.handle(data))
        assertEquals(1, shown.size)
        assertEquals("evt-1", shown.single().id)
    }

    @Test
    fun malformedOrUntrustedPayloadIsIgnored() {
        val shown = mutableListOf<NotificationPayload>()
        val handler = FcmNotificationHandler(onNotification = shown::add)

        assertFalse(handler.handle(mapOf("notification" to "not-json")))
        assertFalse(handler.handle(mapOf("notification" to """{"kind":"done","botId":"chief"}""")))
        assertFalse(handler.handle(mapOf("notification" to """{"kind":"unknown","botId":"chief","threadId":"t","title":"x","body":"y"}""")))
        assertTrue(shown.isEmpty())
    }

    @Test
    fun directDataFieldsAreAcceptedForTransportCompatibility() {
        val shown = mutableListOf<NotificationPayload>()
        val handler = FcmNotificationHandler(onNotification = shown::add)

        assertTrue(
            handler.handle(
                mapOf(
                    "id" to "evt-2",
                    "kind" to "approval",
                    "botId" to "chief",
                    "botName" to "Chief",
                    "threadId" to "thread-2",
                    "title" to "Approval needed",
                    "body" to "Please review.",
                ),
            ),
        )
        assertEquals("approval", shown.single().kind)
    }
}
