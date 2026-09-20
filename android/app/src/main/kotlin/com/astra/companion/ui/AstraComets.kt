package com.astra.companion.ui

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** A ring of comets orbiting the body — the desktop's `trails`, per state. */
internal data class AstraCometSpec(
    val count: Int,
    /** One orbit, in milliseconds. */
    val periodMillis: Float,
    /** Face units. */
    val radius: Float,
    /** Half-width at the head. */
    val width: Float,
    /** How much of the orbit one comet covers, in radians. */
    val span: Float,
    /** The body's resting scale while the rings are out, so they clear it. */
    val bodyScale: Float,
)

internal object AstraComets {
    val trails: Map<AstraState, AstraCometSpec> = mapOf(
        AstraState.ORBIT to AstraCometSpec(6, 3000f, 105f, 5f, 2.5f, 0.72f),
        AstraState.RADAR to AstraCometSpec(4, 2400f, 106f, 4.5f, 2.1f, 0.72f),
        AstraState.PROGRESS to AstraCometSpec(5, 2000f, 104f, 4.8f, 2.3f, 0.74f),
        AstraState.LOADING to AstraCometSpec(5, 2400f, 105f, 5f, 2.6f, 0.72f),
        AstraState.UPLOADING to AstraCometSpec(4, 1800f, 104f, 4.8f, 2.2f, 0.74f),
    )

    /**
     * One palette per comet: three neighbouring hues along its length. A flat
     * colour reads as wire; a hue that travels reads as something lit.
     */
    val colors: Array<IntArray> = arrayOf(
        intArrayOf(0xFFA855F7.toInt(), 0xFF6366F1.toInt(), 0xFF38BDF8.toInt()),
        intArrayOf(0xFF22D3EE.toInt(), 0xFF34D399.toInt(), 0xFFA3E635.toInt()),
        intArrayOf(0xFFFB923C.toInt(), 0xFFF43F5E.toInt(), 0xFFD946EF.toInt()),
        intArrayOf(0xFF818CF8.toInt(), 0xFFC084FC.toInt(), 0xFFF472B6.toInt()),
        intArrayOf(0xFFFACC15.toInt(), 0xFFFB923C.toInt(), 0xFFEC4899.toInt()),
        intArrayOf(0xFF34D399.toInt(), 0xFF22D3EE.toInt(), 0xFF60A5FA.toInt()),
    )
}

/**
 * The comets for one frame — the port of the trail geometry in
 * `ios/App/AstraAvatar.swift`.
 *
 * Each comet is sampled along its tilted ring and cut at the horizon into pieces
 * that pass behind the body and pieces that pass in front of it, so the body can
 * be drawn between the two. A piece is a filled, tapered outline rather than a
 * stroke: a comet has to thin out towards its tail.
 *
 * Held by the avatar and refilled in place — the buffers are the point.
 */
internal class AstraCometField {
    /** One drawable slice of one comet: a closed outline plus how to paint it. */
    class Piece internal constructor() {
        /** Interleaved x, y; only the first [points] * 2 entries are this frame's. */
        val outline: FloatArray = FloatArray(MAX_OUTLINE * 2)
        var points: Int = 0
            internal set
        var front: Boolean = false
            internal set
        var colorIndex: Int = 0
            internal set

        /** One gradient across the whole comet, so a hue runs head to tail across a cut. */
        var gradientStartX: Float = 0f
            internal set
        var gradientStartY: Float = 0f
            internal set
        var gradientEndX: Float = 0f
            internal set
        var gradientEndY: Float = 0f
            internal set
    }

    var count: Int = 0
        private set

    private val pieces = ArrayList<Piece>()
    private val sampleX = FloatArray(SAMPLES)
    private val sampleY = FloatArray(SAMPLES)
    private val sampleHalfWidth = FloatArray(SAMPLES)
    private val normalX = FloatArray(SAMPLES)
    private val normalY = FloatArray(SAMPLES)
    private val runStart = IntArray(MAX_RUNS)
    private val runEnd = IntArray(MAX_RUNS)
    private val runFront = BooleanArray(MAX_RUNS)

    fun piece(index: Int): Piece = pieces[index]

    fun update(spec: AstraCometSpec, elapsedMillis: Float, centreX: Float, centreY: Float) {
        count = 0
        val span = min(spec.span, (PI - 0.05).toFloat())

        for (comet in 0 until spec.count) {
            val seedA = hash01(comet + 3)
            val seedB = hash01(comet + 29)
            val seedC = hash01(comet + 71)
            // every ring its own tip, roll and speed, or they stack into one hoop
            val tilt = 0.3f + seedA * 0.66f
            val roll = seedB * 2f * PI.toFloat()
            val period = spec.periodMillis * (0.78f + seedC * 0.55f)
            val direction = if (comet % 2 == 0) 1f else -1f
            val radius = spec.radius * (0.94f + seedB * 0.12f)
            val head = direction * (elapsedMillis / period) * 2f * PI.toFloat() + seedA * 2f * PI.toFloat()
            val cosTilt = cos(tilt)
            val sinTilt = sin(tilt)
            val cosRoll = cos(roll)
            val sinRoll = sin(roll)

            var runs = 0
            var start = 0
            var side = 0
            for (index in 0 until SAMPLES) {
                val k = index.toFloat() / (SAMPLES - 1)
                val angle = head - direction * span * k
                val orbitX = cos(angle) * radius
                val orbitY = sin(angle) * radius
                val tiltedY = orbitY * cosTilt
                val depth = orbitY * sinTilt
                val near = 1f + (depth / radius) * (NEAR - 1f)
                sampleX[index] = centreX + (orbitX * cosRoll - tiltedY * sinRoll) * near
                sampleY[index] = centreY + (orbitX * sinRoll + tiltedY * cosRoll) * near
                // full at the head, a third by the tail — keeps it a comet, not a brush stroke
                sampleHalfWidth[index] = spec.width * near * (1f - 0.68f * k.pow(1.5f))

                val nowSide = if (depth >= 0f) 1 else -1
                if (nowSide != side) {
                    if (index > 0) {
                        if (runs < MAX_RUNS && keep(start, index - 1, spec.width)) {
                            runStart[runs] = start
                            runEnd[runs] = index - 1
                            runFront[runs] = side > 0
                            runs++
                        }
                        start = index - 1
                    }
                    side = nowSide
                }
            }
            if (runs < MAX_RUNS && keep(start, SAMPLES - 1, spec.width)) {
                runStart[runs] = start
                runEnd[runs] = SAMPLES - 1
                runFront[runs] = side > 0
                runs++
            }
            if (runs == 0) continue

            val gradientStart = runStart[0]
            val gradientEnd = runEnd[runs - 1]
            for (run in 0 until runs) {
                val piece = take()
                piece.front = runFront[run]
                piece.colorIndex = comet % AstraComets.colors.size
                piece.gradientStartX = sampleX[gradientStart]
                piece.gradientStartY = sampleY[gradientStart]
                piece.gradientEndX = sampleX[gradientEnd]
                piece.gradientEndY = sampleY[gradientEnd]
                outline(piece, runStart[run], runEnd[run], capHead = run == 0, capTail = run == runs - 1)
            }
        }
    }

    private fun take(): Piece {
        if (count == pieces.size) pieces.add(Piece())
        return pieces[count++]
    }

    /** A slice too short to read as a comet is not worth a cut. */
    private fun keep(start: Int, end: Int, width: Float): Boolean {
        if (end - start + 1 < 3) return false
        var length = 0f
        for (index in start + 1..end) {
            length += hypot(sampleX[index] - sampleX[index - 1], sampleY[index] - sampleY[index - 1])
        }
        return length > width * 3.5f
    }

    /**
     * Head→tail samples to one filled, tapered outline with half-round caps on the
     * true ends — a comet is an outline, not a stroke.
     */
    private fun outline(piece: Piece, start: Int, end: Int, capHead: Boolean, capTail: Boolean) {
        for (index in start..end) {
            val before = max(index - 1, start)
            val after = min(index + 1, end)
            val tangentX = sampleX[after] - sampleX[before]
            val tangentY = sampleY[after] - sampleY[before]
            val length = max(hypot(tangentX, tangentY), 0.0001f)
            normalX[index] = -tangentY / length
            normalY[index] = tangentX / length
        }

        piece.points = 0
        add(piece, sampleX[start] - normalX[start] * sampleHalfWidth[start], sampleY[start] - normalY[start] * sampleHalfWidth[start])
        if (capHead) cap(piece, start, -1f)
        for (index in start..end) {
            add(piece, sampleX[index] + normalX[index] * sampleHalfWidth[index], sampleY[index] + normalY[index] * sampleHalfWidth[index])
        }
        if (capTail) cap(piece, end, 1f)
        for (index in end downTo start + 1) {
            add(piece, sampleX[index] - normalX[index] * sampleHalfWidth[index], sampleY[index] - normalY[index] * sampleHalfWidth[index])
        }
    }

    private fun add(piece: Piece, x: Float, y: Float) {
        piece.outline[piece.points * 2] = x
        piece.outline[piece.points * 2 + 1] = y
        piece.points++
    }

    /** Half a round end, swept from one side of the tip to the other. */
    private fun cap(piece: Piece, index: Int, outwards: Float) {
        val x = sampleX[index]
        val y = sampleY[index]
        val halfWidth = sampleHalfWidth[index]
        val tangentX = normalY[index]
        val tangentY = -normalX[index]
        for (step in 1 until CAP_STEPS) {
            val angle = step.toFloat() / CAP_STEPS * PI.toFloat()
            val alongNormal = outwards * cos(angle)
            val alongTangent = outwards * sin(angle)
            add(
                piece,
                x + (normalX[index] * alongNormal + tangentX * alongTangent) * halfWidth,
                y + (normalY[index] * alongNormal + tangentY * alongTangent) * halfWidth,
            )
        }
    }

    private companion object {
        const val SAMPLES = 22
        /** A span shorter than half a turn crosses the horizon at most once. */
        const val MAX_RUNS = 4
        const val CAP_STEPS = 6
        const val MAX_OUTLINE = 2 * SAMPLES + 2 * CAP_STEPS
        /** Swell at the near point of the ring — perspective, cheaply. */
        const val NEAR = 1.1f

        fun hash01(n: Int): Float {
            val x = sin(n * 127.1 + 311.7) * 43758.5453
            return (x - floor(x)).toFloat()
        }
    }
}
