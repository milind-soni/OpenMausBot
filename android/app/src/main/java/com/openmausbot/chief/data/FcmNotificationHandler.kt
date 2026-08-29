package com.openmausbot.chief.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Validates and deduplicates the data payload delivered by FCM.
 *
 * The desktop may send the notification as one JSON field (the preferred
 * transport) or as individual data fields (supported for older relays). No
 * unvalidated FCM value is ever handed to the Android notification layer.
 */
class FcmNotificationHandler(
    private val deduper: NotificationDeduper = NotificationDeduper(),
    private val onNotification: (NotificationPayload) -> Unit,
) {
    fun handle(data: Map<String, String>): Boolean {
        val payload = decode(data) ?: return false
        val key = payload.id?.takeIf { it.isNotBlank() }
            ?: listOf(payload.kind, payload.botId, payload.threadId, payload.title, payload.body).joinToString("\u001f")
        if (!deduper.accept(key)) return false
        onNotification(payload)
        return true
    }

    private fun decode(data: Map<String, String>): NotificationPayload? {
        val payload = data["notification"]?.let { encoded ->
            runCatching { WireJson.decodeFromString<NotificationPayload>(encoded) }.getOrNull()
        } ?: runCatching {
            WireJson.decodeFromJsonElement(
                NotificationPayload.serializer(),
                buildJsonObject {
                    data.forEach { (key, value) -> if (key in FIELDS) put(key, value) }
                },
            )
        }.getOrNull()
        return payload?.takeIf(::isUsable)
    }

    private fun isUsable(payload: NotificationPayload): Boolean =
        payload.kind in KINDS &&
            payload.botId.isSafePart() &&
            payload.threadId.isSafePart() &&
            payload.title.isSafeText() &&
            payload.body.isSafeText()

    private fun String.isSafePart() = isNotBlank() && length <= 512 && none(Char::isISOControl)
    private fun String.isSafeText() = isNotBlank() && length <= 8_000 && none(Char::isISOControl)

    companion object {
        private val KINDS = setOf("approval", "question", "done", "routine-failed", "takeover")
        private val FIELDS = setOf("id", "kind", "botId", "botName", "threadId", "title", "body")
    }
}
