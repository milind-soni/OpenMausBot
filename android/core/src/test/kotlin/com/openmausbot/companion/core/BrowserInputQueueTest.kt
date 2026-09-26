package com.openmausbot.companion.core

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Records what the queue actually sent, and can be held open so a test can
 * stack work behind one in-flight request — which is the only state where
 * coalescing is observable.
 *
 * Mirrors the Recorder in CompanionCore's BrowserInputQueueTests.
 */
private class Recorder {
    private val lock = Mutex()
    private val recorded = mutableListOf<BrowserInputBody>()
    private var gate: CompletableDeferred<Unit>? = null

    fun hold() {
        gate = CompletableDeferred()
    }

    fun release() {
        gate?.complete(Unit)
        gate = null
    }

    suspend fun send(body: BrowserInputBody) {
        gate?.await()
        lock.withLock { recorded.add(body) }
    }

    suspend fun sent(): List<BrowserInputBody> = lock.withLock { recorded.toList() }
}

@OptIn(ExperimentalCoroutinesApi::class)
class BrowserInputQueueTest {
    private fun move(x: Double, y: Double) = BrowserInputBody(
        type = "input_mouse", eventType = "mouseMoved", x = x, y = y,
        button = "none", clickCount = 0, modifiers = 0, deltaX = 0.0, deltaY = 0.0,
    )

    private fun wheel(dy: Double) = BrowserInputBody(
        type = "input_mouse", eventType = "mouseWheel", x = 0.0, y = 0.0,
        button = "none", clickCount = 0, modifiers = 0, deltaX = 0.0, deltaY = dy,
    )

    private fun press() = BrowserInputBody(
        type = "input_mouse", eventType = "mousePressed", x = 0.0, y = 0.0,
        button = "left", clickCount = 1, modifiers = 0, deltaX = 0.0, deltaY = 0.0,
    )

    private fun release() = BrowserInputBody(
        type = "input_mouse", eventType = "mouseReleased", x = 0.0, y = 0.0,
        button = "left", clickCount = 1, modifiers = 0, deltaX = 0.0, deltaY = 0.0,
    )

    private fun typed(text: String) =
        BrowserInputBody(type = "input_keyboard", eventType = "char", text = text)

    @Test
    fun everythingEnqueuedIsSentInOrder() = runTest {
        val recorder = Recorder()
        val queue = BrowserInputQueue(this, recorder::send) {}

        queue.enqueue(press())
        queue.enqueue(typed("hi"))
        queue.enqueue(release())
        queue.settle()

        assertEquals(
            listOf("mousePressed", "char", "mouseReleased"),
            recorder.sent().map { it.eventType },
        )
    }

    /** Stale pointer positions are worth nothing; only the newest matters. */
    @Test
    fun consecutiveMovesCoalesceToTheNewest() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        queue.enqueue(move(1.0, 1.0))
        for (step in 2..20) queue.enqueue(move(step.toDouble(), step.toDouble()))

        assertTrue(queue.depth() <= 1, "movement must collapse, not accumulate")

        recorder.release()
        queue.settle()

        val sent = recorder.sent()
        assertTrue(sent.size <= 2, "a burst of moves must not become a burst of requests")
        assertEquals(20.0, sent.last().x)
    }

    /** A flick must scroll as far as its parts would have. */
    @Test
    fun wheelDeltasSumWhenCoalesced() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        repeat(4) { queue.enqueue(wheel(-10.0)) }

        recorder.release()
        queue.settle()

        val total = recorder.sent().mapNotNull { it.deltaY }.sum()
        assertTrue(abs(total - -40.0) < 0.001, "$total is not -40.0")
    }

    /** A wheel must never absorb a pointer move, or the cursor teleports. */
    @Test
    fun differentMovementKindsDoNotCoalesceIntoEachOther() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        queue.enqueue(move(5.0, 5.0))
        queue.enqueue(wheel(-10.0))

        recorder.release()
        queue.settle()

        assertEquals(listOf("mouseMoved", "mouseWheel"), recorder.sent().map { it.eventType })
    }

    @Test
    fun keyboardAndButtonOrderSurvivesCoalescing() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        queue.enqueue(press())
        queue.enqueue(move(1.0, 1.0))
        queue.enqueue(move(2.0, 2.0))
        queue.enqueue(typed("a"))
        queue.enqueue(typed("b"))
        queue.enqueue(release())

        recorder.release()
        queue.settle()

        val sent = recorder.sent()
        assertEquals(
            listOf("mousePressed", "char", "char", "mouseReleased"),
            sent.filterNot { it.isMovement }.map { it.eventType },
        )
        assertEquals(listOf("a", "b"), sent.filter { it.eventType == "char" }.mapNotNull { it.text })
    }

    /** A slow link must not bank minutes of typing. */
    @Test
    fun theCeilingHaltsRatherThanBankingInput() = runTest {
        val recorder = Recorder()
        recorder.hold()
        var reported: Throwable? = null
        val queue = BrowserInputQueue(this, recorder::send) { reported = it }

        repeat(BrowserInputQueue.CEILING + 20) { queue.enqueue(typed("$it")) }

        assertTrue(queue.isStopped(), "the queue must halt rather than grow without bound")
        assertTrue(reported is BrowserInputTooSlowException)

        recorder.release()
        queue.settle()
    }

    /** Even halted, a release must get through. */
    @Test
    fun aHaltedQueueStillAcceptsReleases() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        repeat(BrowserInputQueue.CEILING + 20) { queue.enqueue(typed("$it")) }
        assertTrue(queue.isStopped())

        queue.enqueue(typed("ignored"))
        queue.enqueue(release())
        recorder.release()
        queue.settle()

        val sent = recorder.sent()
        assertTrue(sent.any { it.isRelease }, "a release must survive a halt")
        assertFalse(sent.any { it.text == "ignored" }, "ordinary input must not")
    }

    /** Reconnecting must not replay input aimed at a page that has moved on. */
    @Test
    fun clearForgetsQueuedInputAndTheHalt() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        repeat(BrowserInputQueue.CEILING + 20) { queue.enqueue(typed("$it")) }
        assertTrue(queue.isStopped())

        queue.clear()

        assertFalse(queue.isStopped())
        assertEquals(0, queue.depth())
        recorder.release()
    }

    /** Hand-back waits for what the remote is holding, not for stale travel. */
    @Test
    fun drainDropsMovementButCompletesTheRest() = runTest {
        val recorder = Recorder()
        recorder.hold()
        val queue = BrowserInputQueue(this, recorder::send) {}

        queue.enqueue(press())
        queue.enqueue(move(9.0, 9.0))
        queue.enqueue(release())

        recorder.release()
        queue.drain()

        val sent = recorder.sent()
        assertTrue(sent.any { it.eventType == "mousePressed" })
        assertTrue(sent.any { it.isRelease })
        assertFalse(sent.any { it.x == 9.0 }, "hand-back abandons stale travel")
        assertEquals(0, queue.depth())
    }
}
