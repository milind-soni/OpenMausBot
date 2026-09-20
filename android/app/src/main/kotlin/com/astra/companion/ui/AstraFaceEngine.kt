package com.astra.companion.ui

import kotlin.math.PI
import kotlin.math.max
import kotlin.math.sin
import kotlin.random.Random

/**
 * The face, frame by frame — the port of `AstraFaceEngine` in
 * `ios/App/AstraAvatar.swift`, which is itself the desktop's frame loop: a state
 * picks a pool of expressions and drifts through them on its cadence, a spring
 * morphs the eyes and mouth between them, it blinks on its own rhythm, and the
 * body bobs, sways, breathes or jitters per state.
 *
 * One per drawn mascot, and no Compose in it: a roster is a list of these being
 * redrawn on every scroll frame, so the buffers below are filled in place rather
 * than reallocated, and the geometry stays testable on the JVM.
 *
 * A mascot that is never [advance]d rests on its state's first expression — which
 * is the still pose, and the whole of the face when animations are switched off.
 */
internal class AstraFaceEngine(private val random: Random = Random.Default) {
    var state: AstraState = AstraState.IDLE
        private set

    var motion: AstraBodyMotion = AstraBodyMotion()
        private set

    private var expression = 0
    private val currentRings = Array(EYES) { FloatArray(AstraFaceData.RING_STRIDE) }
    private val targetRings = Array(EYES) { FloatArray(AstraFaceData.RING_STRIDE) }
    private val displayedRings = Array(EYES) { FloatArray(AstraFaceData.RING_STRIDE) }
    private val currentMouth = FloatArray(AstraFaceData.MOUTH_STRIDE)
    private val targetMouth = FloatArray(AstraFaceData.MOUTH_STRIDE)
    private val displayedMouth = FloatArray(AstraFaceData.MOUTH_STRIDE)
    private var currentGazeX = AstraFaceData.gazeX(0)
    private var currentGazeY = AstraFaceData.gazeY(0)
    private var targetGazeX = currentGazeX
    private var targetGazeY = currentGazeY

    private var morph = 1f
    private var velocity = 0f
    private var blinkStartNanos = UNSET
    private var nextExpressionAtNanos = UNSET
    private var nextBlinkAtNanos = UNSET
    private var stateStartNanos = 0L
    private var lastNanos = UNSET
    private var started = false

    init {
        for (eye in 0 until EYES) {
            AstraFaceData.copyRing(0, eye, currentRings[eye])
            AstraFaceData.copyRing(0, eye, targetRings[eye])
        }
        AstraFaceData.copyMouth(0, currentMouth)
        AstraFaceData.copyMouth(0, targetMouth)
    }

    fun setState(next: AstraState, nowNanos: Long) {
        if (started && next == state) return
        started = true
        state = next
        stateStartNanos = nowNanos
        motion = AstraFaceData.motion[next] ?: AstraBodyMotion()
        select(AstraFaceData.pools[next]?.firstOrNull() ?: 0)
        // first frame: rest on it, no morph in
        if (lastNanos == UNSET) {
            morph = 1f
            velocity = 0f
        }
        nextExpressionAtNanos = schedule(AstraFaceData.expressionCadence[next], nowNanos)
        nextBlinkAtNanos = schedule(AstraFaceData.blink[next], nowNanos)
    }

    fun advance(nowNanos: Long) {
        // A clock that jumped — a paused window, a restarted loop — must not run
        // the spring backwards or in one huge step.
        val dt = if (lastNanos == UNSET) 0f else ((nowNanos - lastNanos) / NANOS_PER_SECOND).coerceIn(0f, 0.1f)
        lastNanos = nowNanos

        // the spring towards morph == 1
        velocity += (-2f * SPRING * velocity - SPRING * SPRING * (morph - 1f)) * dt
        morph += velocity * dt
        if (!morph.isFinite()) {
            morph = 1f
            velocity = 0f
        }

        if (nextExpressionAtNanos != UNSET && nowNanos >= nextExpressionAtNanos) {
            select(nextExpression())
            nextExpressionAtNanos = schedule(AstraFaceData.expressionCadence[state], nowNanos)
        }
        if (nextBlinkAtNanos != UNSET && nowNanos >= nextBlinkAtNanos) {
            blinkStartNanos = nowNanos
            nextBlinkAtNanos = schedule(AstraFaceData.blink[state], nowNanos)
        }
    }

    /**
     * Settle on the state's own face at once, eyes open — the pose of a mascot that
     * is not being advanced. Without it a face that stops mid-morph or mid-blink
     * would hold that half-expression until it was advanced again.
     */
    fun rest() {
        morph = 1f
        velocity = 0f
        blinkStartNanos = UNSET
    }

    /**
     * The ring one eye is wearing this frame, gaze included, as interleaved x, y.
     * The buffer is the engine's own and is refilled by the next call.
     */
    fun ring(eye: Int): FloatArray {
        val m = morph.coerceIn(0f, 1f)
        val current = currentRings[eye]
        val target = targetRings[eye]
        val out = displayedRings[eye]
        val offsetX = gazeX() * LOOK_AROUND
        val offsetY = gazeY() * LOOK_AROUND
        var i = 0
        while (i < out.size) {
            out[i] = current[i] + (target[i] - current[i]) * m + offsetX
            out[i + 1] = current[i + 1] + (target[i + 1] - current[i + 1]) * m + offsetY
            i += 2
        }
        return out
    }

    /** The mouth this frame; the engine's own buffer, as with [ring]. */
    fun mouth(): FloatArray {
        val m = morph.coerceIn(0f, 1f)
        for (i in displayedMouth.indices) {
            displayedMouth[i] = currentMouth[i] + (targetMouth[i] - currentMouth[i]) * m
        }
        return displayedMouth
    }

    /** How much of its own height an eye has left: 1 open, 0.04 shut. */
    fun blinkScale(nowNanos: Long): Float {
        if (blinkStartNanos == UNSET) return 1f
        val t = (nowNanos - blinkStartNanos) / NANOS_PER_SECOND / BLINK_SECONDS
        if (t >= 1f) {
            blinkStartNanos = UNSET
            return 1f
        }
        // fast close, slower open
        return max(if (t < 0.42f) 1f - t / 0.42f else (t - 0.42f) / 0.58f, 0.04f)
    }

    fun elapsedMillis(nowNanos: Long): Float = (nowNanos - stateStartNanos) / NANOS_PER_MILLI

    private fun gazeX(): Float {
        val m = morph.coerceIn(0f, 1f)
        return currentGazeX + (targetGazeX - currentGazeX) * m
    }

    private fun gazeY(): Float {
        val m = morph.coerceIn(0f, 1f)
        return currentGazeY + (targetGazeY - currentGazeY) * m
    }

    private fun select(index: Int) {
        val count = AstraFaceData.EXPRESSION_COUNT
        val next = ((index % count) + count) % count
        if (next == expression && morph >= 1f) return

        val m = morph.coerceIn(0f, 1f)
        for (eye in 0 until EYES) {
            val current = currentRings[eye]
            val target = targetRings[eye]
            for (i in current.indices) current[i] += (target[i] - current[i]) * m
            AstraFaceData.copyRing(next, eye, target)
        }
        for (i in currentMouth.indices) currentMouth[i] += (targetMouth[i] - currentMouth[i]) * m
        AstraFaceData.copyMouth(next, targetMouth)
        currentGazeX = gazeX()
        currentGazeY = gazeY()
        targetGazeX = AstraFaceData.gazeX(next)
        targetGazeY = AstraFaceData.gazeY(next)

        expression = next
        morph = 0f
        velocity = 0f
    }

    /** Any expression in the state's pool but the one on show. */
    private fun nextExpression(): Int {
        val pool = AstraFaceData.pools[state] ?: return 0
        var alternatives = 0
        for (index in pool.indices) {
            if (pool[index] != expression) alternatives++
        }
        if (alternatives == 0) return pool[0]
        var remaining = random.nextInt(alternatives)
        for (index in pool.indices) {
            val candidate = pool[index]
            if (candidate == expression) continue
            if (remaining == 0) return candidate
            remaining--
        }
        return pool[0]
    }

    private fun schedule(range: AstraRange?, nowNanos: Long): Long {
        if (range == null) return UNSET
        val millis = range.minMillis + random.nextFloat() * (range.maxMillis - range.minMillis)
        return nowNanos + (millis * NANOS_PER_MILLI).toLong()
    }

    companion object {
        /** The desktop's `lookAround` default: how much of an expression's own look-direction to keep. */
        const val LOOK_AROUND = 0.35f

        private const val EYES = 2
        /** Spring stiffness for the morph, the desktop's default. */
        private const val SPRING = 7f
        private const val BLINK_SECONDS = 0.320f
        private const val NANOS_PER_SECOND = 1_000_000_000f
        private const val NANOS_PER_MILLI = 1_000_000f
        private const val UNSET = Long.MIN_VALUE
    }
}

/** Where the body sits this frame, relative to its resting place in the face box. */
internal class AstraBodyPose {
    var dx: Float = 0f
    var dy: Float = 0f
    var rotationDegrees: Float = 0f
    var scale: Float = 1f
    var squashX: Float = 1f
    var squashY: Float = 1f
}

/**
 * The desktop's `bodyTransform`, in face-box units. Written into [out] rather than
 * returned, so a scrolling list does not allocate one of these per avatar per frame.
 */
internal fun AstraBodyMotion.poseAt(elapsedMillis: Float, out: AstraBodyPose) {
    out.dx = 0f
    out.dy = 0f
    out.rotationDegrees = tilt ?: 0f
    out.scale = 1f
    out.squashX = 1f
    out.squashY = 1f

    bob?.let { motion ->
        val phase = wave(elapsedMillis, motion.periodMillis)
        out.dy -= motion.amplitude * phase
        squash?.let { amount ->
            val landing = amount * max(0f, -phase)
            out.squashY = 1f - landing * 0.5f
            out.squashX = 1f + landing * 0.5f
        }
    }
    circle?.let {
        out.dx += it.amplitude * wave(elapsedMillis, it.periodMillis)
        out.dy += it.amplitude * wave(elapsedMillis, it.periodMillis, QUARTER_TURN)
    }
    sway?.let { out.rotationDegrees += it.amplitude * wave(elapsedMillis, it.periodMillis) }
    pulse?.let { out.scale *= 1f + it.amplitude * wave(elapsedMillis, it.periodMillis) }
    jitter?.let {
        out.dx += it.amplitude * wave(elapsedMillis, it.periodMillis)
        out.dy += it.amplitude * wave(elapsedMillis, it.periodMillis * 0.63f, 1.1f)
    }
    enter?.let {
        val t = elapsedMillis / it.durationMillis
        out.scale *= if (t >= 1f) 1f else it.from + (1f - it.from) * easeOutBack(max(t, 0f))
    }
    settle?.let {
        val t = (elapsedMillis / 1400f).coerceIn(0f, 1f)
        out.scale *= 1f + (it - 1f) * easeInOut(t)
    }
}

private val QUARTER_TURN = (PI / 2).toFloat()

private fun wave(elapsedMillis: Float, periodMillis: Float, phase: Float = 0f): Float =
    sin(elapsedMillis / periodMillis * 2f * PI.toFloat() + phase)

private fun easeOutBack(t: Float): Float {
    val c = 1.7f
    val u = t - 1f
    return 1f + (c + 1f) * u * u * u + c * u * u
}

private fun easeInOut(t: Float): Float = if (t < 0.5f) 2f * t * t else 1f - 2f * (1f - t) * (1f - t)
