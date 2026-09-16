package com.astra.companion.notifications

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * PendingIntent identity must not collapse distinct notification payloads.
 *
 * Android's PendingIntent equality ignores extras; only filterable Intent
 * fields (and the request code) discriminate. Expectations come from
 * `ios/App/Notifications.swift:35-45,65-69` (each request keeps its own
 * userInfo) and `_temp/PARITY_DELTA_AUDIT_2.md` §D2-03 (open the pair that
 * *that* notification carried).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class NotificationIntentsTest {

    @Test
    fun `same room thread with different botIds has distinct identity`() {
        val roomThread = "room-thread-1"
        val asker = identity("asker", roomThread)
        val other = identity("other-bot", roomThread)
        assertNotEquals(asker, other)
        // The old requestCode = threadId.hashCode() would have collided here.
        assertEquals(roomThread.hashCode(), roomThread.hashCode())
    }

    @Test
    fun `thread ids that share a String hashCode still differ`() {
        // Classic Java String.hashCode collision: "Aa" and "BB" both equal 2112.
        assertEquals("Aa".hashCode(), "BB".hashCode())
        assertNotEquals(identity("bot", "Aa"), identity("bot", "BB"))
        assertNotEquals(identity("bot", "FB"), identity("bot", "Ea"))
    }

    @Test
    fun `identity encodes the payload pair into the data URI`() {
        assertEquals(
            "openmaus://notification/bot%3A1/thread%2F2",
            NotificationIntents.contentIdentity("bot:1", "thread/2"),
        )
        assertEquals(
            "openmaus://notification/bot%20one/a%2Fb%3Fc",
            NotificationIntents.contentIdentity("bot one", "a/b?c"),
        )
    }

    private fun identity(botId: String, threadId: String): String =
        NotificationIntents.contentIdentity(botId, threadId)
}
