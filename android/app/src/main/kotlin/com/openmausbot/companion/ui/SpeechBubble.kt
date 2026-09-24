package com.openmausbot.companion.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/**
 * The message bubble, tail included — the port of `ios/App/SpeechBubble.swift`.
 *
 * The tail is not an approximation: its four Bézier segments are the ones from
 * the reference vector (`docs/ios/bubble-tail-reference.svg`), scaled so the
 * reference's cap radius becomes this bubble's corner radius. That is why it
 * curls in, drops, and ends soft rather than in a point — the shape is the
 * drawing, not a guess at it.
 *
 * The only deviation from the Swift is the untailed corner: SwiftUI's
 * `.continuous` style has no Compose equivalent, so all four corners here are
 * circular arcs. Both bubble shapes use the same arcs, so a tailed and an
 * untailed bubble in the same run still agree with each other.
 */
enum class BubbleTail { NONE, LEADING, TRAILING }

@Immutable
data class SpeechBubbleShape(
    val tail: BubbleTail,
    val cornerRadius: Dp = SpeechBubble.CORNER_RADIUS,
) : Shape {
    override fun createOutline(
        size: Size,
        layoutDirection: LayoutDirection,
        density: Density,
    ): Outline {
        val radius = minOf(
            with(density) { cornerRadius.toPx() },
            size.height / 2f,
            size.width / 2f,
        )
        if (tail == BubbleTail.NONE) {
            return Outline.Rounded(
                RoundRect(
                    rect = Rect(0f, 0f, size.width, size.height),
                    cornerRadius = CornerRadius(radius),
                ),
            )
        }
        val path = trailingTailPath(size, radius)
        if (tail == BubbleTail.LEADING) {
            // Mirror the trailing shape about the rect's vertical centre line —
            // the Swift applies the same flip rather than drawing a second path.
            path.transform(mirrorAcross(size.width))
        }
        return Outline.Generic(path)
    }

    /**
     * The three bubbles at the default radius, built once. A shape instance that
     * survives recomposition is also what lets `background` keep its cached
     * outline: `BackgroundNode` compares the shape by equality and only calls
     * [createOutline] again when the size, the layout direction or the shape
     * itself changes.
     */
    companion object {
        private val none = SpeechBubbleShape(BubbleTail.NONE)
        private val leading = SpeechBubbleShape(BubbleTail.LEADING)
        private val trailing = SpeechBubbleShape(BubbleTail.TRAILING)

        fun of(tail: BubbleTail): SpeechBubbleShape = when (tail) {
            BubbleTail.NONE -> none
            BubbleTail.LEADING -> leading
            BubbleTail.TRAILING -> trailing
        }
    }
}

/**
 * The reference geometry and the two shared bubble constants.
 *
 * The reference: a 772×428 pill whose right cap has [CAP_RADIUS], whose right
 * edge is at [ORIGIN_X] and bottom edge at [ORIGIN_Y], and whose tail hangs
 * [TAIL_DROP] below the bottom edge.
 */
object SpeechBubble {
    val CORNER_RADIUS: Dp = 22.dp

    internal const val CAP_RADIUS = 179f
    internal const val TAIL_DROP = 68f
    internal const val ORIGIN_X = 766.342f
    internal const val ORIGIN_Y = 361.317f

    /**
     * How far below the bubble's bottom edge the tail reaches, so callers can
     * leave room for it. Depends on the corner radius the same way the tail does.
     */
    fun tailDrop(cornerRadius: Dp = CORNER_RADIUS): Dp =
        cornerRadius / CAP_RADIUS * TAIL_DROP

    /** Four cubics, each `control1x, control1y, control2x, control2y, endX, endY`. */
    internal val TAIL: FloatArray = floatArrayOf(
        766.342f, 249.767f, 727.342f, 299.817f, 699.842f, 323.317f,
        699.842f, 323.317f, 677.085f, 338.817f, 674.342f, 354.817f,
        668.342f, 389.817f, 700.829f, 410.817f, 691.829f, 421.317f,
        684.629f, 429.717f, 615.056f, 378.235f, 580.342f, 361.317f,
    )
}

/**
 * The bubble with the tail at bottom-right, drawn clockwise from the top edge.
 * The three plain corners are circular arcs; the fourth is the reference's
 * cap-and-tail, scaled.
 */
private fun trailingTailPath(size: Size, radius: Float): Path {
    val width = size.width
    val height = size.height
    val diameter = radius * 2f
    val curves = tailCurves(width, height, radius)

    val path = Path()
    path.moveTo(radius, 0f)
    path.lineTo(width - radius, 0f)
    path.arcTo(Rect(width - diameter, 0f, width, diameter), TOP, QUARTER, false)
    // Down the right edge to where the reference cap begins — exactly one radius
    // above the bottom, which is where the first segment starts.
    path.lineTo(width, height - radius)
    var index = 0
    while (index < curves.size) {
        path.cubicTo(
            curves[index], curves[index + 1],
            curves[index + 2], curves[index + 3],
            curves[index + 4], curves[index + 5],
        )
        index += 6
    }
    // The last segment lands back on the bottom edge, left of the corner.
    path.lineTo(radius, height)
    path.arcTo(Rect(0f, height - diameter, diameter, height), BOTTOM, QUARTER, false)
    path.lineTo(0f, radius)
    path.arcTo(Rect(0f, 0f, diameter, diameter), LEADING_EDGE, QUARTER, false)
    path.close()
    return path
}

/**
 * The reference tail placed in a bubble of [width] × [height] whose corner is
 * [radius]: the reference's own cap-and-tail, scaled so its cap radius becomes
 * this bubble's, and moved so its origin lands on the bubble's bottom-right.
 *
 * Twenty-four floats — four cubics of `control1x, control1y, control2x,
 * control2y, endX, endY` — because the alternative is a list of points, and a
 * bubble whose size changed would allocate one per corner.
 */
internal fun tailCurves(width: Float, height: Float, radius: Float): FloatArray {
    val scale = radius / SpeechBubble.CAP_RADIUS
    val out = FloatArray(SpeechBubble.TAIL.size)
    var index = 0
    while (index < out.size) {
        out[index] = width + (SpeechBubble.TAIL[index] - SpeechBubble.ORIGIN_X) * scale
        out[index + 1] = height + (SpeechBubble.TAIL[index + 1] - SpeechBubble.ORIGIN_Y) * scale
        index += 2
    }
    return out
}

/** `x' = width - x`, which is the Swift's translate-then-negative-scale flip. */
internal fun mirrorAcross(width: Float): Matrix {
    val matrix = Matrix()
    matrix.translate(x = width)
    matrix.scale(x = -1f)
    return matrix
}

private const val TOP = -90f
private const val BOTTOM = 90f
private const val LEADING_EDGE = 180f
private const val QUARTER = 90f

/**
 * The two bubble fills — the port of `BubbleColor` in `ios/App/SpeechBubble.swift`.
 * Solid rather than translucent on purpose: the tail is part of the same fill, and
 * a see-through bubble shows the seam.
 */
object BubbleColor {
    /** What you said. The mascot palette's blue, not the system's. */
    val defaultMine: Color = Color(MausPalette.argb("blue"))
    val defaultMineText: Color = Color.White
    val mine: Color
        @Composable get() = LocalThemeColors.current["bubble-user"]?.let(::themeColor)
            ?: defaultMine
    val mineText: Color
        @Composable get() = LocalThemeColors.current["bubble-user-ink"]?.let(::themeColor) ?: defaultMineText

    private val theirsDark = Color(0xFF262629)
    private val theirsLight = Color(0xFFE9E9EB)

    /**
     * What a bot said. Near-black on dark, a soft grey on light — chosen off the
     * scheme in force rather than off the system setting, so a screen rendered in
     * a forced theme still gets the bubble that belongs to it.
     */
    val theirs: Color
        @Composable get() =
            LocalThemeColors.current["card"]?.let(::themeColor)
                ?: if (MaterialTheme.colorScheme.surface.luminance() < 0.5f) theirsDark else theirsLight
}
