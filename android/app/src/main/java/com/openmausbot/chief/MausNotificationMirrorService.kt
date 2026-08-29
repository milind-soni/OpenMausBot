package com.openmausbot.chief

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.openmausbot.chief.data.ConnectionStore
import com.openmausbot.chief.data.EncryptedNotificationMirrorQueue
import com.openmausbot.chief.data.NotificationMirrorDispatcher
import com.openmausbot.chief.data.NotificationMirrorWorker

/** Read-only Google Messages bridge; actions, remote inputs, and drafts are ignored. */
class MausNotificationMirrorService : NotificationListenerService() {
    override fun onNotificationPosted(statusBarNotification: StatusBarNotification) {
        NotificationMirrorDispatcher(
            session = { ConnectionStore(applicationContext).load() },
            send = { _, payload ->
                EncryptedNotificationMirrorQueue(applicationContext).enqueue(payload)
                NotificationMirrorWorker.schedule(applicationContext)
            },
        ).dispatch(
            packageName = statusBarNotification.packageName,
            key = statusBarNotification.key,
            postedAt = statusBarNotification.postTime,
            extras = statusBarNotification.notification.extras,
        )
    }

    override fun onNotificationRemoved(statusBarNotification: StatusBarNotification) = Unit

}
