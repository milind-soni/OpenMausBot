package com.astra.companion.ui

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The mascot's catalogue, transcribed from the source of truth —
 * `ios/App/AstraFaceData.swift` for the tables, `ios/App/AstraAvatar.swift` for the
 * comet rings — and kept here, in the test source set, where the code it describes
 * cannot reach it.
 *
 * That separation is the point. A test that asks the catalogue what it holds and
 * then agrees with the answer stays green through any drift; these numbers were
 * written down from the other platform, so a table that moves has to be moved here
 * too, deliberately, by someone who read the Swift.
 */
internal object AstraGolden {

    /** `AstraFaceData.swift:7-48`, in order. */
    val STATES: List<String> = listOf(
        "sleeping", "waking", "idle", "listening",
        "thinking", "searching", "working", "excited",
        "surprised", "suspicious", "angry", "drowsy",
        "happy", "curious", "confused", "bored",
        "proud", "shy", "sad", "laughing",
        "scared", "playful", "celebrate", "orbit",
        "radar", "progress", "thinking-dots", "spawning",
        "humming", "loading", "dictating", "sending",
        "receiving", "uploading", "writing", "notifying",
        "alerting", "bouncing", "dragging", "powering-down",
    )

    /** `AstraFaceData.swift:397-438`. The head of each pool is the state's resting face. */
    val POOLS: Map<String, List<Int>> = mapOf(
        "sleeping" to listOf(22, 13, 4),
        "waking" to listOf(13),
        "idle" to listOf(6, 0, 8),
        "listening" to listOf(1, 10, 19),
        "thinking" to listOf(17, 8, 16, 14, 5),
        "searching" to listOf(20, 15, 9, 3, 12, 18),
        "working" to listOf(10, 7, 16, 11),
        "excited" to listOf(2, 17, 21, 3, 11),
        "surprised" to listOf(21, 3),
        "suspicious" to listOf(5, 14, 23),
        "angry" to listOf(7, 16),
        "drowsy" to listOf(22, 4, 13),
        "happy" to listOf(19, 2, 11, 17),
        "curious" to listOf(21, 3, 0, 15),
        "confused" to listOf(8, 14, 5),
        "bored" to listOf(0, 4, 22),
        "proud" to listOf(2, 15, 8),
        "shy" to listOf(24, 0, 13),
        "sad" to listOf(22, 4, 13),
        "laughing" to listOf(2, 11, 17),
        "scared" to listOf(21, 3),
        "playful" to listOf(2, 17, 11, 8),
        "celebrate" to listOf(2, 8, 17),
        "orbit" to listOf(6, 0, 8),
        "radar" to listOf(6, 0, 8),
        "progress" to listOf(6, 0, 8),
        "thinking-dots" to listOf(6, 0, 8),
        "spawning" to listOf(3, 0),
        "humming" to listOf(6, 0, 8),
        "loading" to listOf(6, 0, 8),
        "dictating" to listOf(1, 10, 19),
        "sending" to listOf(6, 0, 8),
        "receiving" to listOf(19, 0, 8),
        "uploading" to listOf(15, 9, 8),
        "writing" to listOf(15, 9),
        "notifying" to listOf(21, 3, 0),
        "alerting" to listOf(21, 3),
        "bouncing" to listOf(2, 17),
        "dragging" to listOf(3, 15, 0),
        "powering-down" to listOf(22, 13),
    )

    /** `AstraFaceData.swift:440-481`, in milliseconds. */
    val CADENCE: Map<String, Pair<Int, Int>> = mapOf(
        "sleeping" to (6000 to 10000),
        "waking" to (800 to 800),
        "idle" to (9000 to 16000),
        "listening" to (2800 to 5000),
        "thinking" to (2000 to 3600),
        "searching" to (1000 to 1800),
        "working" to (1800 to 3200),
        "excited" to (1100 to 2000),
        "surprised" to (2500 to 4000),
        "suspicious" to (2600 to 4500),
        "angry" to (2200 to 3800),
        "drowsy" to (4000 to 8000),
        "happy" to (2500 to 4500),
        "curious" to (1800 to 3200),
        "confused" to (2200 to 3800),
        "bored" to (3500 to 6000),
        "proud" to (3500 to 6000),
        "shy" to (3000 to 5500),
        "sad" to (4000 to 7000),
        "laughing" to (1200 to 2400),
        "scared" to (900 to 1800),
        "playful" to (1500 to 3000),
        "celebrate" to (1400 to 2600),
        "orbit" to (4000 to 8000),
        "radar" to (4000 to 8000),
        "progress" to (4000 to 8000),
        "thinking-dots" to (4000 to 8000),
        "spawning" to (1200 to 1200),
        "humming" to (5000 to 9000),
        "loading" to (6000 to 10000),
        "dictating" to (4000 to 8000),
        "sending" to (4000 to 8000),
        "receiving" to (4000 to 8000),
        "uploading" to (4000 to 8000),
        "writing" to (4000 to 8000),
        "notifying" to (1500 to 2600),
        "alerting" to (2000 to 3600),
        "bouncing" to (3000 to 6000),
        "dragging" to (1600 to 3000),
        "powering-down" to (6000 to 9000),
    )

    /** `AstraFaceData.swift:483-507`. A state that is absent never blinks. */
    val BLINK: Map<String, Pair<Int, Int>> = mapOf(
        "idle" to (6000 to 14000),
        "listening" to (3000 to 7000),
        "thinking" to (3500 to 7000),
        "searching" to (1600 to 4000),
        "working" to (2800 to 5500),
        "excited" to (2000 to 4000),
        "surprised" to (1800 to 3500),
        "suspicious" to (4500 to 8000),
        "angry" to (3500 to 7000),
        "happy" to (2500 to 5000),
        "curious" to (2500 to 5500),
        "confused" to (2800 to 5500),
        "bored" to (4000 to 8000),
        "proud" to (3500 to 7000),
        "shy" to (3000 to 6000),
        "sad" to (4000 to 8000),
        "laughing" to (2500 to 5000),
        "scared" to (1200 to 3000),
        "playful" to (2000 to 4500),
        "celebrate" to (2200 to 4500),
        "humming" to (4000 to 8000),
        "notifying" to (2000 to 4000),
        "dragging" to (2200 to 4500),
    )

    /** `AstraFaceData.swift:508-549`, as `field amplitude/period`, in the struct's order. */
    val MOTION: Map<String, String> = mapOf(
        "sleeping" to "pulse 0.028/4600, tilt 2",
        "waking" to "pulse 0.03/2200, enter 0.92/700",
        "idle" to "pulse 0.014/3600",
        "listening" to "bob 2/2600, pulse 0.012/2600",
        "thinking" to "sway 1.6/3000, pulse 0.01/3000",
        "searching" to "bob 3/1400, sway 2.2/1400",
        "working" to "bob 2.5/900, squash 0.22",
        "excited" to "bob 9/520, sway 3/1040, squash 0.35",
        "surprised" to "jitter 0.8/120, enter 1.14/340",
        "suspicious" to "sway 2.4/2600, tilt -3",
        "angry" to "jitter 1.3/95, tilt 2",
        "drowsy" to "pulse 0.026/5000, tilt 3",
        "happy" to "bob 5/820, squash 0.28",
        "curious" to "sway 3.4/1900, tilt -4",
        "confused" to "sway 3/2200",
        "bored" to "pulse 0.016/5200, tilt 2",
        "proud" to "bob 1.6/2400, pulse 0.02/2400",
        "shy" to "pulse 0.016/3000, tilt 4",
        "sad" to "pulse 0.02/4600, tilt 3",
        "laughing" to "bob 7/430, squash 0.4",
        "scared" to "jitter 2.2/75",
        "playful" to "bob 6/620, sway 5/1240, squash 0.3",
        "celebrate" to "bob 10/480, sway 4/960, squash 0.35",
        "orbit" to "circle 6/3200",
        "radar" to "sway 6/2400, pulse 0.012/2400",
        "progress" to "pulse 0.022/1600",
        "thinking-dots" to "still",
        "spawning" to "pulse 0.014/3600, enter 0.02/820",
        "humming" to "pulse 0.016/2800",
        "loading" to "sway 2.2/1500, pulse 0.012/1500",
        "dictating" to "bob 2/2000",
        "sending" to "still",
        "receiving" to "still",
        "uploading" to "bob 3/1000",
        "writing" to "bob 1.6/1100",
        "notifying" to "bob 4/700, sway 2.5/700",
        "alerting" to "jitter 2.6/85",
        "bouncing" to "bob 12/560, squash 0.45",
        "dragging" to "sway 2/900, tilt -6",
        "powering-down" to "tilt 4, settle 0.05",
    )

    /** `AstraAvatar.swift:352-358`. */
    val TRAILS: Map<String, String> = mapOf(
        "orbit" to "count 6, period 3000, radius 105, width 5, span 2.5, body 0.72",
        "radar" to "count 4, period 2400, radius 106, width 4.5, span 2.1, body 0.72",
        "progress" to "count 5, period 2000, radius 104, width 4.8, span 2.3, body 0.74",
        "loading" to "count 5, period 2400, radius 105, width 5, span 2.6, body 0.72",
        "uploading" to "count 4, period 1800, radius 104, width 4.8, span 2.2, body 0.74",
    )

    /** `AstraAvatar.swift:362-365`, head to tail. */
    val PALETTES: List<String> = listOf(
        "A855F7 6366F1 38BDF8",
        "22D3EE 34D399 A3E635",
        "FB923C F43F5E D946EF",
        "818CF8 C084FC F472B6",
        "FACC15 FB923C EC4899",
        "34D399 22D3EE 60A5FA",
    )

    /** `AstraFaceData.swift:373-377`: where each expression looks, x then y. */
    val GAZE: FloatArray = floatArrayOf(
        41.1551f, -60.5302f, 0.824375f, 25.4941f, 11.3477f, 30.8925f, -39.68f, -0.955729f,
        23.5902f, -5.85979f, -2.89208f, 32.071f, 25.2746f, 6.29417f, 25.9939f, -26.899f,
        -39.807f, -8.73021f, 21.7151f, 26.8792f, 9.25167f, -7.03292f, -34.3154f, 5.74958f,
        18.1492f, 38.3474f, -20.2271f, 12.1602f, -11.114f, -18.779f, 70.1532f, -21.4929f,
        -49.2559f, 20.1061f, 17.9684f, -13.7621f, 4.50385f, -15.2402f, -27.7374f, 14.4381f,
        19.2877f, 42.7034f, -29.1651f, 8.88542f, 3.57635f, -27.0711f, 19.9578f, 18.3411f,
        6.10729f, 20.5418f,
    )

    /** `AstraFaceData.swift:379-387`: half-width, curve, gap, skew, per expression. */
    val MOUTHS: FloatArray = floatArrayOf(
        14.0f, 3.0f, 20.0f, 0.0f, 13.0f, 1.0f, 20.0f, 0.0f, 25.0f, 14.0f, 13.0f, 0.0f, 11.0f, 4.0f, 18.0f, 0.0f,
        16.0f, -2.0f, 22.0f, 0.0f, 15.0f, -3.0f, 20.0f, 6.0f, 12.0f, 2.0f, 20.0f, 0.0f, 17.0f, -7.0f, 18.0f, 0.0f,
        15.0f, 5.0f, 20.0f, 0.0f, 12.0f, 3.0f, 20.0f, 0.0f, 14.0f, 1.0f, 20.0f, 0.0f, 23.0f, 12.0f, 13.0f, 0.0f,
        12.0f, 2.0f, 20.0f, 0.0f, 16.0f, -3.0f, 22.0f, 0.0f, 15.0f, -2.0f, 20.0f, -6.0f, 12.0f, 5.0f, 20.0f, 0.0f,
        16.0f, -4.0f, 18.0f, 0.0f, 20.0f, 11.0f, 18.0f, 0.0f, 11.0f, 2.0f, 20.0f, 0.0f, 17.0f, 8.0f, 20.0f, 0.0f,
        15.0f, 5.0f, 10.0f, 0.0f, 12.0f, 4.0f, 18.0f, 0.0f, 16.0f, -3.0f, 22.0f, 0.0f, 15.0f, -5.0f, 20.0f, 7.0f,
        11.0f, 6.0f, 20.0f, 0.0f,
    )

    /**
     * The 4,800 numbers of `AstraFaceData.swift:71-372`, as one number: `h = 0` then
     * `h = h * 31 + value.toRawBits()` over the catalogue in order (expression, eye,
     * point, x then y), in 64-bit wraparound. Recomputable from the Swift by anyone
     * who doubts it, and a single moved decimal changes it.
     */
    const val RING_FINGERPRINT: Long = 3801013492580860619L

    /** The face a state holds when nothing is animating it. */
    val RESTING: Map<String, Int> = POOLS.mapValues { it.value.first() }
}

/**
 * Is it still the same artwork? `AstraFaceTest` asks whether the face behaves, and
 * would stay green if a pool, a cadence or an amplitude quietly became a different
 * valid number. This asks the question a copied catalogue actually needs answered.
 */
class AstraCatalogueGoldenTest {

    @Test
    fun `the eye rings are still the 4800 numbers the desktop draws`() {
        var fingerprint = 0L
        val ring = FloatArray(96)
        // the catalogue's own shape, spelled out rather than asked for: 25
        // expressions, two rings of 48 points, x and y
        for (expression in 0 until 25) {
            for (eye in 0..1) {
                AstraFaceData.copyRing(expression, eye, ring)
                for (value in ring) fingerprint = fingerprint * 31 + value.toRawBits()
            }
        }
        assertEquals(AstraGolden.RING_FINGERPRINT, fingerprint)

        // and two corners of it, legible to a human holding the Swift open
        AstraFaceData.copyRing(0, 0, ring)
        assertEquals(89.2049f, ring[0])
        assertEquals(106.51f, ring[1])
        AstraFaceData.copyRing(24, 1, ring)
        assertEquals(147.173f, ring[94])
        assertEquals(107.038f, ring[95])
    }

    @Test
    fun `the gaze table is still the desktop's`() {
        for (expression in 0 until 25) {
            assertEquals(AstraGolden.GAZE[expression * 2], AstraFaceData.gazeX(expression), "gaze x $expression")
            assertEquals(AstraGolden.GAZE[expression * 2 + 1], AstraFaceData.gazeY(expression), "gaze y $expression")
        }
    }

    @Test
    fun `the mouth table is still the desktop's`() {
        val mouth = FloatArray(4)
        for (expression in 0 until 25) {
            AstraFaceData.copyMouth(expression, mouth)
            for (part in 0 until 4) {
                assertEquals(AstraGolden.MOUTHS[expression * 4 + part], mouth[part], "mouth $expression part $part")
            }
        }
    }

    @Test
    fun `the states are still the desktop's forty, in order`() {
        assertEquals(AstraGolden.STATES, AstraState.entries.map { it.id })
    }

    @Test
    fun `every state still drifts through the desktop's pool`() {
        assertEquals(AstraGolden.POOLS.keys, AstraFaceData.pools.keys.map { it.id }.toSet())
        for (state in AstraState.entries) {
            assertEquals(AstraGolden.POOLS.getValue(state.id), AstraFaceData.pools[state], state.id)
        }
    }

    @Test
    fun `every state still holds an expression for the desktop's span`() {
        assertEquals(AstraGolden.CADENCE.keys, AstraFaceData.expressionCadence.keys.map { it.id }.toSet())
        for (state in AstraState.entries) {
            val expected = AstraGolden.CADENCE.getValue(state.id)
            val actual = AstraFaceData.expressionCadence.getValue(state)
            assertEquals(expected.first.toFloat(), actual.minMillis, state.id)
            assertEquals(expected.second.toFloat(), actual.maxMillis, state.id)
        }
    }

    @Test
    fun `the same states still blink, on the same rhythm`() {
        assertEquals(AstraGolden.BLINK.keys, AstraFaceData.blink.keys.map { it.id }.toSet())
        for (state in AstraState.entries) {
            val expected = AstraGolden.BLINK[state.id]
            val actual = AstraFaceData.blink[state]
            if (expected == null) {
                assertEquals(null, actual, "${state.id} took up blinking")
                continue
            }
            assertEquals(expected.first.toFloat(), actual!!.minMillis, state.id)
            assertEquals(expected.second.toFloat(), actual.maxMillis, state.id)
        }
    }

    @Test
    fun `every body still moves the way the desktop moves it`() {
        for (state in AstraState.entries) {
            assertEquals(
                AstraGolden.MOTION.getValue(state.id),
                render(AstraFaceData.motion.getValue(state)),
                state.id,
            )
        }
    }

    @Test
    fun `the comet rings are still the desktop's`() {
        assertEquals(AstraGolden.TRAILS.keys, AstraComets.trails.keys.map { it.id }.toSet())
        for (state in AstraState.entries) {
            val expected = AstraGolden.TRAILS[state.id] ?: continue
            assertEquals(expected, render(AstraComets.trails.getValue(state)), state.id)
        }
    }

    @Test
    fun `the comet palettes are still the desktop's`() {
        assertEquals(
            AstraGolden.PALETTES,
            AstraComets.colors.map { palette ->
                palette.joinToString(" ") { "%06X".format(java.util.Locale.ROOT, it and 0xFFFFFF) }
            },
        )
    }

    @Test
    fun `the face box, its anchor and its mouth stroke are still the desktop's`() {
        // AstraFaceData.swift:63-69
        assertEquals(228.541f, AstraFaceData.FACE_BOX)
        assertEquals(120f, AstraFaceData.FACE_CENTRE_X)
        assertEquals(122.5f, AstraFaceData.FACE_CENTRE_Y)
        assertEquals(7.5f, AstraFaceData.MOUTH_STROKE)
        assertEquals(25, AstraFaceData.EXPRESSION_COUNT)
        assertEquals(48, AstraFaceData.POINTS_PER_RING)
        // AstraAvatar.swift:122 — the viewBox's margin around that box
        assertEquals(15f, AstraSilhouette.FACE_MARGIN)
    }

    @Test
    fun `the face still looks around by the desktop's fraction`() {
        // AstraAvatar.swift:277
        assertEquals(0.35f, AstraFaceEngine.LOOK_AROUND)
    }

    @Test
    fun `a blink still takes 320ms, shut at 42 percent of it`() {
        // AstraAvatar.swift:611-617, landing on idle's earliest blink — 6000ms
        val engine = AstraFaceEngine(AT_THE_EARLIEST)
        engine.setState(AstraState.IDLE, 0L)
        engine.advance(0L)
        engine.advance(millis(6000f))

        assertEquals(1f, engine.blinkScale(millis(6000f)), 0.001f)
        assertEquals(0.04f, engine.blinkScale(millis(6000f + 320f * 0.42f)), 0.001f)
        assertTrue(engine.blinkScale(millis(6220f)) < 0.6f, "reopened too fast")
        assertEquals(1f, engine.blinkScale(millis(6320f)), 0.001f)
    }

    @Test
    fun `the morph still springs at the desktop's stiffness`() {
        // Idle rests on expression 6 and laughing on 2, whose mouths are 12 and 25
        // wide — so the mouth reads the morph directly. The desktop's stiffness of
        // 7, stepped at 30fps, is 87% of the way there after half a second and 99%
        // after one. A softer 5 would be 73%, a stiffer 9 would be 93%.
        val engine = AstraFaceEngine()
        engine.setState(AstraState.IDLE, 0L)
        engine.advance(0L)
        engine.setState(AstraState.LAUGHING, 0L)
        assertEquals(0f, progress(engine), 0.001f)

        for (frame in 1..15) engine.advance(frame * FRAME_NANOS)
        assertEquals(0.867f, progress(engine), 0.01f)
        for (frame in 16..30) engine.advance(frame * FRAME_NANOS)
        assertEquals(0.987f, progress(engine), 0.01f)
    }

    @Test
    fun `a clock that jumped is still worth at most 100ms of spring`() {
        // AstraAvatar.swift:313
        val jumped = AstraFaceEngine()
        jumped.setState(AstraState.IDLE, 0L)
        jumped.advance(0L)
        jumped.setState(AstraState.LAUGHING, 0L)
        jumped.advance(millis(10_000f))

        val stepped = AstraFaceEngine()
        stepped.setState(AstraState.IDLE, 0L)
        stepped.advance(0L)
        stepped.setState(AstraState.LAUGHING, 0L)
        stepped.advance(millis(100f))

        assertEquals(progress(stepped), progress(jumped), 0.0001f)
        // ten seconds integrated whole would have thrown the morph past its target
        assertTrue(progress(jumped) < 0.6f, "the jump was not clamped")
    }

    /** How far the mouth has travelled from idle's expression 6 to laughing's 2. */
    private fun progress(engine: AstraFaceEngine): Float = (engine.mouth()[0] - 12f) / (25f - 12f)

    private fun millis(value: Float): Long = (value * 1_000_000f).toLong()

    /** `bob 9/520, sway 3/1040, squash 0.35` — the Swift's fields, in its order. */
    private fun render(motion: AstraBodyMotion): String {
        val parts = mutableListOf<String>()
        motion.bob?.let { parts += "bob ${plain(it.amplitude)}/${plain(it.periodMillis)}" }
        motion.sway?.let { parts += "sway ${plain(it.amplitude)}/${plain(it.periodMillis)}" }
        motion.pulse?.let { parts += "pulse ${plain(it.amplitude)}/${plain(it.periodMillis)}" }
        motion.circle?.let { parts += "circle ${plain(it.amplitude)}/${plain(it.periodMillis)}" }
        motion.jitter?.let { parts += "jitter ${plain(it.amplitude)}/${plain(it.periodMillis)}" }
        motion.tilt?.let { parts += "tilt ${plain(it)}" }
        motion.squash?.let { parts += "squash ${plain(it)}" }
        motion.enter?.let { parts += "enter ${plain(it.from)}/${plain(it.durationMillis)}" }
        motion.settle?.let { parts += "settle ${plain(it)}" }
        return if (parts.isEmpty()) "still" else parts.joinToString(", ")
    }

    /** `count 6, period 3000, radius 105, width 5, span 2.5, body 0.72`. */
    private fun render(spec: AstraCometSpec): String =
        "count ${spec.count}, period ${plain(spec.periodMillis)}, radius ${plain(spec.radius)}, " +
            "width ${plain(spec.width)}, span ${plain(spec.span)}, body ${plain(spec.bodyScale)}"

    private fun plain(value: Float): String {
        val text = "%.6f".format(java.util.Locale.ROOT, value).trimEnd('0').trimEnd('.')
        return if (text == "-0") "0" else text
    }

    private companion object {
        const val FRAME_NANOS = 1_000_000_000L / 30

        /** Every draw at the bottom of its range, so a blink lands on a known millisecond. */
        val AT_THE_EARLIEST = object : Random() {
            override fun nextBits(bitCount: Int): Int = 0
        }
    }
}
