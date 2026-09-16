package com.astra.companion.ui

import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.ResolvedTextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.astra.companion.core.TranscriptCard
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Which way a paragraph actually reads, measured off the laid-out text.
 *
 * On an `ar-EG` emulator the app drew *"?What do you mostly want help with"*,
 * counted *"16 15 … 1"* where the bot had said *"1 2 3 … 20"*, and cut the front
 * off every roster preview. All three were one defect: Compose's default
 * [androidx.compose.ui.text.style.TextDirection.Unspecified] takes the paragraph's
 * base level from `LocalLayoutDirection`, so an RTL locale reordered English.
 *
 * Nothing here asserts that a style property was set — a test like that would
 * have been green against the version that shipped the defect, since the
 * property *was* at its default and the default was the bug. Instead each test
 * mounts a composition under `LayoutDirection.Rtl` and reads the
 * [TextLayoutResult] the text node published: the resolved base direction, and
 * the x of the boxes the glyphs were actually placed in.
 *
 * The bubble tests drive [MarkdownText], which is the composable a bot reply is
 * drawn with (`MessageRow` → `MarkdownText(source = message.text)`). The roster
 * preview is drawn by a `Text` private to `ChatRow`, and `ChatRow` cannot be
 * mounted without a whole `CompanionEnvironment`, so that one is reproduced with
 * the call site's own arguments — the point being that it takes its style from
 * the theme, which is where the fix lives.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
// Robolectric's legacy graphics does not give metrics or ellipsis these
// assertions can be read off: run without this annotation, four of the seven
// fail on the *fixed* code — the preview never elides, both Arabic comparisons
// lose usable box positions, and two of the counted list's numbers report the
// same x. Native graphics lays the text out with the real font stack, which is
// what makes the positions and the ellipsis below evidence rather than
// decoration.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ParagraphDirectionTest {

    @get:Rule
    val compose = createComposeRule()

    /** Mounts [content] the way an Arabic phone mounts the app. */
    private fun inRtlLocale(content: @Composable () -> Unit) {
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                CompanionTheme(darkTheme = false) { content() }
            }
        }
    }

    private fun inLtrLocale(content: @Composable () -> Unit) {
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                CompanionTheme(darkTheme = false) { content() }
            }
        }
    }

    /**
     * The layout the text node published, which is the thing the glyphs were
     * drawn from. `GetTextLayoutResult` is the same semantics action the
     * platform's accessibility bridge reads.
     */
    private fun layoutOf(text: String): TextLayoutResult {
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
        val results = mutableListOf<TextLayoutResult>()
        val action = node.config[SemanticsActions.GetTextLayoutResult].action
        assertTrue(action != null && action(results), "the node produced no text layout")
        return results.first()
    }

    /** Left edge of the box character [offset] was placed in. */
    private fun TextLayoutResult.leftOf(offset: Int): Float = getBoundingBox(offset).left

    @Test
    fun `an English question keeps its LTR paragraph in an RTL locale`() {
        val question = "What do you mostly want help with?"
        inRtlLocale { MarkdownText(source = question, modifier = Modifier.requiredWidth(2000.dp)) }

        val layout = layoutOf(question)
        assertEquals(
            ResolvedTextDirection.Ltr,
            layout.getParagraphDirection(0),
            "English content must resolve to an LTR paragraph, whatever the locale mirrors",
        )
    }

    @Test
    fun `the question mark is drawn last, not first`() {
        val question = "What do you mostly want help with?"
        inRtlLocale { MarkdownText(source = question, modifier = Modifier.requiredWidth(2000.dp)) }

        val layout = layoutOf(question)
        val firstLetter = layout.leftOf(0)
        val questionMark = layout.leftOf(question.lastIndex)
        assertTrue(
            questionMark > firstLetter,
            "the '?' sat at x=$questionMark, left of the 'W' at x=$firstLetter — " +
                "that is the reordering that drew \"?What do you mostly want help with\"",
        )
        // And nothing else overtook it: it is the right-most glyph on the line.
        val rightmost = (0..question.lastIndex).maxOf { layout.leftOf(it) }
        assertEquals(questionMark, rightmost, "the '?' has to end the line")
    }

    @Test
    fun `a counted list stays in ascending order in an RTL locale`() {
        // The bot's reply, verbatim: nothing in it is a strong character, so this
        // is the case a content-or-*layout* rule (TextView's FIRST_STRONG, or
        // Compose's TextDirection.Content) still gets wrong.
        val counted = "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"
        inRtlLocale { MarkdownText(source = counted, modifier = Modifier.requiredWidth(2000.dp)) }

        val layout = layoutOf(counted)
        assertEquals(
            ResolvedTextDirection.Ltr,
            layout.getParagraphDirection(0),
            "digits are weak; with an RTL base level the whole sequence reverses",
        )

        // Where each number starts, in the order they were written.
        val starts = buildList {
            var index = 0
            counted.split(" ").forEach { token -> add(index); index += token.length + 1 }
        }
        val xs = starts.map { layout.leftOf(it) }
        xs.zipWithNext().forEachIndexed { i, (left, right) ->
            assertTrue(
                right > left,
                "number ${i + 2} was drawn at x=$right, left of number ${i + 1} at x=$left — " +
                    "the sequence read backwards",
            )
        }
    }

    /**
     * The other half of "resolved from the content": the fix must not have
     * pinned everything to LTR. Two tests, not one, because the rule mounts a
     * composition exactly once.
     */
    @Test
    fun `Arabic reads right to left on an English phone`() {
        inLtrLocale { MarkdownText(source = ARABIC, modifier = Modifier.requiredWidth(2000.dp)) }

        val layout = layoutOf(ARABIC)
        assertEquals(ResolvedTextDirection.Rtl, layout.getParagraphDirection(0))
        assertTrue(
            layout.leftOf(0) > layout.leftOf(ARABIC.lastIndex),
            "the first Arabic letter belongs on the right of the last one",
        )
    }

    @Test
    fun `Arabic still reads right to left on an Arabic phone`() {
        inRtlLocale { MarkdownText(source = ARABIC, modifier = Modifier.requiredWidth(2000.dp)) }

        val layout = layoutOf(ARABIC)
        assertEquals(ResolvedTextDirection.Rtl, layout.getParagraphDirection(0))
        assertTrue(
            layout.leftOf(0) > layout.leftOf(ARABIC.lastIndex),
            "the first Arabic letter belongs on the right of the last one",
        )
    }

    /**
     * The roster's preview line: one line, ellipsised, on a narrow column.
     *
     * The layout is taken from `onTextLayout` rather than from the semantics
     * action the other tests use, and that is not a convenience. `Text(String)`
     * is drawn by `TextStringSimpleNode`, whose `GetTextLayoutResult` does not
     * hand back the layout it drew: it calls
     * `ParagraphLayoutCache.slowCreateTextLayoutResultOrNull`, which builds a
     * *fresh* `MultiParagraph` from a `MultiParagraphIntrinsics` constructed
     * with no layout direction at all. What that reconstruction falls back to
     * is `AndroidParagraphIntrinsics.resolveTextDirectionHeuristics`, which
     * resolves `Content`/`Unspecified` to first-strong against the style's
     * `localeList` and, failing that, `Locale.getDefault()` — so it is
     * first-strong-*LTR* here, and would be first-strong-*RTL* in a process
     * whose default locale is Arabic. Either way it is not the direction that
     * was painted: on this Compose version the node reports `Ltr` through the
     * semantics action while `onTextLayout` reports `Rtl`, with the line
     * starting at x = -13.7 — the clipping that ate the "er" of "error:". Read
     * through semantics, this test is green against the defect it exists to
     * catch.
     *
     * That is a `Text(String)` trap and nothing wider. `Text(AnnotatedString)`
     * — which is what [MarkdownText] builds, and so what the five tests above
     * that call `layoutOf` are reading — is drawn by `TextAnnotatedStringNode`,
     * whose semantics take the measured layout out of the cache, so a direction
     * read from those nodes is the direction that was drawn. (The table test
     * below reads `Text(String)` nodes, but it never asks for a layout: it
     * compares spoken order and `boundsInRoot`, so the trap does not reach it.)
     */
    @Test
    fun `a one-line preview is cut at its end, not at its beginning`() {
        val preview = "error: CUA Driver is not ready for this computer yet"
        var captured: TextLayoutResult? = null
        inRtlLocale {
            Text(
                text = preview,
                fontSize = 15.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { captured = it },
                modifier = Modifier.requiredWidth(160.dp),
            )
        }
        compose.waitForIdle()

        val layout = requireNotNull(captured) { "the preview never reported a layout" }
        assertEquals(
            ResolvedTextDirection.Ltr,
            layout.getParagraphDirection(0),
            "an English preview reads LTR",
        )

        val visible = layout.getLineEnd(0, visibleEnd = true)
        assertTrue(visible < preview.length, "the line has to overflow for this to mean anything")

        // Nothing spills past the leading edge: on the device the whole run was
        // pushed to negative x and the phone clipped the opening characters,
        // which is how "error: CUA Driver…" came out as "ror: CUA Driver…".
        assertTrue(
            layout.getLineLeft(0) >= 0f,
            "the line started at x=${layout.getLineLeft(0)}, outside its own box",
        )
        assertTrue(
            layout.getBoundingBox(0).left >= 0f,
            "the opening 'e' of \"error:\" was drawn at x=${layout.getBoundingBox(0).left}",
        )
        // And what survives reads left to right, ending in the ellipsis.
        assertTrue(
            layout.getBoundingBox(visible - 1).left > layout.getBoundingBox(0).left,
            "the kept run has to read left to right",
        )
    }

    /**
     * PASS20's table, re-measured under RTL.
     *
     * The card reads by row and mirrors its columns through `placeRelative`, and
     * that has to survive a change to how paragraphs pick a direction — the two
     * are independent, and this is the test that says so.
     */
    @Test
    fun `the data table still reads across and still mirrors`() {
        val languages = TranscriptCard.Table(
            headers = listOf("language", "year"),
            rows = listOf(listOf("Python", "1991"), listOf("Java", "1995")),
        )
        inRtlLocale { DataTableCard(languages) }

        fun spoken(node: SemanticsNode): List<String> = buildList {
            node.config.getOrNull(SemanticsProperties.Text)?.forEach { add(it.text) }
            node.config.getOrNull(SemanticsProperties.ContentDescription)?.forEach { add(it) }
            node.children.forEach { addAll(spoken(it)) }
        }
        assertEquals(
            listOf(
                "DATA TABLE", "2 rows",
                "LANGUAGE", "YEAR",
                "Python", "1991",
                "Java", "1995",
                "Copy CSV",
            ),
            spoken(compose.onRoot().fetchSemanticsNode()),
            "the reading order is row-major, mirrored or not",
        )

        fun left(text: String) =
            compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot.left
        assertTrue(
            left("LANGUAGE") > left("YEAR"),
            "the first column belongs on the right in an RTL locale",
        )
        assertTrue(
            left("Python") > left("1991"),
            "and so does the first cell of every row",
        )
    }

    private companion object {
        /** "Welcome to Astra" — strong RTL from its first letter. */
        const val ARABIC = "مرحبا بك في أوبن ماوس"
    }
}
