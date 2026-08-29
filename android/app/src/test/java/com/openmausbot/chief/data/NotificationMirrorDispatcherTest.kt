package com.openmausbot.chief.data

import android.app.Notification
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotificationMirrorDispatcherTest {
    @Test
    fun retriesOnlyTransientMirrorFailures() {
        assertTrue(NotificationMirrorRetryPolicy.shouldRetry(ApiException("offline")))
        assertTrue(NotificationMirrorRetryPolicy.shouldRetry(ApiException("server", 503)))
        assertTrue(NotificationMirrorRetryPolicy.shouldRetry(java.io.IOException("offline")))
        assertEquals(false, NotificationMirrorRetryPolicy.shouldRetry(ApiException("unauthorized", 401)))
        assertEquals(false, NotificationMirrorRetryPolicy.shouldRetry(IllegalArgumentException("bad payload")))
    }

    @Test
    fun unpairedDeviceDoesNotSendAnything() {
        var sends = 0
        val dispatcher = NotificationMirrorDispatcher(session = { null }) { _, _ -> sends++ }

        dispatcher.dispatch("com.google.android.apps.messaging", "key", 1L, visibleExtras())

        assertEquals(0, sends)
    }

    @Test
    fun pairedDeviceSendsOnlyTheValidatedVisiblePayload() {
        val session = session()
        var captured: NotificationMirrorPayload? = null
        val dispatcher = NotificationMirrorDispatcher(session = { session }) { _, payload -> captured = payload }

        dispatcher.dispatch("com.google.android.apps.messaging", "key", 1L, visibleExtras())

        assertTrue(captured != null)
        assertEquals("Alex", captured?.title)
        assertEquals("See you soon", captured?.text)
    }

    private fun visibleExtras() = Bundle().apply {
        putCharSequence(Notification.EXTRA_TITLE, "Alex")
        putCharSequence(Notification.EXTRA_TEXT, "See you soon")
    }

    private fun session() = PairedSession(
        SavedConnection(name = "Office", origin = "https://example.com", allowedKinds = setOf("hosted")),
        "omb_secret",
    )
}
