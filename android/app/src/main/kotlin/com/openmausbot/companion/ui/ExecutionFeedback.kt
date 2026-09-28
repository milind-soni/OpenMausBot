package com.openmausbot.companion.ui

import com.openmausbot.companion.core.ActivityDetail
import kotlin.math.PI
import kotlin.math.cos

/**
 * What the transcript says while a turn is running — the rules behind
 * `ios/App/Composer/TypingIndicatorView.swift`, the `else if current.busy`
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

    /** Busy with nothing to show for it yet. */
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
 * - and [TranscriptTail.WORKING] last, when the bot is busy and has produced
 *   neither — the beat between "go" and the first token, which on Android is
 *   otherwise announced to nobody.
 *
 * Empty is the same as absent on both branches: the store publishes `""` for a
 * stream that has been opened and has not yet delivered a token, and an empty
 * bubble would be a bubble about nothing.
 */
object LiveTail {
    fun of(
        streaming: String?, reasoning: String?, busy: Boolean,
        detail: ActivityDetail = ActivityDetail.FULL,
    ): TranscriptTail = when {
        !streaming.isNullOrEmpty() -> TranscriptTail.STREAM
        detail != ActivityDetail.HIDDEN && !reasoning.isNullOrEmpty() -> TranscriptTail.REASONING
        busy -> TranscriptTail.WORKING
        else -> TranscriptTail.NONE
    }

    /**
     * What a screen reader is told when [TranscriptTail.WORKING] appears.
     *
     * The words are `ChatView.swift`'s `.accessibilityLabel("\(current.name) is
     * working")`. This is the whole point of the pass: busy already reaches a
     * sighted reader through the mascot's face and through the interrupt button,
     * and reached a TalkBack reader through neither.
     */
    fun workingLabel(name: String): String = "$name is working"
}

/**
 * The three dots, as numbers.
 *
 * Deliberately *not* the Apple animation: `TypingIndicatorView` scales each dot
 * on a sine inside a `TimelineView`, in a capsule of `Color.secondary`. This
 * pulses alpha only, at a period of its own, inside the bot's own speech bubble —
 * so the placeholder and the reply that replaces it are the same shape, the way
 * [StreamingBubble] already argues they should be.
 *
 * A Material progress spinner was the other candidate and is the wrong answer for
 * the same reason a spinner is the wrong answer inside the streaming bubble: it
 * says "something is loading somewhere", which the reader already knows.
 *
 * [alpha] is a function of elapsed time rather than a running value, so the draw
 * phase holds no state and allocates nothing.
 */
object WorkingDots {
    const val COUNT: Int = 3

    /** Where the dots rest when the animator duration scale is zero. */
    const val REST_ALPHA: Float = 0.6f

    const val MIN_ALPHA: Float = 0.3f
    const val MAX_ALPHA: Float = 1f

    /** One full pass of the wave. */
    const val PERIOD_NANOS: Long = 1_100_000_000L

    /** How far behind its neighbour each dot runs, as a fraction of the period. */
    const val PHASE_STEP: Float = 0.2f

    private const val TWO_PI: Float = (2.0 * PI).toFloat()

    /**
     * Alpha of dot [index] at [elapsedNanos] since the row appeared.
     *
     * With [moving] false — reduce motion, which Android says through the
     * animator duration scale — every dot sits at [REST_ALPHA]. Three steady
     * dots, not a blank: the row still has to say that something is happening,
     * and a reader who has asked for less motion has not asked for less
     * information.
     */
    fun alpha(index: Int, elapsedNanos: Long, moving: Boolean): Float {
        if (!moving) return REST_ALPHA
        // Modulo before the float, so a bubble left open for minutes keeps the
        // resolution it had in its first second.
        val cycle = (elapsedNanos % PERIOD_NANOS).toFloat() / PERIOD_NANOS
        val wave = (1f - cos((cycle - index * PHASE_STEP) * TWO_PI)) * 0.5f
        return MIN_ALPHA + wave * (MAX_ALPHA - MIN_ALPHA)
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

    /** The whole row, as one sentence, for a reader who cannot see the dot. */
    fun announcement(name: String, status: ActivityStatus): String =
        "$name, ${label(status).lowercase()}"
}
