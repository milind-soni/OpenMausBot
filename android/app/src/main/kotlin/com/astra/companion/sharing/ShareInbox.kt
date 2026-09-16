package com.astra.companion.sharing

import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-memory holder for one inbound share.
 *
 * The trampoline copies the sender's URIs into the app cache, then deposits
 * the local result here. MainActivity never sees the original Intent extras.
 * A newer share replaces an unsent one and deletes that copy.
 */
class ShareInbox {
    private val generation = AtomicLong(0)
    private val _pending = MutableStateFlow<PendingShare?>(null)
    val pending: StateFlow<PendingShare?> = _pending.asStateFlow()
    private val sessions = mutableMapOf<Long, ShareSheetSession>()

    data class PendingShare(
        val generation: Long,
        val payload: SharePayload,
    )

    fun offer(payload: SharePayload) {
        val previous = _pending.value
        val next = PendingShare(generation.incrementAndGet(), payload)
        _pending.value = next
        previous?.let { drop(it) }
    }

    fun consume() {
        val previous = _pending.value
        _pending.value = null
        previous?.let { drop(it) }
    }

    fun sessionFor(generation: Long): ShareSheetSession = synchronized(sessions) {
        sessions.getOrPut(generation) { ShareSheetSession(generation) }
    }

    private fun drop(share: PendingShare) {
        synchronized(sessions) { sessions.remove(share.generation) }
        ShareItemLoader.cleanUp(share.payload)
    }

    companion object {
        const val DIRECTORY = "shared-inbox"

        fun root(cacheDir: File): File = File(cacheDir, DIRECTORY)

        fun cleanStale(cacheDir: File) {
            val directory = root(cacheDir)
            directory.listFiles()?.forEach { candidate ->
                runCatching { candidate.deleteRecursively() }
            }
        }
    }
}

sealed interface SharePayload {
    val inboxDir: File?

    data class Ready(val items: LoadedShareItems) : SharePayload {
        override val inboxDir: File get() = items.inboxDir
    }

    data class Failed(val message: String, override val inboxDir: File? = null) : SharePayload
}
