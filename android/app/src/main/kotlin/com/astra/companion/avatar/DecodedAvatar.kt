package com.astra.companion.avatar

import android.graphics.Bitmap

/**
 * Cost-bearing decode result retained by [AvatarImageStore]'s bitmap cache.
 *
 * Production wraps a real [Bitmap] and reports [Bitmap.allocationByteCount].
 * JVM unit tests inject a stand-in via [forTest] so retention, cost-eviction,
 * shared decode, cancellation cleanup and OOM fallback can be proven without
 * Robolectric or a device — [BitmapFactory] itself remains a device check.
 */
class DecodedAvatar private constructor(
    private val bitmap: Bitmap?,
    val byteCost: Int,
) {
    fun asBitmap(): Bitmap? = bitmap

    companion object {
        fun fromBitmap(bitmap: Bitmap): DecodedAvatar =
            DecodedAvatar(
                bitmap = bitmap,
                byteCost = bitmap.allocationByteCount.coerceAtLeast(0),
            )

        /** Test seam: known memory cost, no Android [Bitmap]. */
        fun forTest(byteCost: Int): DecodedAvatar =
            DecodedAvatar(bitmap = null, byteCost = byteCost.coerceAtLeast(0))
    }
}
