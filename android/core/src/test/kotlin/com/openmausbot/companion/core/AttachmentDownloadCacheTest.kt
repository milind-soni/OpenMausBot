package com.openmausbot.companion.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.yield
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class AttachmentDownloadCacheTest {
    private fun key(connection: String = "mac-1", path: String = "/tmp/photo.jpg") =
        AttachmentDownloadKey(connection, "thread-1", "message-1", path)

    private fun file(value: Int, bytes: Int = 1) =
        DownloadedFile(ByteArray(bytes) { value.toByte() }, "photo.jpg", "image/jpeg")

    @Test
    fun `concurrent thumbnail requests share one transfer`() = runTest {
        val cache = AttachmentDownloadCache(this)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var loads = 0
        suspend fun load(): DownloadedFile {
            loads += 1
            started.complete(Unit)
            release.await()
            return file(7)
        }

        val first = async { cache.getOrLoad(key(), ::load) }
        val second = async { cache.getOrLoad(key(), ::load) }
        started.await()
        assertEquals(1, loads)
        release.complete(Unit)
        assertContentEquals(first.await().data, second.await().data)
        assertEquals(1, loads)
    }

    @Test
    fun `cache is byte bounded and least recently used`() = runTest {
        val cache = AttachmentDownloadCache(this, maximumEntries = 3, maximumBytes = 5)
        var loads = 0
        suspend fun load(value: Int): DownloadedFile {
            loads += 1
            return file(value, bytes = 3)
        }

        cache.getOrLoad(key(path = "/one")) { load(1) }
        cache.getOrLoad(key(path = "/two")) { load(2) }
        cache.getOrLoad(key(path = "/two")) { load(9) }
        cache.getOrLoad(key(path = "/one")) { load(1) }

        assertEquals(3, loads)
    }

    @Test
    fun `non retained bot file links reload updated bytes`() = runTest {
        val cache = AttachmentDownloadCache(this)
        var loads = 0

        val first = cache.getOrLoad(key(), retainResult = false) { file(++loads) }
        val second = cache.getOrLoad(key(), retainResult = false) { file(++loads) }

        assertEquals(2, loads)
        assertContentEquals(byteArrayOf(1), first.data)
        assertContentEquals(byteArrayOf(2), second.data)
    }

    @Test
    fun `an immutable waiter retains a shared in flight transfer`() = runTest {
        val cache = AttachmentDownloadCache(this)
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var loads = 0
        suspend fun load(): DownloadedFile {
            loads += 1
            started.complete(Unit)
            release.await()
            return file(7)
        }

        val botLink = async { cache.getOrLoad(key(), retainResult = false, loader = ::load) }
        started.await()
        val immutableCard = async { cache.getOrLoad(key(), retainResult = true, loader = ::load) }
        yield()
        release.complete(Unit)
        botLink.await()
        immutableCard.await()
        cache.getOrLoad(key(), retainResult = true) { file(++loads) }

        assertEquals(1, loads)
    }

    @Test
    fun `connection identity separates and clear invalidates downloads`() = runTest {
        val cache = AttachmentDownloadCache(this)
        var loads = 0
        suspend fun load(): DownloadedFile = file(++loads)

        cache.getOrLoad(key(connection = "mac-1"), ::load)
        cache.getOrLoad(key(connection = "mac-2"), ::load)
        cache.getOrLoad(key(connection = "mac-2"), ::load)
        assertEquals(2, loads)

        cache.clear()
        cache.getOrLoad(key(connection = "mac-2"), ::load)
        assertEquals(3, loads)
    }

    @Test
    fun `orphaned transfer cancels only after its final waiter leaves`() = runTest {
        val cache = AttachmentDownloadCache(this)
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        suspend fun load(): DownloadedFile = try {
            started.complete(Unit)
            awaitCancellation()
        } finally {
            cancelled.complete(Unit)
        }

        val first = async { cache.getOrLoad(key(), ::load) }
        val second = async { cache.getOrLoad(key(), ::load) }
        started.await()
        first.cancelAndJoin()
        assertEquals(false, cancelled.isCompleted)
        second.cancelAndJoin()
        cancelled.await()
    }
}
