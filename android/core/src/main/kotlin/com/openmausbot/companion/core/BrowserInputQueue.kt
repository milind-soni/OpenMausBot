package com.openmausbot.companion.core

import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the queue gives up on when a link is too slow to keep up. */
class BrowserInputTooSlowException : Exception(
    "Browser input stopped because the connection is too slow. " +
        "Release control and reconnect before typing again.",
)

/**
 * One request in flight, with replaceable movement coalesced behind it.
 *
 * Ported from `src/lib/browser-input-queue.ts`, which the desktop panel uses
 * for the same reason: every input awaits a round trip the server will not
 * acknowledge until the browser has actually applied it. Without coalescing,
 * one flick is sixty requests and the session wedges; without the ceiling, a
 * slow link banks minutes of input that arrives long after it meant anything.
 *
 * Mirrors CompanionCore's `BrowserInputQueue`; a mutex stands in for the
 * actor, guarding exactly the same state.
 */
class BrowserInputQueue(
    private val scope: CoroutineScope,
    private val send: suspend (BrowserInputBody) -> Unit,
    private val onError: (Throwable) -> Unit,
) {
    companion object {
        /** A slow link cannot accumulate more than this. Reached, the queue
         * halts rather than delivering input the person stopped meaning. */
        const val CEILING = 32
    }

    private val lock = Mutex()
    private val pending = ArrayDeque<BrowserInputBody>()
    private var active: Job? = null
    private var generation = 0
    private var stopped = false

    suspend fun depth(): Int = lock.withLock { pending.size }

    suspend fun isStopped(): Boolean = lock.withLock { stopped }

    suspend fun enqueue(body: BrowserInputBody) {
        lock.withLock {
            // A halted queue still accepts releases: refusing them is how a
            // button stays down on the remote after the link recovers.
            if (stopped && !body.isRelease) return@withLock

            val last = pending.lastOrNull()
            if (last != null && body.isMovement && replaces(last, body)) {
                pending[pending.size - 1] = coalesce(last, body)
                return@withLock
            }

            if (pending.size >= CEILING) {
                // Drop replaceable travel first; it is the only thing whose
                // loss costs nothing.
                if (body.isMovement) return@withLock
                val replaceable = pending.indexOfFirst { it.isMovement }
                if (replaceable >= 0) {
                    pending.removeAt(replaceable)
                } else {
                    haltLocked(BrowserInputTooSlowException())
                    if (!body.isRelease || pending.size >= CEILING) return@withLock
                }
            }

            pending.addLast(body)
        }
        pumpIfIdle()
    }

    /** Wait for everything queued to reach the remote, dropping nothing. */
    suspend fun settle() {
        while (true) {
            pumpIfIdle()
            val job = lock.withLock { active } ?: return
            job.join()
            if (lock.withLock { pending.isEmpty() }) return
        }
    }

    /**
     * Abandon queued travel, then let what is left finish.
     *
     * This is the hand-back path: the remote must end up holding nothing, but
     * a cursor position from before the person let go is not worth waiting
     * for. Use [settle] where the queue's whole contents still matter.
     */
    suspend fun drain() {
        lock.withLock { pending.removeAll { it.isMovement } }
        settle()
    }

    /** Forget everything, including a halt. Used on reconnect: replaying input
     * from before the drop would act on a page that has since moved on. */
    suspend fun clear() {
        lock.withLock {
            generation++
            active?.cancel()
            active = null
            pending.clear()
            stopped = false
        }
    }

    /** Two movements coalesce only when they are the same kind of movement —
     * a wheel must never absorb a pointer move. */
    private fun replaces(last: BrowserInputBody, body: BrowserInputBody) =
        last.isMovement &&
            last.type == body.type &&
            last.eventType == body.eventType &&
            last.modifiers == body.modifiers &&
            last.button == body.button

    /** A replaced pointer move keeps only the newest position; wheels sum, so
     * a coalesced flick scrolls as far as its parts would have. */
    private fun coalesce(last: BrowserInputBody, body: BrowserInputBody): BrowserInputBody =
        if (body.eventType != "mouseWheel") body
        else body.copy(
            deltaX = min(max((last.deltaX ?: 0.0) + (body.deltaX ?: 0.0), -10_000.0), 10_000.0),
            deltaY = min(max((last.deltaY ?: 0.0) + (body.deltaY ?: 0.0), -10_000.0), 10_000.0),
        )

    /** Caller already holds the lock. */
    private fun haltLocked(cause: Throwable) {
        pending.retainAll { it.isRelease }
        if (stopped) return
        stopped = true
        onError(cause)
    }

    /** The launch happens under the lock so two callers cannot both start a
     * pump. `launch` only schedules, so the coroutine's own `withLock` runs
     * after this one has released. */
    private suspend fun pumpIfIdle() {
        lock.withLock {
            if (active != null || pending.isEmpty()) return
            val current = generation
            active = scope.launch { pump(current) }
        }
    }

    private suspend fun pump(current: Int) {
        while (true) {
            val body = lock.withLock {
                if (current != generation || pending.isEmpty()) null else pending.removeFirst()
            } ?: break
            try {
                send(body)
            } catch (cause: Throwable) {
                lock.withLock { if (current == generation) haltLocked(cause) }
            }
        }
        // Only a pump from the current generation may clear the slot. A stale
        // one that does it unconditionally wipes the replacement `clear()`
        // just started, and then two pumps drain `pending` side by side.
        val mine = lock.withLock {
            if (current != generation) false else { active = null; true }
        }
        if (!mine) return
        // Something may have arrived while the last send was in flight; the
        // queue must not park with work still in it.
        if (lock.withLock { pending.isNotEmpty() }) pumpIfIdle()
    }
}
