package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import com.openmausbot.companion.core.TranscriptCard
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The order the table card offers a screen reader, read off the merged tree.
 *
 * This is the one thing about [DataTableCard] no pure function can answer. The
 * card was once a `Row` of `Column`s, and TalkBack on an API 34 emulator read it out as
 * *"LANGUAGE, Python, Java, Rust, YEAR, 1991, 1995, 2010"* — the whole of the
 * first column before the second, so no row survived the reading. A test that
 * asserted over `card.rows` would have been green through all of that; the
 * defect lived in the semantics tree, so the assertion has to be over the
 * semantics tree, which is why this file mounts the real composition under
 * Robolectric rather than reasoning about the model.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TableReadingOrderTest {

    @get:Rule
    val compose = createComposeRule()

    private val languages = TranscriptCard.Table(
        headers = listOf("language", "year"),
        rows = listOf(
            listOf("Python", "1991"),
            listOf("Java", "1995"),
            listOf("Rust", "2010"),
        ),
    )

    /**
     * Everything the merged tree carries, in the order the tree carries it.
     *
     * That child order is the order the composition built, which is exactly the
     * thing that was wrong before, and so the thing worth asserting on. It is
     * not by itself the sequence TalkBack speaks: the platform delegate takes
     * this tree, groups nodes by geometry and publishes
     * `traversalBefore`/`traversalAfter` relations over it. The two agree for
     * this card — the corrected tree is row-major and the corrected layout is
     * row-major — and transposing the grid makes this walk return the exact
     * column-major sequence that was measured on an API 34 device, which is why
     * the walk is evidence at all. A pass with TalkBack on a device stays the
     * final word.
     */
    private fun spoken(node: SemanticsNode): List<String> = buildList {
        node.config.getOrNull(SemanticsProperties.Text)?.forEach { add(it.text) }
        node.config.getOrNull(SemanticsProperties.ContentDescription)?.forEach { add(it) }
        node.children.forEach { addAll(spoken(it)) }
    }

    private fun spokenCard(card: TranscriptCard.Table): List<String> {
        compose.setContent { CompanionTheme(darkTheme = false) { DataTableCard(card) } }
        return spoken(compose.onRoot().fetchSemanticsNode())
    }

    @Test
    fun `the tree reads by row, headings first, the way iOS does`() {
        assertEquals(
            listOf(
                "DATA TABLE", "3 rows",
                "LANGUAGE", "YEAR",
                "Python", "1991",
                "Java", "1995",
                "Rust", "2010",
                "Copy CSV",
            ),
            spokenCard(languages),
        )
    }

    @Test
    fun `a short row is read as an empty cell, not as a shifted one`() {
        val ragged = TranscriptCard.Table(
            headers = listOf("language", "year"),
            rows = listOf(listOf("Python", "1991"), listOf("Java")),
        )
        assertEquals(
            listOf(
                "DATA TABLE", "2 rows",
                "LANGUAGE", "YEAR",
                "Python", "1991",
                "Java", "",
                "Copy CSV",
            ),
            spokenCard(ragged),
        )
    }

    @Test
    fun `a column still lines up, and a row still shares a top`() {
        compose.setContent { CompanionTheme(darkTheme = false) { DataTableCard(languages) } }

        fun left(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot.left
        fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot.top

        val first = left("LANGUAGE")
        listOf("Python", "Java", "Rust").forEach { assertEquals(first, left(it), 0.5f, it) }
        val second = left("YEAR")
        listOf("1991", "1995", "2010").forEach { assertEquals(second, left(it), 0.5f, it) }
        assertTrue(second > first, "the second column has to sit to the right of the first")

        assertEquals(top("Python"), top("1991"), 0.5f, "Python/1991")
        assertEquals(top("Java"), top("1995"), 0.5f, "Java/1995")
        assertEquals(top("Rust"), top("2010"), 0.5f, "Rust/2010")
        assertTrue(top("Java") > top("Python"), "row two sits below row one")
    }

    @Test
    fun `a table wider than the card still scrolls sideways`() {
        val wide = TranscriptCard.Table(
            headers = List(8) { "column number $it" },
            rows = listOf(List(8) { "a fairly long value $it" }),
        )
        compose.setContent { CompanionTheme(darkTheme = false) { DataTableCard(wide) } }
        val scroller = compose
            .onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange))
            .fetchSemanticsNode()
        val range = scroller.config[SemanticsProperties.HorizontalScrollAxisRange]
        assertTrue(range.maxValue() > 0f, "the grid overflows, so there is somewhere to scroll to")
    }

    /**
     * The rule under a heading, measured against the production policy itself.
     *
     * The children here are the test's own — three headings, three rules, one
     * row — but [tableGridMeasurePolicy] is the one the card uses, so what the
     * rules come back measuring is what the card's rules measure. Doing it this
     * way keeps test tags out of the drawing, where they would be scaffolding
     * sitting in front of a screen reader.
     */
    @Test
    fun `each rule is as wide as its own column, floored at the iOS minimum`() {
        compose.setContent {
            Layout(
                content = {
                    Box(Modifier.size(width = 120.dp, height = 12.dp))
                    Box(Modifier.size(width = 30.dp, height = 12.dp))
                    Box(Modifier.size(width = 20.dp, height = 12.dp))
                    repeat(3) { Box(Modifier.testTag("rule-$it").height(1.dp)) }
                    Box(Modifier.size(width = 40.dp, height = 10.dp))
                    Box(Modifier.size(width = 200.dp, height = 10.dp))
                    Box(Modifier.size(width = 20.dp, height = 10.dp))
                },
                measurePolicy = tableGridMeasurePolicy(columnCount = 3),
            )
        }

        fun rule(index: Int) = compose.onNodeWithTag("rule-$index").getBoundsInRoot()

        // Widest heading, widest cell, and a column where nothing reaches 64.dp.
        assertEquals(120f, rule(0).width.value, 0.5f, "column 0")
        assertEquals(200f, rule(1).width.value, 0.5f, "column 1")
        assertEquals(64f, rule(2).width.value, 0.5f, "column 2")

        // And they start where their columns start: 18.dp of gutter between.
        assertEquals(0f, rule(0).left.value, 0.5f, "column 0 origin")
        assertEquals(138f, rule(1).left.value, 0.5f, "column 1 origin")
        assertEquals(356f, rule(2).left.value, 0.5f, "column 2 origin")
    }

    private fun assertEquals(expected: Float, actual: Float, delta: Float, what: String) {
        assertTrue(abs(expected - actual) <= delta, "$what: expected $expected, was $actual")
    }
}
