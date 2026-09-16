package com.astra.companion.avatar

import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * Cancellation close for picker streams.
 *
 * Round-2 used `Job.invokeOnCompletion` (fires when the job **completes**), so a
 * worker parked inside a provider `read` was never interrupted. These tests
 * exercise [withStreamClosedOnCancel] directly — the same helper [AvatarImagePicker.read]
 * wraps around the open stream — without needing a real ContentResolver.
 */
class AvatarImagePickerTest {

    @Test
    fun `cancelling a blocked provider read closes the stream`() = runBlocking {
        // Would fail against invokeOnCompletion: close never ran while read blocked,
        // so cancel left the coroutine and fd pinned until the provider returned.
        val enteredRead = CountDownLatch(1)
        val closed = AtomicBoolean(false)
        val stream = BlockingStream(onEnter = { enteredRead.countDown() }, onClose = { closed.set(true) })

        val job = async(Dispatchers.IO) {
            withStreamClosedOnCancel(stream) {
                stream.read(ByteArray(16))
                PreparedAvatar.Rejected(AvatarImageRules.TYPE_ERROR)
            }
        }

        assertTrue(enteredRead.await(2, TimeUnit.SECONDS), "read must block")
        job.cancel()
        withTimeout(2_000) {
            runCatching { job.await() }
        }
        assertTrue(closed.get(), "cancel must close the stream while read is blocked")
        assertTrue(stream.unblockedByClose, "close() must unblock the parked read")
    }

    @Test
    fun `successful block still reads without cancel-driven close racing the body`() = runBlocking {
        val reads = AtomicInteger(0)
        val stream = object : InputStream() {
            override fun read(): Int = -1
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                reads.incrementAndGet()
                return -1
            }
        }
        val result = withContext(Dispatchers.IO) {
            withStreamClosedOnCancel(stream) {
                AvatarImageRules.prepare(stream)
            }
        }
        assertTrue(result is PreparedAvatar.Rejected)
        assertTrue(reads.get() >= 1)
    }

    /**
     * Parks in [read] until [close] counts down the gate — the same observable
     * a hung cloud provider offers when its fd is closed under a blocked read.
     */
    private class BlockingStream(
        private val onEnter: () -> Unit,
        private val onClose: () -> Unit,
    ) : InputStream() {
        private val gate = CountDownLatch(1)
        @Volatile
        private var closed = false
        @Volatile
        var unblockedByClose: Boolean = false
            private set

        override fun read(): Int {
            onEnter()
            check(gate.await(30, TimeUnit.SECONDS)) { "test gate timed out" }
            unblockedByClose = closed
            return -1
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int = read()

        override fun close() {
            closed = true
            onClose()
            gate.countDown()
        }
    }
}
