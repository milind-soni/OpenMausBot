package com.astra.companion.avatar

import com.astra.companion.core.AvatarCrop
import java.io.ByteArrayInputStream
import java.io.InputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout

/**
 * Limits and framing from `ios/App/AgentProfileView.swift` and
 * `ios/App/BotAvatarView.swift` — not from the Kotlin under test.
 */
class AvatarImageRulesTest {

    @Test
    fun `magic bytes match the four iOS imageMIME branches`() {
        assertEquals("image/png", AvatarImageRules.imageMime(PNG_HEADER + byteArrayOf(1)))
        assertEquals("image/jpeg", AvatarImageRules.imageMime(JPEG_HEADER + byteArrayOf(1)))
        assertEquals("image/gif", AvatarImageRules.imageMime(GIF_HEADER + byteArrayOf(1)))
        assertEquals("image/webp", AvatarImageRules.imageMime(WEBP_HEADER))
        assertNull(AvatarImageRules.imageMime(byteArrayOf(0, 1, 2, 3, 4, 5)))
        assertNull(AvatarImageRules.imageMime(byteArrayOf()))
        // RIFF without WEBP is not an image.
        assertNull(
            AvatarImageRules.imageMime(
                byteArrayOf(
                    'R'.code.toByte(), 'I'.code.toByte(), 'F'.code.toByte(), 'F'.code.toByte(),
                    0, 0, 0, 0,
                    'W'.code.toByte(), 'A'.code.toByte(), 'V'.code.toByte(), 'E'.code.toByte(),
                ),
            ),
        )
    }

    @Test
    fun `prepare rejects type before size using the iOS copy`() {
        val rejected = assertIs<PreparedAvatar.Rejected>(
            AvatarImageRules.prepare(byteArrayOf(1, 2, 3)),
        )
        assertEquals(AvatarImageRules.TYPE_ERROR, rejected.message)
        assertEquals(
            "Choose a PNG, JPEG, GIF, or WebP image.",
            rejected.message,
        )
    }

    @Test
    fun `prepare measures raw ByteArray size the way iOS measures Data count`() {
        val exact = PNG_HEADER + ByteArray(AvatarImageRules.MAX_BYTES - PNG_HEADER.size)
        val ready = assertIs<PreparedAvatar.Ready>(AvatarImageRules.prepare(exact))
        assertEquals("image/png", ready.mime)
        assertEquals(AvatarImageRules.MAX_BYTES, ready.data.size)

        val over = PNG_HEADER + ByteArray(AvatarImageRules.MAX_BYTES - PNG_HEADER.size + 1)
        val rejected = assertIs<PreparedAvatar.Rejected>(AvatarImageRules.prepare(over))
        assertEquals(AvatarImageRules.SIZE_ERROR, rejected.message)
        assertEquals("That image is larger than 10 MB.", rejected.message)
    }

    @Test
    fun `declared size is not an acceptance gate — body count decides like Swift Data count`() = runTest {
        // Provider metadata claims 11 MB, but the stream body is a small valid PNG.
        // iOS / server measure the encoded body; OpenableColumns.SIZE must not reject.
        val body = PNG_HEADER + ByteArray(256)
        val ready = assertIs<PreparedAvatar.Ready>(
            AvatarImageRules.prepare(
                ByteArrayInputStream(body),
                capacityHint = AvatarImageRules.MAX_BYTES.toLong() + 1,
            ),
        )
        assertEquals("image/png", ready.mime)
        assertEquals(body.size, ready.data.size)
    }

    @Test
    fun `declared size alone does not turn a small non-image into a size error`() = runTest {
        // capacityHint is metadata only; a tiny invalid body is still TYPE_ERROR.
        val rejected = assertIs<PreparedAvatar.Rejected>(
            AvatarImageRules.prepare(
                ByteArrayInputStream(byteArrayOf(1, 2, 3, 4, 5)),
                capacityHint = AvatarImageRules.MAX_BYTES.toLong() + 5_000_000,
            ),
        )
        assertEquals(AvatarImageRules.TYPE_ERROR, rejected.message)
    }

    @Test
    fun `a genuinely large non-image stream is a type error like AgentProfileView`() = runTest {
        // Would fail against round-2: stream path returned SIZE_ERROR at byte
        // MAX+1 before sniffing magic bytes. iOS checks imageMIME before Data.count.
        val stream = SequenceInputStreamOf(
            totalBytes = AvatarImageRules.MAX_BYTES + 8,
            header = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8),
        )
        val rejected = assertIs<PreparedAvatar.Rejected>(AvatarImageRules.prepare(stream))
        assertEquals(AvatarImageRules.TYPE_ERROR, rejected.message)
    }

    @Test
    fun `prepare on a stream rejects once the read passes ten megabytes`() = runTest {
        val stream = SequenceInputStreamOf(AvatarImageRules.MAX_BYTES + 8, PNG_HEADER)
        val rejected = assertIs<PreparedAvatar.Rejected>(AvatarImageRules.prepare(stream))
        assertEquals(AvatarImageRules.SIZE_ERROR, rejected.message)
    }

    @Test
    fun `prepare cooperatively cancels between stream reads`() = runBlocking {
        // Real dispatcher: TestScheduler coalesces same-time yield() into one
        // unbroken drain of the 10 MB gate, which hides cancellation. On
        // Dispatchers.Default, yield() is a true cancel point between chunks.
        val stream = EndlessChunkStream(PNG_HEADER)
        val job = launch(Dispatchers.Default) {
            AvatarImageRules.prepare(stream)
        }
        withTimeout(2_000) {
            while (stream.reads < 3) {
                Thread.sleep(1)
            }
        }
        val readsAtCancel = stream.reads
        job.cancel()
        withTimeout(2_000) { job.join() }
        assertTrue(job.isCancelled)
        assertTrue(
            stream.reads < AvatarImageRules.MAX_BYTES / 1024,
            "cancel must stop before the 10 MB size gate consumes the stream (reads=$readsAtCancel→${stream.reads})",
        )
    }

    @Test
    fun `upload maps mascot to circle the way AgentProfileView does`() {
        assertEquals(AvatarCrop.CIRCLE, AvatarImageRules.intendedUploadCrop(AvatarCrop.MASCOT))
        assertEquals(AvatarCrop.CIRCLE, AvatarImageRules.intendedUploadCrop(AvatarCrop.CIRCLE))
        assertEquals(AvatarCrop.ROUNDED, AvatarImageRules.intendedUploadCrop(AvatarCrop.ROUNDED))
        assertEquals(AvatarCrop.SQUARE, AvatarImageRules.intendedUploadCrop(AvatarCrop.SQUARE))
    }

    @Test
    fun `usesImage matches BotAvatarView`() {
        assertTrue(AvatarImageRules.usesImage(AvatarCrop.CIRCLE, "/api/attachments/a.png", failed = false))
        assertFalse(AvatarImageRules.usesImage(AvatarCrop.MASCOT, "/api/attachments/a.png", failed = false))
        assertFalse(AvatarImageRules.usesImage(AvatarCrop.CIRCLE, null, failed = false))
        assertFalse(AvatarImageRules.usesImage(AvatarCrop.ROUNDED, "/api/attachments/a.png", failed = true))
    }

    @Test
    fun `rounded corner radius is size times 0_22 from BotAvatarView`() {
        assertEquals(0.22f, AvatarImageRules.ROUNDED_CORNER_FRACTION)
        assertEquals(22f, AvatarImageRules.roundedCornerRadius(100f))
        assertEquals(11f, AvatarImageRules.roundedCornerRadius(50f))
        assertEquals(0f, AvatarImageRules.roundedCornerRadius(0f))
    }

    /**
     * Stream that yields [header] then zero-filled chunks until [totalBytes]
     * have been offered to the reader.
     */
    private class SequenceInputStreamOf(
        private val totalBytes: Int,
        private val header: ByteArray,
    ) : InputStream() {
        private var produced = 0

        override fun read(): Int {
            if (produced >= totalBytes) return -1
            val value = if (produced < header.size) header[produced].toInt() and 0xff else 0
            produced += 1
            return value
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (produced >= totalBytes) return -1
            val n = minOf(len, totalBytes - produced)
            for (i in 0 until n) {
                b[off + i] = if (produced + i < header.size) header[produced + i] else 0
            }
            produced += n
            return n
        }
    }

    /** Never ends — used to prove cancel stops the read loop early. */
    private class EndlessChunkStream(
        private val header: ByteArray,
    ) : InputStream() {
        @Volatile
        var reads = 0

        override fun read(): Int = 0

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            reads += 1
            val n = minOf(len, 64)
            for (i in 0 until n) {
                b[off + i] = if (reads == 1 && i < header.size) header[i] else 0
            }
            return n
        }
    }

    private companion object {
        val PNG_HEADER = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val JPEG_HEADER = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte())
        val GIF_HEADER = byteArrayOf('G'.code.toByte(), 'I'.code.toByte(), 'F'.code.toByte(), '8'.code.toByte())
        val WEBP_HEADER = byteArrayOf(
            'R'.code.toByte(), 'I'.code.toByte(), 'F'.code.toByte(), 'F'.code.toByte(),
            0, 0, 0, 0,
            'W'.code.toByte(), 'E'.code.toByte(), 'B'.code.toByte(), 'P'.code.toByte(),
        )
    }
}
