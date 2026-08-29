package com.openmausbot.chief

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.openmausbot.chief.data.ConnectionStore
import com.openmausbot.chief.data.FirebaseRegistrationLifecycle
import com.openmausbot.chief.data.FcmNotificationHandler
import com.openmausbot.chief.data.OpenMausApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Receives closed-app FCM alerts and keeps the paired device token current. */
class MausMessagingService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onRegistered(installationId: String) {
        scope.launch {
            try {
                FirebaseRegistrationLifecycle.onRegistered(
                    session = ConnectionStore(applicationContext).load(),
                    installationId = installationId,
                ) { session, id -> scope.launch { runCatching { OpenMausApi(session).registerPushToken(id) } } }
            } catch (_: Throwable) {
                // No credential or installation identifier is logged.
            }
        }
    }

    override fun onUnregistered(installationId: String) {
        scope.launch {
            try {
                FirebaseRegistrationLifecycle.onUnregistered(
                    session = ConnectionStore(applicationContext).load(),
                ) { session -> scope.launch { runCatching { OpenMausApi(session).revokePushToken() } } }
            } catch (_: Throwable) {
                // The paired session may already have been removed.
            }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val application = application as? MausApplication ?: return
        FcmNotificationHandler(
            deduper = application.notificationDeduper,
            onNotification = application::showNotification,
        ).handle(message.data)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
