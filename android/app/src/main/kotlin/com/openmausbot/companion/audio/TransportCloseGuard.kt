package com.openmausbot.companion.audio

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred

/**
 * What keeps [WebRtcLiveCallTransport] from touching a disposed peer, apart
 * from `org.webrtc` so the JVM suite can pin it.
 *
 * A hang-up closes the transport on the main thread while `offer()` or
 * `accept()` is suspended on a native callback (the offer, a description, ICE
 * gathering). The peer is disposed then: the waiter must fail instead of
 * calling into it, and a callback the disposed peer never delivers must not
 * leave it waiting.
 */
internal class TransportCloseGuard {
    private val closed = AtomicBoolean(false)

    /** The native callback a caller is waiting on; [failPending] fails it. */
    @Volatile
    private var pending: CompletableDeferred<*>? = null

    val isClosed: Boolean
        get() = closed.get()

    /** Throws once [close] has run: the native objects are gone. */
    fun ensureOpen() {
        if (closed.get()) throw IllegalStateException(CLOSED)
    }

    /**
     * Runs [start], which hands [result] to a native observer, and waits for
     * it. Throws when [close] ran before, during or just after the wait (a
     * callback that landed first but resumed after the close still fails).
     *
     * A [CompletableDeferred] rather than a continuation: an observer that
     * fires after [failPending] is then a no-op, not a second resume that
     * would throw on a WebRTC thread.
     */
    suspend fun <T> await(result: CompletableDeferred<T>, start: () -> Unit = {}): T {
        pending = result
        try {
            ensureOpen()
            start()
            return result.await().also { ensureOpen() }
        } finally {
            pending = null
        }
    }

    /** True the first time only. The caller then releases its native objects and calls [failPending]. */
    fun close(): Boolean = closed.compareAndSet(false, true)

    /** Fails the wait in progress, if any. Last in `close()`, so the resumed caller finds everything released. */
    fun failPending() {
        pending?.completeExceptionally(IllegalStateException(CLOSED))
    }

    companion object {
        const val CLOSED = "transport closed"
    }
}
