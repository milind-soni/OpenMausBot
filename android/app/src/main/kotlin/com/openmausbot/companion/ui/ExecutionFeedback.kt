package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ActivityDetail
import kotlin.math.PI
import kotlin.math.sin

/**
 * What the transcript says while a turn is running — the rules behind
 * `ios/App/Composer/TypingIndicatorView.swift`, the `else if showsTyping`
 * branch of `ChatView.swift`, and `ios/App/Cards/SkillExecutionReceiptView.swift`.
 *
 * Pure, and here rather than inside the composables for the usual reason: the
 * gate is three conditions in a fixed order, and an order is exactly the kind of
 * thing a screenshot cannot pin.
 */

/** The one row that may sit after the last settled message. */
enum class TranscriptTail {
    /** Tokens of the reply are arriving. */
    STREAM,

    /** No reply yet, but the bot is thinking out loud. */
    REASONING,

    /** The bot is typing: busy, and nothing on screen finishes its turn yet. */
    WORKING,

    /** The transcript ends at its last message. */
    NONE,
}

/**
 * Which of the four the transcript ends with.
 *
 * The order is the Swift's, and each step of it earns its place:
 *
 * - a stream wins outright, because once tokens of the answer exist the
 *   reasoning is behind us and showing both is noise (`ChatView.swift`);
 * - reasoning only while there is no answer yet, for the same reason;
 * - and [TranscriptTail.WORKING] last, when [typing] says so and neither of the
 *   others is showing: the beat between "go" and the first token, and every
 *   step after it until the reply lands.
 *
 * Empty is the same as absent on both branches: the store publishes `""` for a
 * stream that has been opened and has not yet delivered a token, and an empty
 * bubble would be a bubble about nothing.
 */
object LiveTail {
    /**
     * @param typing the shared rule's answer for this chat
     *   ([com.openmausbot.companion.core.showsTyping]): busy, not waiting on the
     *   person, and the last row is not a finished reply. Defaults to [busy] for
     *   callers that only know that much.
     */
    fun of(
        streaming: String?, reasoning: String?, busy: Boolean,
        detail: ActivityDetail = ActivityDetail.FULL,
        typing: Boolean = busy,
    ): TranscriptTail = when {
        // At Hidden a working bot's words go to the status line above the
        // composer; the transcript keeps the dots.
        !streaming.isNullOrEmpty() && !(busy && detail == ActivityDetail.HIDDEN) -> TranscriptTail.STREAM
        detail != ActivityDetail.HIDDEN && !reasoning.isNullOrEmpty() -> TranscriptTail.REASONING
        typing -> TranscriptTail.WORKING
        else -> TranscriptTail.NONE
    }
}

/**
 * The three dots, as numbers: the typing bounce `TypingIndicatorView` draws on
 * iOS, the way Messages shows someone typing.
 *
 * Each dot hops in turn: a half sine for the first [AIRBORNE] of its cycle, then
 * still on the line until its next hop, [STAGGER_NANOS] behind its neighbour.
 * It is a shade brighter at the top of the hop, so the wave also reads at a
 * glance. All inside the bot's own speech bubble, so the placeholder and the
 * reply that replaces it are the same shape, the way [StreamingBubble] already
 * argues they should be.
 *
 * A Material progress spinner was the other candidate and is the wrong answer for
 * the same reason a spinner is the wrong answer inside the streaming bubble: it
 * says "something is loading somewhere", which the reader already knows.
 *
 * [lift] and [alpha] are functions of elapsed time rather than running values, so
 * the draw phase holds no state and allocates nothing.
 */
object WorkingDots {
    const val COUNT: Int = 3

    /** Where the dots rest when the animator duration scale is zero. */
    const val REST_ALPHA: Float = 0.45f

    /** A dot on the line, and a dot at the top of its hop. */
    const val MIN_ALPHA: Float = 0.55f
    const val MAX_ALPHA: Float = 0.95f

    /** One full pass of the wave across the three dots. */
    const val PERIOD_NANOS: Long = 1_200_000_000L

    /** How far behind its neighbour each dot hops. */
    const val STAGGER_NANOS: Long = 150_000_000L

    /** The part of a dot's cycle spent in the air; it rests for the remainder. */
    const val AIRBORNE: Float = 0.5f

    /**
     * How high dot [index] is at [elapsedNanos] since the row appeared, from 0 (on
     * the line) to 1 (the top of its hop).
     *
     * With [moving] false — reduce motion, which Android says through the
     * animator duration scale — every dot sits on the line.
     */
    fun lift(index: Int, elapsedNanos: Long, moving: Boolean): Float {
        if (!moving) return 0f
        // Modulo before the float, so a bubble left open for minutes keeps the
        // resolution it had in its first second; floorMod, so the dots that
        // start behind the first are mid-cycle rather than negative.
        val shifted = Math.floorMod(elapsedNanos - index * STAGGER_NANOS, PERIOD_NANOS)
        val cycle = shifted.toFloat() / PERIOD_NANOS
        if (cycle >= AIRBORNE) return 0f
        return sin(cycle / AIRBORNE * PI.toFloat())
    }

    /**
     * Alpha of dot [index] at [elapsedNanos]. With [moving] false every dot sits at
     * [REST_ALPHA]: three steady dots, not a blank, because the row still has to
     * say that something is happening, and a reader who has asked for less motion
     * has not asked for less information.
     */
    fun alpha(index: Int, elapsedNanos: Long, moving: Boolean): Float {
        if (!moving) return REST_ALPHA
        return MIN_ALPHA + lift(index, elapsedNanos, moving = true) * (MAX_ALPHA - MIN_ALPHA)
    }
}

/** What became of a tool the bot ran. */
enum class ActivityStatus { RUNNING, SUCCESS, ERROR }

/**
 * The receipt on an activity row — the status half of `SkillExecutionReceiptView`.
 *
 * Only the status. iOS carries `durationMs`, `parameters` and `output` on that
 * view and the integration passes none of them, so all three render as nothing
 * there; inventing values for them here would be inventing a wire field. The
 * Android [com.openmausbot.companion.core.ToolActivity] carries no such fields
 * either, and this pass does not add any.
 */
object ActivityReceipt {
    /** `tool.ok.map { $0 ? "success" : "error" } ?? "running"`, in Kotlin. */
    fun status(ok: Boolean?): ActivityStatus = when (ok) {
        null -> ActivityStatus.RUNNING
        true -> ActivityStatus.SUCCESS
        false -> ActivityStatus.ERROR
    }

    /** The badge word, which iOS gets from `status.capitalized`. */
    fun label(status: ActivityStatus): String = when (status) {
        ActivityStatus.RUNNING -> "Running"
        ActivityStatus.SUCCESS -> "Success"
        ActivityStatus.ERROR -> "Error"
    }

    /**
     * Drawn beside the name for everything except success.
     *
     * Success is what almost every row in a busy transcript is, and a word
     * repeated down the whole thread stops being read. Running and error are the
     * two worth a glance — and both keep a shape of their own as well, so the
     * distinction never rests on colour alone.
     */
    fun showsLabel(status: ActivityStatus): Boolean = status != ActivityStatus.SUCCESS

    /**
     * Lines the name may take. A step is one quiet line; a failure is read whole, because
     * its last words are usually what to do next ("Delete one to start another.").
     */
    fun nameLines(status: ActivityStatus): Int = if (status == ActivityStatus.ERROR) Int.MAX_VALUE else 1

    /** The whole row, as one sentence, for a reader who cannot see the dot. */
    fun announcement(name: String, status: ActivityStatus): String =
        "$name, ${label(status).lowercase()}"
}
