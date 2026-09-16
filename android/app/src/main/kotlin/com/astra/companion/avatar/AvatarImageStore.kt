package com.astra.companion.avatar

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.astra.companion.core.Bot
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Authenticated avatar bytes (and decoded bitmaps) shared by roster, header,
 * group and profile.
 *
 * Mirrors `Session.avatarCache` / `avatarData(for:)` on iOS for **encoded**
 * bytes: entry count and byte cost are bounded (64 / 32 MiB) because one valid
 * upload may be 10 MB; concurrent first renders of the same path share one
 * download; [clear] drops everything on sign-out so a finished fetch from a
 * previous pairing cannot poison the next.
 *
 * Decoded frames are an Android-only global cache (iOS keeps `UIImage` on the
 * view). They are separately byte-budgeted via [DecodedAvatar.byteCost] /
 * `allocationByteCount` and downsampled to [DEFAULT_MAX_DECODE_EDGE] — that
 * 32 MiB bitmap ceiling is not an iOS `NSCache` counterpart.
 *
 * Memory only — never writes attachment bytes, bearer tokens, or signed URLs
 * to disk (§6). [bitmapFor] must be called from a `LaunchedEffect(path)`,
 * never from a draw lambda.
 */
class AvatarImageStore(
    private val fetch: suspend (Bot) -> ByteArray?,
    private val decode: (ByteArray) -> DecodedAvatar? = DEFAULT_DECODE,
    maxEntries: Int = DEFAULT_MAX_ENTRIES,
    maxBytes: Int = DEFAULT_MAX_BYTES,
    maxBitmapEntries: Int = DEFAULT_MAX_BITMAP_ENTRIES,
    maxBitmapBytes: Int = DEFAULT_MAX_BITMAP_BYTES,
) {
    private val cache = BoundedCostCache<ByteArray>(
        maxEntries = maxEntries,
        maxBytes = maxBytes,
        costOf = ByteArray::size,
    )
    private val bitmaps = BoundedCostCache<DecodedAvatar>(
        maxEntries = maxBitmapEntries,
        maxBytes = maxBitmapBytes,
        costOf = { it.byteCost },
    )
    private val mutex = Mutex()
    private val inflight = LinkedHashMap<String, Inflight>()
    private val decodeInflight = LinkedHashMap<String, CompletableDeferred<DecodedAvatar?>>()
    @Volatile
    private var generation = 0

    /**
     * Cached or freshly fetched bytes for [bot]'s `avatarUrl`.
     * Null when the bot has no URL, the fetch fails, or [clear] raced the
     * in-flight request (same generation gate as iOS).
     */
    suspend fun bytesFor(bot: Bot): ByteArray? {
        val path = bot.avatarUrl ?: return null
        cache.get(path)?.let { return it }

        val gen = generation
        val claim = mutex.withLock {
            cache.get(path)?.let { return@withLock Claim.Hit(it) }
            val existing = inflight[path]
            if (existing != null) {
                Claim.Join(existing)
            } else {
                val created = Inflight(id = UUID.randomUUID(), deferred = CompletableDeferred())
                inflight[path] = created
                Claim.Lead(created)
            }
        }

        when (claim) {
            is Claim.Hit -> return claim.data
            is Claim.Join -> {
                coroutineContext.ensureActive()
                return claim.request.deferred.await()
            }
            is Claim.Lead -> {
                val data = try {
                    fetch(bot)
                } catch (error: Throwable) {
                    finish(path, claim.request, result = null, gen = gen)
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    return null
                }
                finish(path, claim.request, result = data, gen = gen)
                coroutineContext.ensureActive()
                return claim.request.deferred.await()
            }
        }
    }

    /**
     * Decoded bitmap for [bot], cached by attachment path.
     * Returns the same instance on repeat calls so Compose identity stays stable
     * across scroll recompositions. Concurrent first decodes of the same path
     * share one worker. Null on missing URL, fetch failure, or undecodable /
     * over-budget bytes (UI falls back to the mascot, like iOS).
     *
     * Cancelling the leader always removes the in-flight entry and completes
     * joiners — otherwise a roster leave during the first decode can leave
     * another consumer of the same path waiting forever.
     */
    suspend fun bitmapFor(bot: Bot): Bitmap? {
        val path = bot.avatarUrl ?: return null
        bitmaps.get(path)?.let { return it.asBitmap() }
        val data = bytesFor(bot) ?: return null
        val gen = generation

        val claim = mutex.withLock {
            bitmaps.get(path)?.let { return@withLock DecodeClaim.Hit(it) }
            val existing = decodeInflight[path]
            if (existing != null) {
                DecodeClaim.Join(existing)
            } else {
                val created = CompletableDeferred<DecodedAvatar?>()
                decodeInflight[path] = created
                DecodeClaim.Lead(created)
            }
        }

        when (claim) {
            is DecodeClaim.Hit -> return claim.avatar.asBitmap()
            is DecodeClaim.Join -> {
                coroutineContext.ensureActive()
                return claim.deferred.await()?.asBitmap()
            }
            is DecodeClaim.Lead -> {
                // Decode may be stuck in non-interruptible work (BitmapFactory /
                // a test latch). A try/finally around withContext only runs after
                // that work returns — too late for joiners. The UNDISPATCHED
                // watcher completes them on the transition to cancelling.
                return coroutineScope {
                    val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            awaitCancellation()
                        } finally {
                            completeDecode(
                                path = path,
                                deferred = claim.deferred,
                                decoded = null,
                                gen = gen,
                            )
                        }
                    }
                    try {
                        val decoded = withContext(Dispatchers.Default) {
                            try {
                                decode(data)
                            } catch (_: OutOfMemoryError) {
                                null
                            }
                        }
                        completeDecode(
                            path = path,
                            deferred = claim.deferred,
                            decoded = decoded,
                            gen = gen,
                        )
                        coroutineContext.ensureActive()
                        claim.deferred.await()?.asBitmap()
                    } finally {
                        watcher.cancel()
                    }
                }
            }
        }
    }

    /** Drop every entry and abandon in-flight work — call on sign-out. */
    suspend fun clear() {
        val pending = mutex.withLock {
            generation += 1
            val waiting = inflight.values.toList()
            val decoding = decodeInflight.values.toList()
            inflight.clear()
            decodeInflight.clear()
            cache.clear()
            bitmaps.clear()
            waiting to decoding
        }
        pending.first.forEach { it.deferred.complete(null) }
        pending.second.forEach { it.complete(null) }
    }

    /**
     * Non-suspending clear for Application observers.
     * Always bumps [generation] so a leader that finishes later discards its put.
     */
    fun clearBlocking() {
        generation += 1
        if (mutex.tryLock()) {
            try {
                val pending = inflight.values.toList()
                val decoding = decodeInflight.values.toList()
                inflight.clear()
                decodeInflight.clear()
                cache.clear()
                bitmaps.clear()
                pending.forEach { it.deferred.complete(null) }
                decoding.forEach { it.complete(null) }
            } finally {
                mutex.unlock()
            }
        } else {
            cache.clear()
            bitmaps.clear()
        }
    }

    /** Test / diagnostics: current resident byte entries. */
    internal fun cachedEntryCount(): Int = cache.size()

    /** Test / diagnostics: current resident byte cost. */
    internal fun cachedByteCost(): Int = cache.byteCost()

    /** Test / diagnostics: current resident decoded frames. */
    internal fun cachedBitmapCount(): Int = bitmaps.size()

    /** Test / diagnostics: current resident decoded frame byte cost. */
    internal fun cachedBitmapByteCost(): Int = bitmaps.byteCost()

    /**
     * Remove the in-flight byte entry and complete joiners.
     *
     * Under [NonCancellable] for the same reason [completeDecode] is, and the
     * asymmetry between the two was a real hole rather than a stylistic one.
     * The leader reaches here from a `catch` that a cancellation put it in, so
     * its job is already cancelling; `Mutex.lock` only checks for cancellation
     * *when it has to suspend*, which is exactly when another coroutine holds
     * the lock. In that window the cleanup threw before removing [inflight] or
     * completing the deferred — and every joiner already parked on that
     * deferred, plus every later caller of the same path, then waited forever
     * for a leader that was gone.
     */
    private suspend fun finish(
        path: String,
        request: Inflight,
        result: ByteArray?,
        gen: Int,
    ) {
        withContext(NonCancellable) {
            mutex.withLock {
                if (inflight[path]?.id == request.id) inflight.remove(path)
                val keep = gen == generation
                if (keep && result != null) cache.putIfAbsent(path, result)
                request.deferred.complete(if (keep) result else null)
            }
        }
    }

    /**
     * Remove the in-flight decode entry and complete joiners.
     * Idempotent: a cancel watcher and the success path may both call this.
     * Always runs under [NonCancellable] so a cancelled leader can still finish.
     */
    private suspend fun completeDecode(
        path: String,
        deferred: CompletableDeferred<DecodedAvatar?>,
        decoded: DecodedAvatar?,
        gen: Int,
    ) {
        withContext(NonCancellable) {
            mutex.withLock {
                if (decodeInflight[path] === deferred) {
                    decodeInflight.remove(path)
                }
                if (!deferred.isCompleted) {
                    val keep = gen == generation && decoded != null
                    val stored = if (keep) bitmaps.putIfAbsent(path, decoded!!) else null
                    deferred.complete(stored)
                }
            }
        }
    }

    private sealed class Claim {
        data class Hit(val data: ByteArray) : Claim()
        data class Join(val request: Inflight) : Claim()
        data class Lead(val request: Inflight) : Claim()
    }

    private sealed class DecodeClaim {
        data class Hit(val avatar: DecodedAvatar) : DecodeClaim()
        data class Join(val deferred: CompletableDeferred<DecodedAvatar?>) : DecodeClaim()
        data class Lead(val deferred: CompletableDeferred<DecodedAvatar?>) : DecodeClaim()
    }

    private data class Inflight(
        val id: UUID,
        val deferred: CompletableDeferred<ByteArray?>,
    )

    companion object {
        const val DEFAULT_MAX_ENTRIES: Int = 64
        const val DEFAULT_MAX_BYTES: Int = 32 * 1_024 * 1_024
        const val DEFAULT_MAX_BITMAP_ENTRIES: Int = 64
        /**
         * Android-only decoded-frame ceiling. Encoded-byte cache above matches
         * iOS `NSCache`; this second budget exists because Android retains
         * bitmaps globally for roster scroll identity.
         */
        const val DEFAULT_MAX_BITMAP_BYTES: Int = 32 * 1_024 * 1_024
        /**
         * Longest edge after decode. Profile heroes stay under ~200 dp (~800 px at
         * xxxhdpi); 1024 leaves headroom while capping a 10 MB JPEG that would
         * otherwise expand to hundreds of MB as ARGB.
         */
        const val DEFAULT_MAX_DECODE_EDGE: Int = 1_024

        val DEFAULT_DECODE: (ByteArray) -> DecodedAvatar? = { bytes ->
            decodeBounded(bytes, maxEdge = DEFAULT_MAX_DECODE_EDGE)?.let { DecodedAvatar.fromBitmap(it) }
        }

        /**
         * Bounds-then-sample decode. Rejects undecodable payloads; never retains
         * a full-resolution camera frame in the global cache.
         */
        fun decodeBounded(bytes: ByteArray, maxEdge: Int = DEFAULT_MAX_DECODE_EDGE): Bitmap? {
            if (bytes.isEmpty() || maxEdge <= 0) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val sample = inSampleSizeFor(bounds.outWidth, bounds.outHeight, maxEdge)
            val options = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            return try {
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            } catch (_: OutOfMemoryError) {
                null
            }
        }

        /** Power-of-two sample that fits both edges within [maxEdge]. */
        fun inSampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
            if (width <= 0 || height <= 0 || maxEdge <= 0) return 1
            var sample = 1
            var w = width
            var h = height
            while (w > maxEdge || h > maxEdge) {
                sample *= 2
                w /= 2
                h /= 2
            }
            return sample
        }
    }
}

/**
 * Access-ordered cache with entry and byte-cost eviction. Used for both the
 * encoded-byte and decoded-frame budgets.
 * Drops the map reference only on eviction — never [Bitmap.recycle], because
 * roster/header may still be drawing that instance after eviction or sign-out.
 */
internal class BoundedCostCache<T>(
    private val maxEntries: Int,
    private val maxBytes: Int,
    private val costOf: (T) -> Int,
) {
    private val map = LinkedHashMap<String, T>(16, 0.75f, true)
    private var totalBytes = 0

    @Synchronized
    fun get(key: String): T? = map[key]

    @Synchronized
    fun putIfAbsent(key: String, value: T): T {
        val existing = map[key]
        if (existing != null) return existing
        val cost = costOf(value).coerceAtLeast(0)
        while (map.isNotEmpty() &&
            (map.size >= maxEntries || totalBytes + cost > maxBytes)
        ) {
            val eldest = map.entries.iterator().next()
            totalBytes -= costOf(eldest.value).coerceAtLeast(0)
            map.remove(eldest.key)
        }
        map[key] = value
        totalBytes += cost
        return value
    }

    @Synchronized
    fun clear() {
        map.clear()
        totalBytes = 0
    }

    @Synchronized
    fun size(): Int = map.size

    @Synchronized
    fun byteCost(): Int = totalBytes
}
