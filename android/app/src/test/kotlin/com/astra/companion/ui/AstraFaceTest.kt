package com.astra.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Invariants the catalogue has to hold whatever the numbers are: a ring that is a
 * ring, a mouth below the eyes, a state that has somewhere to start. Whether the
 * numbers are still the desktop's is a different question, and
 * `AstraCatalogueGoldenTest` is where it is asked.
 */
class AstraFaceDataTest {

    @Test
    fun `every state has a pool, a cadence and a motion`() {
        assertEquals(40, AstraState.entries.size)
        for (state in AstraState.entries) {
            assertTrue(AstraFaceData.pools.containsKey(state), "pool ${state.id}")
            assertTrue(AstraFaceData.expressionCadence.containsKey(state), "cadence ${state.id}")
            assertTrue(AstraFaceData.motion.containsKey(state), "motion ${state.id}")
        }
    }

    @Test
    fun `every pool points into the catalogue and starts with a resting face`() {
        for ((state, pool) in AstraFaceData.pools) {
            assertTrue(pool.isNotEmpty(), "empty pool ${state.id}")
            for (expression in pool) {
                assertTrue(expression in 0 until AstraFaceData.EXPRESSION_COUNT, "${state.id} → $expression")
            }
        }
    }

    @Test
    fun `a cadence and a blink rhythm are a span, not a point going backwards`() {
        for ((state, range) in AstraFaceData.expressionCadence) {
            assertTrue(range.minMillis > 0f && range.maxMillis >= range.minMillis, state.id)
        }
        for ((state, range) in AstraFaceData.blink) {
            assertTrue(range.minMillis > 0f && range.maxMillis >= range.minMillis, state.id)
        }
    }

    @Test
    fun `every expression is two rings of 48 points around the face centre`() {
        val ring = FloatArray(AstraFaceData.RING_STRIDE)
        for (expression in 0 until AstraFaceData.EXPRESSION_COUNT) {
            for (eye in 0..1) {
                AstraFaceData.copyRing(expression, eye, ring)
                var minX = Float.MAX_VALUE
                var maxX = -Float.MAX_VALUE
                var minY = Float.MAX_VALUE
                var maxY = -Float.MAX_VALUE
                var index = 0
                while (index < ring.size) {
                    minX = minOf(minX, ring[index])
                    maxX = maxOf(maxX, ring[index])
                    minY = minOf(minY, ring[index + 1])
                    maxY = maxOf(maxY, ring[index + 1])
                    index += 2
                }
                assertTrue(maxX - minX > 1f && maxY - minY > 1f, "flat ring $expression/$eye")
                assertTrue(minX >= 0f && maxX <= AstraFaceData.FACE_BOX, "ring $expression/$eye off the face")
                assertTrue(minY >= 0f && maxY <= AstraFaceData.FACE_BOX, "ring $expression/$eye off the face")
            }
        }
        // the first ring is the left eye, in every expression
        val left = FloatArray(AstraFaceData.RING_STRIDE)
        val right = FloatArray(AstraFaceData.RING_STRIDE)
        for (expression in 0 until AstraFaceData.EXPRESSION_COUNT) {
            AstraFaceData.copyRing(expression, 0, left)
            AstraFaceData.copyRing(expression, 1, right)
            assertTrue(centreX(left) < centreX(right), "eyes swapped in $expression")
        }
    }

    private fun centreX(ring: FloatArray): Float {
        var total = 0f
        var index = 0
        while (index < ring.size) {
            total += ring[index]
            index += 2
        }
        return total / (ring.size / 2)
    }

    @Test
    fun `every expression has a mouth wide enough to see, below the eyes`() {
        val mouth = FloatArray(AstraFaceData.MOUTH_STRIDE)
        for (expression in 0 until AstraFaceData.EXPRESSION_COUNT) {
            AstraFaceData.copyMouth(expression, mouth)
            assertTrue(mouth[AstraFaceData.MOUTH_HALF_WIDTH] > 0f, "no mouth in $expression")
            assertTrue(mouth[AstraFaceData.MOUTH_GAP] > 0f, "mouth on the eyes in $expression")
        }
    }
}

/**
 * The frame loop. What matters most here is the pose a face holds when nothing is
 * driving it: that is what an avatar shows when the system says animations are off,
 * and it has to be the state's own face rather than a blank or a fallback.
 *
 * Which face that is comes from [AstraGolden], not from the pools being tested.
 */
class AstraFaceEngineTest {
    private val ring = FloatArray(AstraFaceData.RING_STRIDE)
    private val mouth = FloatArray(AstraFaceData.MOUTH_STRIDE)

    @Test
    fun `a face that is never advanced rests on the desktop's face for its state`() {
        for (state in AstraState.entries) {
            val engine = AstraFaceEngine()
            engine.setState(state, 0L)
            val expression = AstraGolden.RESTING.getValue(state.id)

            for (eye in 0..1) {
                AstraFaceData.copyRing(expression, eye, ring)
                val offsetX = AstraGolden.GAZE[expression * 2] * LOOK_AROUND
                val offsetY = AstraGolden.GAZE[expression * 2 + 1] * LOOK_AROUND
                val worn = engine.ring(eye)
                var index = 0
                while (index < ring.size) {
                    assertEquals(ring[index] + offsetX, worn[index], 0.001f, "${state.id} eye $eye")
                    assertEquals(ring[index + 1] + offsetY, worn[index + 1], 0.001f, "${state.id} eye $eye")
                    index += 2
                }
            }

            for (index in mouth.indices) {
                assertEquals(AstraGolden.MOUTHS[expression * 4 + index], engine.mouth()[index], 0.001f, state.id)
            }
            // eyes open, and a body left where it stands
            assertEquals(1f, engine.blinkScale(0L))
            assertEquals(0f, engine.elapsedMillis(0L))
        }
    }

    @Test
    fun `the morph settles on the face of the state it was handed`() {
        val engine = AstraFaceEngine()
        engine.setState(AstraState.IDLE, 0L)
        engine.advance(0L)
        engine.setState(AstraState.LAUGHING, 0L)

        val target = AstraGolden.RESTING.getValue(AstraState.LAUGHING.id)
        AstraFaceData.copyRing(target, 0, ring)
        assertTrue(kotlin.math.abs(engine.ring(0)[0] - ring[0]) > 1f, "morphed with no morph in")

        // a second of frames, and short of the state's own 1.2s cadence
        for (frame in 1..30) engine.advance(frame * FRAME_NANOS)

        val offsetX = AstraGolden.GAZE[target * 2] * LOOK_AROUND
        assertEquals(ring[0] + offsetX, engine.ring(0)[0], 0.5f)
    }

    @Test
    fun `a face that stops being advanced settles on the state it was handed`() {
        val engine = AstraFaceEngine()
        engine.setState(AstraState.IDLE, 0L)
        engine.advance(0L)
        engine.setState(AstraState.ANGRY, 0L)
        engine.advance(FRAME_NANOS)
        engine.rest()

        val target = AstraGolden.RESTING.getValue(AstraState.ANGRY.id)
        AstraFaceData.copyRing(target, 0, ring)
        val offsetX = AstraGolden.GAZE[target * 2] * LOOK_AROUND
        assertEquals(ring[0] + offsetX, engine.ring(0)[0], 0.001f)
        assertEquals(1f, engine.blinkScale(FRAME_NANOS))
    }

    @Test
    fun `a state that blinks shuts its eyes and opens them again`() {
        val engine = AstraFaceEngine()
        engine.setState(AstraState.IDLE, 0L)
        var shut = 1f
        var open = 0f
        // past the longest gap between blinks the desktop allows for idle
        for (frame in 0..15 * 30) {
            engine.advance(frame * FRAME_NANOS)
            val scale = engine.blinkScale(frame * FRAME_NANOS)
            shut = minOf(shut, scale)
            open = maxOf(open, scale)
        }
        assertTrue(shut < 0.5f, "never blinked")
        assertEquals(1f, open)
    }

    @Test
    fun `a state with no blink rhythm never blinks`() {
        val engine = AstraFaceEngine()
        engine.setState(AstraState.SLEEPING, 0L)
        for (frame in 0..60 * 30) {
            engine.advance(frame * FRAME_NANOS)
            assertEquals(1f, engine.blinkScale(frame * FRAME_NANOS), "blinked while asleep")
        }
    }

    @Test
    fun `a run of frames keeps the face inside the catalogue`() {
        for (state in AstraState.entries) {
            val engine = AstraFaceEngine()
            engine.setState(state, 0L)
            for (frame in 0..20 * 30) {
                engine.advance(frame * FRAME_NANOS)
                val worn = engine.ring(0)
                for (value in worn) assertTrue(value.isFinite(), "${state.id} lost a point")
            }
        }
    }

    private companion object {
        const val FRAME_NANOS = 1_000_000_000L / 30
        /** `AstraAvatar.swift:277`. */
        const val LOOK_AROUND = 0.35f
    }
}

/**
 * The body's own movement. The numbers below are the desktop's, written out rather
 * than read back from the motion table they are checking.
 */
class AstraBodyPoseTest {
    private val pose = AstraBodyPose()

    @Test
    fun `a state with no motion leaves the body where it stands`() {
        AstraFaceData.motion.getValue(AstraState.THINKING_DOTS).poseAt(1234f, pose)
        assertEquals(0f, pose.dx)
        assertEquals(0f, pose.dy)
        assertEquals(0f, pose.rotationDegrees)
        assertEquals(1f, pose.scale)
        assertEquals(1f, pose.squashX)
        assertEquals(1f, pose.squashY)
    }

    @Test
    fun `a tilt is held for as long as the state is`() {
        val dragging = AstraFaceData.motion.getValue(AstraState.DRAGGING)
        dragging.poseAt(0f, pose)
        assertEquals(-6f, pose.rotationDegrees, 0.001f)
    }

    @Test
    fun `a bob lifts the body, and squashes it as it lands`() {
        // bouncing bobs 12 units over 560ms and squashes 0.45 on the way down
        val bouncing = AstraFaceData.motion.getValue(AstraState.BOUNCING)

        bouncing.poseAt(140f, pose)
        assertEquals(-12f, pose.dy, 0.001f)
        assertEquals(1f, pose.squashX, 0.001f)
        assertEquals(1f, pose.squashY, 0.001f)

        bouncing.poseAt(420f, pose)
        assertEquals(12f, pose.dy, 0.001f)
        assertEquals(1.225f, pose.squashX, 0.001f)
        assertEquals(0.775f, pose.squashY, 0.001f)
    }

    @Test
    fun `an entrance grows to full size and then stops growing`() {
        // spawning enters at 2% of its size over 820ms, then only breathes: ±1.4%
        val spawning = AstraFaceData.motion.getValue(AstraState.SPAWNING)

        spawning.poseAt(0f, pose)
        assertEquals(0.02f, pose.scale, 0.001f)

        spawning.poseAt(1640f, pose)
        assertTrue(kotlin.math.abs(pose.scale - 1f) <= 0.014f + 0.001f, "still entering at ${pose.scale}")
    }
}

/**
 * The rings the working states wear. They are cut at the horizon so the body can
 * be drawn between the halves; both halves have to exist, or the ring stops
 * reading as an orbit.
 */
class AstraCometFieldTest {
    @Test
    fun `a comet ring passes behind the body and in front of it`() {
        val field = AstraCometField()
        val spec = AstraComets.trails.getValue(AstraState.ORBIT)
        var behind = 0
        var front = 0
        for (frame in 0 until 90) {
            field.update(spec, frame * 33f, CENTRE, CENTRE)
            for (index in 0 until field.count) {
                if (field.piece(index).front) front++ else behind++
            }
        }
        assertTrue(behind > 0, "nothing passed behind")
        assertTrue(front > 0, "nothing passed in front")
    }

    @Test
    fun `every piece is an outline that fits its buffer`() {
        val field = AstraCometField()
        for (spec in AstraComets.trails.values) {
            for (frame in 0 until 30) {
                field.update(spec, frame * 40f, CENTRE, CENTRE)
                assertTrue(field.count <= spec.count * 4, "too many pieces")
                for (index in 0 until field.count) {
                    val piece = field.piece(index)
                    assertTrue(piece.points >= 3, "a piece with no shape")
                    assertTrue(piece.points * 2 <= piece.outline.size, "outline overflowed")
                    assertTrue(piece.colorIndex in AstraComets.colors.indices)
                    for (point in 0 until piece.points * 2) {
                        assertTrue(piece.outline[point].isFinite(), "a piece flew off")
                    }
                }
            }
        }
    }

    @Test
    fun `an empty frame leaves nothing behind from the last one`() {
        val field = AstraCometField()
        field.update(AstraComets.trails.getValue(AstraState.ORBIT), 0f, CENTRE, CENTRE)
        assertTrue(field.count > 0)
        field.update(AstraComets.trails.getValue(AstraState.RADAR).copy(count = 0), 0f, CENTRE, CENTRE)
        assertEquals(0, field.count)
    }

    private companion object {
        const val CENTRE = AstraFaceData.FACE_BOX / 2f
    }
}
