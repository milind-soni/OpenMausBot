package com.openmausbot.chief

import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import com.openmausbot.chief.data.NotificationPayload
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class MausApplicationNotificationTest {
    @Test
    fun notificationOpensMainActivityWithThreadContext() {
        val application = ApplicationProvider.getApplicationContext<MausApplication>()
        val payload = NotificationPayload(
            id = "notification-1",
            kind = "done",
            botId = "chief",
            botName = "Chief",
            threadId = "thread-42",
            title = "Chief finished",
            body = "The report is ready.",
        )

        application.showNotificationOnce(payload)

        val notification = shadowOf(application.getSystemService(NotificationManager::class.java)).allNotifications.single()
        assertEquals(R.drawable.ic_notification_centipede, notification.smallIcon.resId)
        val pendingIntent = notification.contentIntent
        assertNotNull(pendingIntent)
        assertEquals(MainActivity::class.java.name, shadowOf(pendingIntent).savedIntent.component?.className)
        assertEquals("thread-42", shadowOf(pendingIntent).savedIntent.getStringExtra("threadId"))
    }
}
