package com.openmausbot.chief.data

import android.app.Notification
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotificationMirrorTest {
    @Test
    fun acceptsOnlyGoogleMessagesAndVisibleFields() {
        val extras = Bundle().apply {
            putCharSequence(Notification.EXTRA_TITLE, "Alex")
            putCharSequence(Notification.EXTRA_TEXT, "See you soon")
            putCharSequence(Notification.EXTRA_CONVERSATION_TITLE, "Alex")
            putCharSequence(Notification.EXTRA_SUB_TEXT, "Alex")
            putCharSequence("android.reply", "a private draft that must not be mirrored")
        }

        val payload = NotificationMirror.visible(
            packageName = "com.google.android.apps.messaging",
            key = "0|com.google.android.apps.messaging|42|null",
            postedAt = 1_700_000_000_000,
            extras = extras,
        )

        assertEquals("com.google.android.apps.messaging", payload?.packageName)
        assertEquals("Alex", payload?.title)
        assertEquals("See you soon", payload?.text)
        assertEquals("Alex", payload?.conversationTitle)
        assertEquals("Alex", payload?.sender)
        assertFalse(payload?.text?.contains("draft") == true)
    }

    @Test
    fun rejectsOtherPackagesAndEmptyNotifications() {
        val extras = Bundle().apply { putCharSequence(Notification.EXTRA_TEXT, "hello") }
        assertNull(NotificationMirror.visible("com.google.android.gm", "key", 1L, extras))
        assertNull(NotificationMirror.visible("com.google.android.apps.messaging", "key", 1L, Bundle()))
    }

    @Test
    fun boundsVisibleFieldsAndDoesNotExposeActionData() {
        val extras = Bundle().apply {
            putCharSequence(Notification.EXTRA_TITLE, "T".repeat(2_000))
            putCharSequence(Notification.EXTRA_TEXT, "M".repeat(20_000))
            putCharSequence("android.actions", "reply action")
            putCharSequence("android.remoteInput", "draft")
        }

        val payload = NotificationMirror.visible("com.google.android.apps.messaging", "key", 1L, extras)

        assertTrue(payload != null)
        assertTrue(payload!!.title.length <= NotificationMirror.MAX_TITLE_LENGTH)
        assertTrue(payload.text.length <= NotificationMirror.MAX_TEXT_LENGTH)
        assertEquals(null, payload.conversationTitle)
        assertEquals(null, payload.sender)
    }

    @Test
    fun prefersTheFullVisibleBigTextOverTheShortPreview() {
        val extras = Bundle().apply {
            putCharSequence(Notification.EXTRA_TEXT, "short preview")
            putCharSequence(Notification.EXTRA_BIG_TEXT, "full visible message")
        }

        val payload = NotificationMirror.visible("com.google.android.apps.messaging", "key", 1L, extras)

        assertEquals("full visible message", payload?.text)
    }
}
