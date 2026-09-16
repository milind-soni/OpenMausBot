package com.astra.companion.avatar

import com.astra.companion.core.AvatarCrop
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.yield

/**
 * Client-side limits and framing helpers for agent avatars.
 *
 * Numbers and messages come from `ios/App/AgentProfileView.swift` and
 * `ios/App/BotAvatarView.swift`. The paired `:core` client re-checks MIME and
 * size before upload; this layer rejects earlier so the UI can show the same
 * copy iOS shows without a round trip.
 */
object AvatarImageRules {
    /** Raw payload bytes — the same quantity iOS measures with `Data.count`. */
    const val MAX_BYTES: Int = 10 * 1_024 * 1_024

    const val TYPE_ERROR: String = "Choose a PNG, JPEG, GIF, or WebP image."
    const val SIZE_ERROR: String = "That image is larger than 10 MB."

    /**
     * MIME from magic bytes, matching `AgentProfileView.imageMIME`.
     * The picker/OS content type is ignored — only the payload decides.
     */
    fun imageMime(data: ByteArray): String? {
        if (data.size >= 4 &&
            data[0] == 0x89.toByte() &&
            data[1] == 0x50.toByte() &&
            data[2] == 0x4e.toByte() &&
            data[3] == 0x47.toByte()
        ) {
            return "image/png"
        }
        if (data.size >= 3 &&
            data[0] == 0xff.toByte() &&
            data[1] == 0xd8.toByte() &&
            data[2] == 0xff.toByte()
        ) {
            return "image/jpeg"
        }
        if (data.size >= 4 &&
            data[0] == 'G'.code.toByte() &&
            data[1] == 'I'.code.toByte() &&
            data[2] == 'F'.code.toByte() &&
            data[3] == '8'.code.toByte()
        ) {
            return "image/gif"
        }
        if (data.size >= 12 &&
            data[0] == 'R'.code.toByte() &&
            data[1] == 'I'.code.toByte() &&
            data[2] == 'F'.code.toByte() &&
            data[3] == 'F'.code.toByte() &&
            data[8] == 'W'.code.toByte() &&
            data[9] == 'E'.code.toByte() &&
            data[10] == 'B'.code.toByte() &&
            data[11] == 'P'.code.toByte()
        ) {
            return "image/webp"
        }
        return null
    }

    /**
     * Enforce type then size on [data] before any call into `:core`.
     * Size is `ByteArray.size` / Swift `Data.count` — not decoded pixels and
     * not `OpenableColumns.SIZE` metadata.
     */
    fun prepare(data: ByteArray): PreparedAvatar {
        val mime = imageMime(data) ?: return PreparedAvatar.Rejected(TYPE_ERROR)
        if (data.size > MAX_BYTES) return PreparedAvatar.Rejected(SIZE_ERROR)
        return PreparedAvatar.Ready(data = data, mime = mime)
    }

    /**
     * Read at most [MAX_BYTES] + 1 bytes so an oversized stream is rejected
     * without buffering the whole file into memory first.
     *
     * [capacityHint] may size the initial buffer (e.g. from
     * `OpenableColumns.SIZE`) but **never** decides acceptance — only the
     * counted body does, matching Swift `Data.count` / server `Buffer.byteLength`.
     *
     * Oversized bodies still go through [prepare] `(ByteArray)` so magic-byte
     * type wins over size, matching `AgentProfileView` (MIME then `Data.count`).
     * Cooperatively cancels between reads when the caller's job is cancelled.
     */
    suspend fun prepare(stream: InputStream, capacityHint: Long? = null): PreparedAvatar {
        val initial = capacityHint
            ?.takeIf { it > 0 }
            ?.toInt()
            ?.coerceAtMost(MAX_BYTES)
            ?: (16 * 1024)
        val buffer = ByteArrayOutputStream(initial.coerceAtLeast(16 * 1024))
        val chunk = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            // yield() is the cooperative cancel point: ensureActive alone does
            // not suspend, so a 10 MB read would otherwise finish in one slice
            // and ignore a lifecycle cancel issued after the first chunk.
            yield()
            coroutineContext.ensureActive()
            val space = (MAX_BYTES + 1) - total
            if (space <= 0) break
            val read = stream.read(chunk, 0, minOf(chunk.size, space))
            if (read < 0) break
            total += read
            buffer.write(chunk, 0, read)
        }
        return prepare(buffer.toByteArray())
    }

    /**
     * Upload must persist a drawable crop. iOS maps `.mascot` → `.circle` when
     * the user picks or generates an image (`AgentProfileView` upload/generate).
     */
    fun intendedUploadCrop(selected: AvatarCrop): AvatarCrop =
        if (selected == AvatarCrop.MASCOT) AvatarCrop.CIRCLE else selected

    /**
     * Whether the attachment should paint instead of the mascot — same predicate
     * as `BotAvatarView.usesImage`.
     */
    fun usesImage(crop: AvatarCrop, avatarUrl: String?, failed: Boolean): Boolean =
        crop != AvatarCrop.MASCOT && avatarUrl != null && !failed

    /**
     * Corner radius for the rounded mask: `size * 0.22` from `BotAvatarView`.
     * Circle / square / mascot do not use a corner radius.
     */
    fun roundedCornerRadius(size: Float): Float = size * ROUNDED_CORNER_FRACTION

    const val ROUNDED_CORNER_FRACTION: Float = 0.22f
}

sealed class PreparedAvatar {
    data class Ready(val data: ByteArray, val mime: String) : PreparedAvatar() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Ready) return false
            return mime == other.mime && data.contentEquals(other.data)
        }

        override fun hashCode(): Int = 31 * mime.hashCode() + data.contentHashCode()
    }

    data class Rejected(val message: String) : PreparedAvatar()
}
