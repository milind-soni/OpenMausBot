package com.openmausbot.companion.ui

import androidx.compose.ui.res.stringResource

import android.content.ClipData
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.MeasurePolicy
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Reasoning
import com.openmausbot.companion.core.TranscriptCard
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * The three affordances a transcript grows when the reply is more than prose —
 * the port of `ios/App/Cards/GitPRDiffCardView.swift` and
 * `ios/App/Cards/AgentThoughtChamberView.swift`, plus Android's own data-table
 * card. iOS now draws a pipe table as markdown; matching that is issue 1707.
 *
 * Whether a reply *is* one of these is `TranscriptCards` in `:core`, and it is
 * strict on purpose: a card that swallowed a paragraph would hide the answer
 * inside it. This file is only the drawing, and it is Material drawing. The iOS
 * cards are gradients over `.ultraThinMaterial` with Tailwind hexes; the same
 * information here is a tonal surface, the app's own palette for the two colours
 * a diff actually means (added, removed), and Material's divider and text
 * button. What is not free, and is kept exactly: the whole patch on the
 * clipboard, RFC 4180 quoting, the 80-line preview, and a chamber that starts
 * closed.
 */

/** What the clipboard shows a copied card came from. */
private const val CARD_CLIP_LABEL = "OpenMausMobile card"

/** Added and removed, in the app's own palette rather than Tailwind's. */
private val DiffAdded = Color(MausPalette.argb("green"))
private val DiffRemoved = Color(MausPalette.argb("red"))
private val DiffHunk = Color(MausPalette.argb("cyan"))

/**
 * A patch, with its head visible and all of it on the clipboard.
 *
 * The preview stops at 80 lines because a 4,000-line patch inside a scrolling
 * transcript is a scroll the reader cannot get out of. Copy Diff never stops:
 * the clipboard is where the patch is actually used.
 */
@Composable
fun DiffCard(card: TranscriptCard.Diff, modifier: Modifier = Modifier) {
    var showingDiff by rememberSaveable(card.text) { mutableStateOf(true) }
    var showingAll by rememberSaveable(card.text) { mutableStateOf(false) }
    val copy = rememberCopy()
    // `GitPRDiffCardView.swift` fires `Haptics.selection()` on both of these.
    val haptics = rememberHaptics()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = card.filename,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            Row(
                modifier = Modifier
                    .background(secondaryTint.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp)
                    // Two glyphs and two numbers say "three added, one removed"
                    // to anyone who can see them; this says it to everyone else.
                    .localizedSemantics(
                        mergeDescendants = true,
                        contentDescription = {
                            stringResource(R.string.mobile_a11y_diff_stats, card.additions, card.deletions)
                        },
                    ),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = "+${card.additions}",
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = DiffAdded,
                )
                Text(
                    text = "-${card.deletions}",
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = DiffRemoved,
                )
            }
        }

        if (card.text.isNotEmpty()) {
            Disclosure(
                expanded = showingDiff,
                label = if (showingDiff) "Hide Diff" else "View Diff",
                onToggle = {
                    haptics.play(HapticCue.SELECT)
                    showingDiff = !showingDiff
                },
            )

            if (showingDiff) {
                val lines = remember(card, showingAll) { card.visibleLines(showingAll) }
                // Horizontal scroll rather than wrapping, for the same reason the
                // markdown code block does it: indentation is most of what a
                // patch is saying, and a wrapped `-` line stops looking removed.
                SelectionContainer {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                secondaryTint.copy(alpha = 0.10f),
                                RoundedCornerShape(10.dp),
                            )
                            .horizontalScroll(rememberScrollState())
                            .padding(8.dp),
                        verticalArrangement = Arrangement.spacedBy(1.dp),
                    ) {
                        lines.forEach { DiffLine(it) }
                    }
                }

                if (card.isTruncated) {
                    val label = if (showingAll) {
                        stringResource(
                            R.string.mobile_diff_show_first_lines,
                            TranscriptCard.Diff.PREVIEW_LINES,
                        )
                    } else {
                        stringResource(
                            R.string.mobile_diff_show_all_lines,
                            card.lines.size,
                        )
                    }
                    TextButton(
                        onClick = {
                            haptics.play(HapticCue.SELECT)
                            showingAll = !showingAll
                        },
                        // Compose has no "hint" the way UIAccessibility does, so
                        // iOS's hint is folded into the name: the reader must not
                        // be left thinking Copy Diff copies the preview.
                        modifier = Modifier.localizedSemantics(contentDescription = {
                            stringResource(R.string.mobile_a11y_diff_copy_hint, label)
                        }),
                    ) {
                        Text(label, fontSize = 13.sp)
                    }
                }
            }
        }

        HorizontalDivider(color = secondaryTint.copy(alpha = 0.2f))

        TextButton(onClick = { copy(card.text) }) {
            Text(stringResource(R.string.mobile_copy_diff_18f2296a), fontSize = 13.sp)
        }
    }
}

@Composable
private fun DiffLine(line: String) {
    val added = line.startsWith("+") && !line.startsWith("+++")
    val removed = line.startsWith("-") && !line.startsWith("---")
    val hunk = line.startsWith("@@") || line.startsWith("diff")
    Text(
        text = line,
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
        softWrap = false,
        color = when {
            added -> DiffAdded
            removed -> DiffRemoved
            hunk -> DiffHunk
            else -> MaterialTheme.colorScheme.onSurface
        },
        modifier = Modifier
            .background(
                when {
                    added -> DiffAdded.copy(alpha = 0.14f)
                    removed -> DiffRemoved.copy(alpha = 0.14f)
                    else -> Color.Transparent
                },
                RoundedCornerShape(3.dp),
            )
            .padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/**
 * A table the reader can actually read across, and take away as CSV.
 *
 * Read across in the literal sense: heading row first, then one row at a time,
 * left to right, one row at a time. iOS no longer builds this card (issue
 * 1707). This used to be the transpose of a row of columns, a `Row` of
 * self-measuring `Column`s, and on an API 34 emulator TalkBack duly announced
 * *"LANGUAGE, Python, Java, Rust, YEAR, 1991, 1995, 2010"*: every value of the
 * first column before the second, so `Python`↔`1991` was not a row at all for
 * a reader who cannot see the screen. The composition decided that order, and
 * it built it the wrong way round.
 *
 * Composition order is not the whole of the answer:
 * `AndroidComposeViewAccessibilityDelegateCompat` runs its own traversal pass
 * over the merged tree, groups nodes by geometry and publishes
 * `traversalBefore`/`traversalAfter` relations from that grouping. Here the two
 * stages agree, because the children are emitted row-major and then placed
 * row-major, so neither has anything left to reorder. That agreement is the
 * reason the fix holds, not an excuse to skip the check: `TableReadingOrderTest`
 * pins the tree, and TalkBack on a device is what pins the reading.
 *
 * Holding both — the row order *and* columns that still line up — is why the
 * grid is its own [Layout] rather than a `Row` or a `Column` of anything. The
 * children arrive row-major, which is the order the reader gets; the measure
 * pass then widens each column to its widest cell, which is the alignment iOS
 * gives up by handing every cell the same `minWidth` and letting them drift.
 * The rules come last on purpose, and this is the point the old comment here
 * made and it still holds: inside a horizontal scroll the incoming width is
 * unbounded and `fillMaxWidth` against an unbounded constraint measures zero,
 * so a rule is only as wide as its column if something measures the column
 * first and then hands it that width.
 */
@Composable
fun DataTableCard(card: TranscriptCard.Table, modifier: Modifier = Modifier) {
    val copy = rememberCopy()
    val scroll = rememberScrollState()

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.mobile_data_table_54baf78e),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (card.rows.size == 1) "1 row" else "${card.rows.size} rows",
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = secondaryTint,
                modifier = Modifier
                    .background(secondaryTint.copy(alpha = 0.14f), CircleShape)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }

        SelectionContainer {
            DataGrid(
                headers = card.headers,
                rows = card.rows,
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(scroll),
            )
        }

        HorizontalDivider(color = secondaryTint.copy(alpha = 0.2f))

        TextButton(onClick = { copy(card.csv()) }) {
            Text(stringResource(R.string.mobile_copy_csv_b810b7cd), fontSize = 13.sp)
        }
    }
}

/**
 * The cells, in the order they are read: headings, then row by row.
 *
 * The children are emitted in three runs — the [headers], one rule per column,
 * then the body row-major — because that is the contract
 * [tableGridMeasurePolicy] measures against, and because the run that carries
 * meaning (headings, then rows) comes first and in reading order. The rules
 * carry no semantics at all, so where they sit among the children is a measuring
 * detail and nothing a screen reader ever stops on.
 */
@Composable
private fun DataGrid(
    headers: List<String>,
    rows: List<List<String>>,
    modifier: Modifier = Modifier,
) {
    if (headers.isEmpty()) return
    val ruleColour = secondaryTint.copy(alpha = 0.25f)
    Layout(
        modifier = modifier,
        content = {
            headers.forEach { header ->
                Text(
                    // Uppercased by the invariant rules, like every other
                    // section label in this app: a reader in `tr-TR` must still
                    // read the column name, not a dotted capital.
                    text = header.uppercase(Locale.ROOT),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    softWrap = false,
                )
            }
            repeat(headers.size) {
                HorizontalDivider(color = ruleColour)
            }
            rows.forEach { row ->
                headers.indices.forEach { column ->
                    Text(
                        // A short row is padded, not dropped: iOS reads
                        // `colIdx < row.count ? row[colIdx] : stringResource(R.string.mobile_text_da39a3ee)` for the same
                        // reason, and a missing cell that took no space would
                        // slide the rest of the row under the wrong heading.
                        text = row.getOrElse(column) { "" },
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        softWrap = false,
                    )
                }
            }
        },
        measurePolicy = tableGridMeasurePolicy(columnCount = headers.size),
    )
}

/** iOS asks every cell for `minWidth: 65`; this is that, in whole dp. */
private val TABLE_MIN_COLUMN_WIDTH = 64.dp

/** The gutter between two columns, and the leading between two rows. */
private val TABLE_COLUMN_GAP = 18.dp
private val TABLE_ROW_GAP = 4.dp

/**
 * Column widths from the content, row positions from the columns.
 *
 * Expects its children in the order [DataGrid] emits them: [columnCount]
 * headings, then [columnCount] rules, then the body cells row-major. Everything
 * but the rules is measured against no constraint at all — inside a horizontal
 * scroller there isn't one, and a cell that wrapped would stop being a cell —
 * and only then is each column's width known: the widest thing in it, floored at
 * [minColumnWidth]. The rules are measured last, each against the fixed width of
 * the column it underlines, which is the only way a rule inside an unbounded
 * width gets one.
 *
 * Internal rather than private so a test can drive this exact policy with its
 * own children and read back what each rule was given; the alternative was a
 * test tag in the drawing, which would put test scaffolding in front of a screen
 * reader for the sake of a measurement.
 */
internal fun tableGridMeasurePolicy(
    columnCount: Int,
    minColumnWidth: Dp = TABLE_MIN_COLUMN_WIDTH,
    columnGap: Dp = TABLE_COLUMN_GAP,
    rowGap: Dp = TABLE_ROW_GAP,
): MeasurePolicy = MeasurePolicy { measurables, constraints ->
    require(columnCount > 0) { "a table with no columns has nothing to lay out" }
    val rowCount = (measurables.size - columnCount * 2) / columnCount
    val unbounded = Constraints()
    val headings = List(columnCount) { measurables[it].measure(unbounded) }
    val cells = List(rowCount * columnCount) {
        measurables[columnCount * 2 + it].measure(unbounded)
    }

    val floor = minColumnWidth.roundToPx()
    val widths = IntArray(columnCount) { column ->
        var widest = maxOf(floor, headings[column].width)
        for (row in 0 until rowCount) {
            widest = maxOf(widest, cells[row * columnCount + column].width)
        }
        widest
    }
    val rules = List(columnCount) {
        measurables[columnCount + it].measure(Constraints.fixedWidth(widths[it]))
    }

    val gutter = columnGap.roundToPx()
    val leading = rowGap.roundToPx()
    val x = IntArray(columnCount)
    var pen = 0
    for (column in 0 until columnCount) {
        x[column] = pen
        pen += widths[column] + gutter
    }
    val width = pen - gutter

    val headingHeight = headings.maxOf { it.height }
    val ruleY = headingHeight + leading
    val y = IntArray(rowCount)
    var baseline = ruleY + rules.maxOf { it.height }
    for (row in 0 until rowCount) {
        baseline += leading
        y[row] = baseline
        baseline += (0 until columnCount).maxOf { cells[row * columnCount + it].height }
    }

    layout(constraints.constrainWidth(width), constraints.constrainHeight(baseline)) {
        headings.forEachIndexed { column, heading -> heading.placeRelative(x[column], 0) }
        rules.forEachIndexed { column, rule -> rule.placeRelative(x[column], ruleY) }
        cells.forEachIndexed { index, cell ->
            cell.placeRelative(x[index % columnCount], y[index / columnCount])
        }
    }
}

/**
 * The bot thinking out loud, folded away until it is asked for.
 *
 * Closed by default: reasoning is not the answer, and a wall of it above an
 * empty bubble reads as the reply itself. Open, it is the last
 * [Reasoning.VISIBLE_CHARACTERS] characters as numbered lines in their own
 * scroller — 2,000 rather than the 400 this used to show, which was a quarter of
 * the thought with no way to reach the rest.
 */
@Composable
fun ThoughtChamber(
    reasoning: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = true,
) {
    val steps = remember(reasoning) { Reasoning.steps(reasoning) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    // `AgentThoughtChamberView.swift` fires `Haptics.selection()` on the header.
    val haptics = rememberHaptics()

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = MIN_TOUCH_TARGET)
                .background(secondaryTint.copy(alpha = 0.12f), CircleShape)
                .clickable(
                    role = Role.Button,
                    onClickLabel = if (expanded) "Collapse" else "Expand",
                    onClick = {
                        haptics.play(HapticCue.SELECT)
                        expanded = !expanded
                    },
                )
                .localizedSemantics(stateDescription = {
                    stringResource(
                        if (expanded) R.string.mobile_a11y_expanded else R.string.mobile_a11y_collapsed,
                    )
                })
                .padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_sparkles),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(16.dp),
            )
            Text(
                text = if (streaming) stringResource(R.string.mobile_thinking_a60d9c9c) else stringResource(R.string.mobile_thought_process_1756ad28),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (steps.size == 1) {
                    stringResource(R.string.mobile_step_29869c51)
                } else {
                    stringResource(R.string.mobile_steps_count, steps.size)
                },
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = secondaryTint,
            )
            Icon(
                imageVector = if (expanded) {
                    Icons.Filled.KeyboardArrowUp
                } else {
                    Icons.Filled.KeyboardArrowDown
                },
                contentDescription = null,
                tint = secondaryTint,
                modifier = Modifier.size(18.dp),
            )
        }

        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        secondaryTint.copy(alpha = 0.08f),
                        RoundedCornerShape(12.dp),
                    )
                    .heightIn(max = CHAMBER_HEIGHT)
                    .verticalScroll(rememberScrollState())
                    .padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                steps.forEachIndexed { index, step ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            text = "${index + 1}.",
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(text = step, fontSize = 13.sp, color = secondaryTint)
                    }
                }
            }
        }
    }
}

/** Hide/View, announced as the disclosure it is. */
@Composable
private fun Disclosure(expanded: Boolean, label: String, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .clip(RoundedCornerShape(8.dp))
            .clickable(
                role = Role.Button,
                onClickLabel = if (expanded) "Collapse" else "Expand",
                onClick = onToggle,
            )
            .localizedSemantics(stateDescription = {
                stringResource(
                    if (expanded) R.string.mobile_a11y_expanded else R.string.mobile_a11y_collapsed,
                )
            }),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (expanded) {
                Icons.Filled.KeyboardArrowDown
            } else {
                Icons.AutoMirrored.Filled.KeyboardArrowRight
            },
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(18.dp),
        )
        Text(text = label, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = secondaryTint)
    }
}

/**
 * A copy, as the two halves iOS gives it: the clipboard write, and the tick that
 * says it happened.
 *
 * `PlatformBridge.copyToPasteboard` ends every copy with `Haptics.selection()`,
 * unconditionally — so Copy Diff and Android's Copy CSV are confirmed by feel
 * and not only by a toast. iOS markdown tables do not offer Copy CSV (issue 1707).
 * neither platform shows. A copy is the one action on these cards with no
 * visible result at all: the button does not move, nothing opens, and the only
 * evidence is in a clipboard the reader has to leave the app to see. That is
 * exactly the interaction that needs the confirmation.
 *
 * Both cards go through this one object, so neither route can lose the tick
 * without the other losing it too — and [invoke] plays exactly one cue per call,
 * after the write is dispatched, in the order the Swift does it.
 */
internal class CardClipboard(
    private val write: (String) -> Unit,
    private val haptics: Haptics,
) {
    operator fun invoke(text: String) {
        write(text)
        haptics.play(HapticCue.SELECT)
    }
}

/** One clipboard write and one tick, reused by both cards. */
@Composable
private fun rememberCopy(): CardClipboard {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    return remember(clipboard, scope, haptics) {
        CardClipboard(
            write = { text ->
                scope.launch {
                    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(CARD_CLIP_LABEL, text)))
                }
                Unit
            },
            haptics = haptics,
        )
    }
}

private val CHAMBER_HEIGHT = 180.dp