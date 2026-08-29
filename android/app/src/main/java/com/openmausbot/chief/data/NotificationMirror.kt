package com.openmausbot.chief.data

import android.app.Notification
import android.os.Bundle
import java.security.MessageDigest

/** Pure extraction policy for the notification listener's public seam. */
object NotificationMirror {
    const val MESSAGES_PACKAGE = "com.google.android.apps.messaging"
    const val MAX_TITLE_LENGTH = 240
    const val MAX_TEXT_LENGTH = 4_000

    fun visible(packageName: String, key: String, postedAt: Long, extras: Bundle): NotificationMirrorPayload? {
        if (packageName != MESSAGES_PACKAGE) return null
        val title = clean(extras.charSequence(Notification.EXTRA_TITLE), MAX_TITLE_LENGTH)
        val text = clean(
            extras.charSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.charSequence(Notification.EXTRA_TEXT),
            MAX_TEXT_LENGTH,
        )
        if (title.isNullOrBlank() && text.isNullOrBlank()) return null
        return NotificationMirrorPayload(
            id = digest("$packageName\u001f$key\u001f$postedAt"),
            packageName = packageName,
            postedAt = postedAt,
            title = title.orEmpty(),
            text = text.orEmpty(),
            conversationTitle = clean(extras.charSequence(Notification.EXTRA_CONVERSATION_TITLE), MAX_TITLE_LENGTH),
            sender = clean(extras.charSequence(Notification.EXTRA_SUB_TEXT), MAX_TITLE_LENGTH),
        )
    }

    private fun Bundle.charSequence(key: String): CharSequence? = getCharSequence(key)

    private fun clean(value: CharSequence?, maxLength: Int): String? = value?.toString()
        ?.replace(Regex("[\\u0000-\\u001F\\u007F]"), " ")
        ?.trim()
        ?.takeIf { it.isNotBlank() }
        ?.take(maxLength)

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.encodeToByteArray())
        .joinToString("") { byte -> "%02x".format(byte) }
}

/** Keeps pairing and network delivery separate from Android's listener API. */
class NotificationMirrorDispatcher(
    private val session: () -> PairedSession?,
    private val send: (PairedSession, NotificationMirrorPayload) -> Unit,
) {
    fun dispatch(packageName: String, key: String, postedAt: Long, extras: Bundle) {
        val paired = session() ?: return
        val payload = NotificationMirror.visible(packageName, key, postedAt, extras) ?: return
        send(paired, payload)
    }
}

object NotificationMirrorRetryPolicy {
    fun shouldRetry(failure: Throwable?): Boolean = when (failure) {
        is ApiException -> failure.status == null || failure.status >= 500
        is java.io.IOException -> true
        else -> false
    }
}

object FirebaseRegistrationLifecycle {
    fun onRegistered(session: PairedSession?, installationId: String, register: (PairedSession, String) -> Unit) {
        if (session != null && installationId.isNotBlank()) register(session, installationId)
    }

    fun onUnregistered(session: PairedSession?, revoke: (PairedSession) -> Unit) {
        if (session != null) revoke(session)
    }
}
