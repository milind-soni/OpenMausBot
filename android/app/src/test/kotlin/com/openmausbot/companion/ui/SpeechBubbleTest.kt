package com.openmausbot.companion.ui

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * DELTA-06: the tailed bubble, pinned against `ios/App/SpeechBubble.swift`.
 *
 * The Swift's own header states the reference the tail is traced from: "a 772×428
 * pill whose right cap has this radius [179], whose right edge is at x=766.342 and
 * bottom edge at y=361.317, and whose tail hangs 68 below the bottom edge". Every
 * expectation below comes from that sentence and from the four Bézier segments
 * listed in `referenceTail`, typed out here independently of the Kotlin table.
 */
class SpeechBubbleTest {

    @Test
    fun `the drop is the reference drop, scaled by the corner radius`() {
        // `tailDrop` is `cornerRadius / referenceCapRadius * referenceTailDrop`,
        // so a bubble drawn at the reference's own cap radius drops exactly 68.
        assertEquals(68f, SpeechBubble.tailDrop(179.dp).value, TOLERANCE)
        // Half the cap, half the drop.
        assertEquals(34f, SpeechBubble.tailDrop(89.5.dp).value, TOLERANCE)
        // The bubble as the transcript actually draws it: 22 / 179 * 68.
        assertEquals(22f * 68f / 179f, SpeechBubble.tailDrop(22.dp).value, TOLERANCE)
        assertEquals(0f, SpeechBubble.tailDrop(0.dp).value, TOLERANCE)
    }

    @Test
    fun `the default radius is the one the Swift declares`() {
        assertEquals(22f, SpeechBubble.CORNER_RADIUS.value, TOLERANCE)
        assertEquals(SpeechBubble.tailDrop(), SpeechBubble.tailDrop(22.dp))
    }

    @Test
    fun `at the reference cap radius the tail is the reference drawing itself`() {
        // Put the bubble's bottom-right exactly on the reference origin and scale
        // by one: `map` is then the identity, so the curves must come back as the
        // literal coordinates in `referenceTail`.
        val curves = tailCurves(
            width = REFERENCE_ORIGIN_X,
            height = REFERENCE_ORIGIN_Y,
            radius = REFERENCE_CAP_RADIUS,
        )
        val expected = floatArrayOf(
            766.342f, 249.767f, 727.342f, 299.817f, 699.842f, 323.317f,
            699.842f, 323.317f, 677.085f, 338.817f, 674.342f, 354.817f,
            668.342f, 389.817f, 700.829f, 410.817f, 691.829f, 421.317f,
            684.629f, 429.717f, 615.056f, 378.235f, 580.342f, 361.317f,
        )
        assertEquals(24, curves.size)
        expected.indices.forEach { assertEquals(expected[it], curves[it], TOLERANCE) }
    }

    @Test
    fun `halving the radius halves every offset from the bubble's corner`() {
        val corner = Offset(300f, 120f)
        val full = tailCurves(corner.x, corner.y, REFERENCE_CAP_RADIUS)
        val half = tailCurves(corner.x, corner.y, REFERENCE_CAP_RADIUS / 2f)
        var index = 0
        while (index < full.size) {
            assertEquals((full[index] - corner.x) / 2f, half[index] - corner.x, TOLERANCE)
            assertEquals((full[index + 1] - corner.y) / 2f, half[index + 1] - corner.y, TOLERANCE)
            index += 2
        }
    }

    @Test
    fun `the tail lands back on the bottom edge, left of the corner`() {
        // The Swift's last segment ends at the reference's y=361.317 — the bottom
        // edge — and at x=580.342, which is 186 to the left of the right edge.
        val curves = tailCurves(width = 200f, height = 90f, radius = REFERENCE_CAP_RADIUS)
        assertEquals(200f - 186f, curves[LAST_END_X], TOLERANCE)
        assertEquals(90f, curves[LAST_END_Y], TOLERANCE)
    }

    @Test
    fun `the leading tail is the trailing one mirrored about the centre line`() {
        // `CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0)
        //  .scaledBy(x: -1, y: 1)` — with minX at zero that is `x' = width - x`,
        // and y untouched.
        val mirror = mirrorAcross(100f)
        assertEquals(Offset(70f, 7f), mirror.map(Offset(30f, 7f)))
        assertEquals(Offset(0f, 0f), mirror.map(Offset(100f, 0f)))
        assertEquals(Offset(50f, -3f), mirror.map(Offset(50f, -3f)))
    }

    @Test
    fun `what you said is filled with the mascot palette's blue, not the system's`() {
        // `BubbleColor.mine = MausPalette.color("blue")`, and `mineText = .white`.
        assertEquals(0xFF377FE6.toInt(), BubbleColor.defaultMine.toArgb())
        assertEquals(0xFFFFFFFF.toInt(), BubbleColor.defaultMineText.toArgb())
    }

    private companion object {
        const val TOLERANCE = 1e-3f
        const val REFERENCE_CAP_RADIUS = 179f
        const val REFERENCE_ORIGIN_X = 766.342f
        const val REFERENCE_ORIGIN_Y = 361.317f

        /** The fourth cubic's end point: `4 * 6 - 2` and `4 * 6 - 1`. */
        const val LAST_END_X = 22
        const val LAST_END_Y = 23
    }
}
