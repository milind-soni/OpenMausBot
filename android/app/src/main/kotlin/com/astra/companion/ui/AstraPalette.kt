package com.astra.companion.ui

/**
 * The mascot palette — `src/lib/mascot.ts` MAUS_COLORS, the same ten the desktop
 * and `ios/App/AstraAvatar.swift` use, with the same fallback grey. Rooms are
 * always `"blue"` (that lives in `:core`'s `Chat.RoomChat.color`).
 *
 * Plain ARGB ints rather than `Color` so the mapping is unit-testable on the JVM.
 */
object AstraPalette {
    const val FALLBACK: Int = 0xFF8E8E93.toInt()

    private val hex: Map<String, Int> = mapOf(
        "green" to 0xFF009957.toInt(),
        "blue" to 0xFF377FE6.toInt(),
        "red" to 0xFFD94B52.toInt(),
        "orange" to 0xFFE78531.toInt(),
        "purple" to 0xFF8057C8.toInt(),
        "cyan" to 0xFF0EA5C6.toInt(),
        "pink" to 0xFFD84F8B.toInt(),
        "yellow" to 0xFFD8A729.toInt(),
        "teal" to 0xFF01A492.toInt(),
        "coral" to 0xFFE5634E.toInt(),
    )

    val names: Set<String> get() = hex.keys

    fun argb(name: String): Int = hex[name] ?: FALLBACK

    /**
     * Linear mix in sRGB, matching the `mix()` the desktop uses to build its
     * gradient stops. Not perceptually correct, and deliberately so: the point is
     * to land on the same colours as the other screen.
     */
    fun mix(from: Int, to: Int, amount: Double): Int {
        val t = amount.coerceIn(0.0, 1.0)
        fun channel(shift: Int): Int {
            val a = (from shr shift) and 0xFF
            val b = (to shr shift) and 0xFF
            return (a + (b - a) * t).toInt().coerceIn(0, 255)
        }
        return (0xFF shl 24) or
            (channel(16) shl 16) or
            (channel(8) shl 8) or
            channel(0)
    }

    private const val WHITE = 0xFFFFFFFF.toInt()
    private const val BLACK = 0xFF000000.toInt()

    /** The three gradient stops the desktop draws the mascot with. */
    fun gradient(name: String): List<Pair<Float, Int>> {
        val base = argb(name)
        return listOf(
            0f to mix(base, WHITE, 0.55),
            0.55f to base,
            1f to mix(base, BLACK, 0.42),
        )
    }
}
