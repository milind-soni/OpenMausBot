package com.openmausbot.chief.data

import android.content.Context
import java.security.MessageDigest

/** Small persistence seam so dedupe behavior can be tested without Android. */
interface NotificationDedupeStore {
    fun load(): Map<String, Long>
    fun save(entries: Map<String, Long>)
}

class InMemoryNotificationDedupeStore(initial: Map<String, Long> = emptyMap()) : NotificationDedupeStore {
    private var entries = initial.toMap()
    override fun load(): Map<String, Long> = entries
    override fun save(entries: Map<String, Long>) { this.entries = entries.toMap() }
}

/** Persists only SHA-256 keys and timestamps; notification text never reaches disk. */
class SharedPreferencesNotificationDedupeStore(context: Context) : NotificationDedupeStore {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun load(): Map<String, Long> = preferences.getString(KEY, null).orEmpty()
        .lineSequence()
        .mapNotNull { line ->
            val parts = line.split(':', limit = 2)
            if (parts.size != 2 || !HASH.matches(parts[0])) return@mapNotNull null
            parts[1].toLongOrNull()?.let { parts[0] to it }
        }
        .toMap()

    override fun save(entries: Map<String, Long>) {
        val encoded = entries.entries.joinToString("\n") { (hash, timestamp) -> "$hash:$timestamp" }
        preferences.edit().putString(KEY, encoded).apply()
    }

    companion object {
        private const val PREFERENCES = "openmaus-notification-dedupe"
        private const val KEY = "entries"
        private val HASH = Regex("[0-9a-f]{64}")
    }
}

/**
 * Keeps a bounded, short-lived set of notification keys.
 *
 * The companion event stream can replay a small tail while reconnecting. The
 * desktop event does not need to be shown twice on the phone, but identical
 * text from a later real event should still be allowed through. An injected
 * clock makes the retention behavior deterministic in unit tests.
 */
class NotificationDeduper(
    private val retentionMillis: Long = 10 * 60 * 1000L,
    private val maxEntries: Int = 512,
    private val nowMillis: () -> Long = { System.currentTimeMillis() },
    private val store: NotificationDedupeStore = InMemoryNotificationDedupeStore(),
) {
    private val seen = LinkedHashMap<String, Long>().apply { putAll(store.load()) }

    @Synchronized
    fun accept(key: String): Boolean {
        if (key.isBlank()) return true
        val now = nowMillis()
        purge(now)
        val storageKey = digest(key)
        val previous = seen[storageKey]
        if (previous != null && now - previous < retentionMillis) return false
        seen[storageKey] = now
        while (seen.size > maxEntries) seen.entries.iterator().let { iterator -> iterator.next(); iterator.remove() }
        store.save(seen)
        return true
    }

    @Synchronized
    fun clear() {
        seen.clear()
        store.save(emptyMap())
    }

    private fun purge(now: Long) {
        val before = seen.size
        seen.entries.removeIf { (_, timestamp) -> now - timestamp >= retentionMillis }
        if (seen.size != before) store.save(seen)
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.encodeToByteArray())
        .joinToString("") { byte -> "%02x".format(byte) }
}
