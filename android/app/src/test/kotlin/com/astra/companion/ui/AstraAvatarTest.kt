package com.astra.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner

/**
 * The palette and the silhouette are copied artwork. A copy that drifts is the
 * failure mode these guard against — a bot you know by its shape and colour must
 * look the same on the phone as it does on the laptop.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AstraAvatarTest {

    @Test
    fun `every ASTRA_COLORS entry maps to its desktop hex`() {
        assertEquals(0xFF009957.toInt(), AstraPalette.argb("green"))
        assertEquals(0xFF377FE6.toInt(), AstraPalette.argb("blue"))
        assertEquals(0xFFD94B52.toInt(), AstraPalette.argb("red"))
        assertEquals(0xFFE78531.toInt(), AstraPalette.argb("orange"))
        assertEquals(0xFF8057C8.toInt(), AstraPalette.argb("purple"))
        assertEquals(0xFF0EA5C6.toInt(), AstraPalette.argb("cyan"))
        assertEquals(0xFFD84F8B.toInt(), AstraPalette.argb("pink"))
        assertEquals(0xFFD8A729.toInt(), AstraPalette.argb("yellow"))
        assertEquals(0xFF01A492.toInt(), AstraPalette.argb("teal"))
        assertEquals(0xFFE5634E.toInt(), AstraPalette.argb("coral"))
        assertEquals(10, AstraPalette.names.size)
    }

    @Test
    fun `an unknown colour falls back to grey rather than crashing`() {
        assertEquals(AstraPalette.FALLBACK, AstraPalette.argb("chartreuse"))
        assertEquals(AstraPalette.FALLBACK, AstraPalette.argb(""))
        assertEquals(0xFF8E8E93.toInt(), AstraPalette.FALLBACK)
    }

    @Test
    fun `mix walks linearly between two colours in sRGB`() {
        val black = 0xFF000000.toInt()
        val white = 0xFFFFFFFF.toInt()
        assertEquals(black, AstraPalette.mix(black, white, 0.0))
        assertEquals(white, AstraPalette.mix(black, white, 1.0))
        assertEquals(0xFF7F7F7F.toInt(), AstraPalette.mix(black, white, 0.5))
    }

    @Test
    fun `the gradient is the desktop's three stops around the base colour`() {
        val stops = AstraPalette.gradient("green")
        assertEquals(listOf(0f, 0.55f, 1f), stops.map { it.first })
        assertEquals(AstraPalette.argb("green"), stops[1].second)
        // lighter at the top, darker at the bottom
        fun luminance(argb: Int) =
            ((argb shr 16) and 0xFF) + ((argb shr 8) and 0xFF) + (argb and 0xFF)
        assertTrue(luminance(stops[0].second) > luminance(stops[1].second))
        assertTrue(luminance(stops[2].second) < luminance(stops[1].second))
    }

    @Test
    fun `the shipped cursor body keeps the fixed tight artwork bounds in the face box`() {
        // Which is what puts the eyes and the mouth on the body rather than beside
        // it: every face coordinate is expressed in this box. The numbers are the
        // ones this file carried by hand before the catalog was generated.
        val bounds = AstraSilhouette.faceBoxBounds("cursor")
        assertEquals(0f, bounds.top, 0.01f)
        assertEquals(AstraFaceData.FACE_BOX, bounds.bottom, 0.01f)
        assertEquals(18.73f, bounds.left, 0.01f)
        assertEquals(209.81f, bounds.right, 0.01f)
        // the eye anchor sits inside the body it is painted on
        val anchor = AstraSilhouette.anchor("cursor")
        assertTrue(anchor.x in bounds.left..bounds.right)
        assertTrue(anchor.y in bounds.top..bounds.bottom)
    }
}
