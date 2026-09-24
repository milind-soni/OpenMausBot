package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Expectations for Android's own diff and table cards. iOS no longer uses
 * `parsedTable` or the SQL result card; bringing Android across is issue 1707.
 * The 80-line prefix in
 * `ios/App/Cards/GitPRDiffCardView.swift`, and `reasoning.suffix(2_000)` in
 * `StreamingBubble`. None of them derived from the Kotlin under test.
 *
 * Half of this file is about what must *not* become a card. That is the half
 * that matters: a loose gate does not fail loudly, it quietly turns somebody's
 * paragraph into a widget with the sentences cut out of it.
 */
class DiffCardTest {
    private val patch = """
        diff --git a/src/App.kt b/src/App.kt
        --- a/src/App.kt
        +++ b/src/App.kt
        @@ -1,3 +1,3 @@
        -val old = 1
        +val new = 2
    """.trimIndent()

    @Test
    fun `a message that opens with a git header is a patch`() {
        val card = assertNotNull(TranscriptCards.diff(patch))
        assertEquals(patch, card.text)
    }

    @Test
    fun `a closed diff fence is a patch, without its fence`() {
        val card = assertNotNull(TranscriptCards.diff("```diff\n$patch\n```"))
        assertEquals(patch, card.text)
    }

    @Test
    fun `an unclosed diff fence is a reply still being written`() {
        assertNull(TranscriptCards.diff("```diff\n$patch"))
    }

    @Test
    fun `prose that merely mentions a git header is prose`() {
        assertNull(
            TranscriptCards.diff("Run `git show` and look for the diff --git a/x.kt b/x.kt line."),
        )
        // Even a real patch stops being one when a sentence introduces it: iOS
        // requires the message to *start* with the header, not to contain it.
        assertNull(TranscriptCards.diff("Here is what changed:\n\n$patch"))
    }

    @Test
    fun `a fence of some other language is not a patch`() {
        assertNull(TranscriptCards.diff("```kotlin\nval x = 1\n```"))
        assertNull(TranscriptCards.diff("```\n$patch\n```"))
    }

    @Test
    fun `a language whose name merely starts with diff is accepted, as on iOS`() {
        // Inherited, and pinned deliberately. `parsedDiff` tests
        // `hasPrefix("```diff")` and nothing more, so ```` ```difference ````
        // opens a diff card there too. Tightening this on Android alone would
        // be the two clients disagreeing about what a message is; the place to
        // fix it is the Swift, and this test is what would fail if someone
        // tightened only this side without doing that.
        assertNotNull(TranscriptCards.diff("```difference\nplain prose\n```"))
    }

    @Test
    fun `the header word must be the whole word`() {
        // `diff --gitignore ...` is not a patch header.
        assertNull(TranscriptCards.diff("diff --gitignore a/x b/x\n+one"))
    }

    @Test
    fun `the name is the last word of the first line without its b prefix`() {
        assertEquals("src/App.kt", assertNotNull(TranscriptCards.diff(patch)).filename)
    }

    @Test
    fun `a first line with no words leaves the card named after what it is`() {
        // The fence is closed and empty, so there is nothing to name it after.
        assertEquals("Git patch", assertNotNull(TranscriptCards.diff("```diff\n```")).filename)
    }

    @Test
    fun `b slash is taken out wherever it appears`() {
        // Faithful to the Swift, which uses `replacingOccurrences(of: "b/")` and
        // so strips the directory as well as the prefix. Pinned because it is a
        // difference a reader would otherwise report as a port bug.
        assertEquals(
            "one.txt",
            assertNotNull(TranscriptCards.diff("diff --git a/b/one.txt b/b/one.txt\n+x")).filename,
        )
    }

    @Test
    fun `file headers are not counted as added or removed lines`() {
        val card = assertNotNull(TranscriptCards.diff(patch))
        // `+++ b/src/App.kt` and `--- a/src/App.kt` are the file headers.
        assertEquals(1, card.additions)
        assertEquals(1, card.deletions)
    }

    @Test
    fun `the preview stops at eighty lines and the toggle shows the rest`() {
        val long = "diff --git a/x b/x\n" + (1..120).joinToString("\n") { "+line $it" }
        val card = assertNotNull(TranscriptCards.diff(long))
        assertEquals(121, card.lines.size)
        assertTrue(card.isTruncated)
        assertEquals(80, card.visibleLines(showingAll = false).size)
        assertEquals("+line 79", card.visibleLines(showingAll = false).last())
        assertEquals(121, card.visibleLines(showingAll = true).size)
    }

    @Test
    fun `exactly eighty lines is not truncated`() {
        val exact = "diff --git a/x b/x\n" + (1..79).joinToString("\n") { "+line $it" }
        val card = assertNotNull(TranscriptCards.diff(exact))
        assertEquals(80, card.lines.size)
        assertFalse(card.isTruncated)
        assertEquals(80, card.visibleLines(showingAll = false).size)
    }

    @Test
    fun `copy always has every line, however few are on screen`() {
        val long = "diff --git a/x b/x\n" + (1..120).joinToString("\n") { "+line $it" }
        val card = assertNotNull(TranscriptCards.diff(long))
        assertEquals(long, card.text)
        assertTrue(card.text.endsWith("+line 120"))
    }

    @Test
    fun `your own patch stays your own message`() {
        val mine = message(role = Message.Role.USER, text = patch)
        assertNull(TranscriptCards.of(mine))
        assertNotNull(TranscriptCards.of(message(role = Message.Role.BOT, text = patch)))
    }
}

class DataTableTest {
    private val table = """
        | Name | Rows |
        | --- | ---: |
        | bots | 12 |
        | rooms | 3 |
    """.trimIndent()

    @Test
    fun `a strict markdown table is a table`() {
        val card = assertNotNull(TranscriptCards.table(table))
        assertEquals(listOf("Name", "Rows"), card.headers)
        assertEquals(listOf(listOf("bots", "12"), listOf("rooms", "3")), card.rows)
    }

    @Test
    fun `alignment colons are part of a separator, two hyphens are not`() {
        assertNotNull(TranscriptCards.table("| a |\n| :---: |\n| 1 |"))
        assertNotNull(TranscriptCards.table("| a |\n| - - - |\n| 1 |"))
        assertNull(TranscriptCards.table("| a |\n| -- |\n| 1 |"))
        assertNull(TranscriptCards.table("| a |\n| :-: |\n| 1 |"))
    }

    @Test
    fun `a ragged row is not a table`() {
        assertNull(TranscriptCards.table("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |"))
        assertNull(TranscriptCards.table("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |"))
    }

    @Test
    fun `a separator that does not match the header is not a table`() {
        assertNull(TranscriptCards.table("| a | b |\n| --- |\n| 1 | 2 |"))
    }

    @Test
    fun `every line must carry both edge pipes`() {
        assertNull(TranscriptCards.table("a | b\n--- | ---\n1 | 2"))
        assertNull(TranscriptCards.table("| a | b |\n| --- | --- |\n| 1 | 2"))
        assertNull(TranscriptCards.table("| a | b |\n--- | --- |\n| 1 | 2 |"))
    }

    @Test
    fun `a sentence anywhere near it makes it prose again`() {
        assertNull(TranscriptCards.table("Here are the counts:\n\n$table"))
        assertNull(TranscriptCards.table("$table\n\nThat is everything."))
    }

    @Test
    fun `a header and a separator alone are not a table`() {
        assertNull(TranscriptCards.table("| a | b |\n| --- | --- |"))
    }

    @Test
    fun `an escaped pipe belongs to the cell, not to the grid`() {
        val card = assertNotNull(
            TranscriptCards.table("| expr | means |\n| --- | --- |\n| a \\| b | or |"),
        )
        assertEquals(listOf(listOf("a | b", "or")), card.rows)
    }

    @Test
    fun `any other backslash is kept as typed`() {
        val card = assertNotNull(
            TranscriptCards.table("| path |\n| --- |\n| C:\\\\Users\\\\n |"),
        )
        assertEquals(listOf(listOf("C:\\\\Users\\\\n")), card.rows)
    }

    @Test
    fun `blank lines between rows do not break the table`() {
        assertNotNull(TranscriptCards.table("| a |\n| --- |\n\n| 1 |\n"))
    }

    @Test
    fun `your own table stays your own message`() {
        assertNull(TranscriptCards.of(message(role = Message.Role.USER, text = table)))
        assertNotNull(TranscriptCards.of(message(role = Message.Role.BOT, text = table)))
    }

    @Test
    fun `a patch wins over a table when a message could be read as either`() {
        // Not a real overlap, but the order is a decision: diff is tried first.
        assertTrue(TranscriptCards.of(message(text = "diff --git a/x b/x\n+a")) is TranscriptCard.Diff)
    }
}

class CsvTest {
    @Test
    fun `the header row comes first`() {
        val card = assertNotNull(TranscriptCards.table("| a | b |\n| --- | --- |\n| 1 | 2 |"))
        assertEquals("a,b\n1,2", card.csv())
    }

    @Test
    fun `a comma forces quotes`() {
        assertEquals("\"1,2\"", Csv.field("1,2"))
    }

    @Test
    fun `an internal quote is doubled inside quotes`() {
        assertEquals("\"he said \"\"hi\"\"\"", Csv.field("he said \"hi\""))
    }

    @Test
    fun `a line break forces quotes`() {
        assertEquals("\"one\ntwo\"", Csv.field("one\ntwo"))
        assertEquals("\"one\rtwo\"", Csv.field("one\rtwo"))
    }

    @Test
    fun `an ordinary field is left exactly as it is`() {
        assertEquals("plain", Csv.field("plain"))
        assertEquals("a | b", Csv.field("a | b"))
        assertEquals("", Csv.field(""))
    }

    @Test
    fun `a table with commas and quotes in it survives the round trip`() {
        val card = assertNotNull(
            TranscriptCards.table(
                "| name | note |\n| --- | --- |\n| a, b | he said \"hi\" |",
            ),
        )
        assertEquals("name,note\n\"a, b\",\"he said \"\"hi\"\"\"", card.csv())
    }
}

class ReasoningTest {
    /**
     * A Swift `String` is a collection of `Character` — extended grapheme
     * clusters — so `suffix(2_000)` counts clusters, not UTF-16 units. The
     * expectations below are written out rather than computed with `takeLast`,
     * which is the very semantics they exist to reject.
     *
     * `U+1F600 GRINNING FACE` is one character and two code units;
     * `e` + `U+0301 COMBINING ACUTE` is one character and two code units.
     * Deliberately not asserted: regional-indicator flags and ZWJ sequences,
     * where the JVM's `BreakIterator` implements an older UAX #29 than a
     * device's ICU. Those belong on the device plan.
     */
    private val grin = "\uD83D\uDE00"

    @Test
    fun `the chamber holds the last two thousand characters`() {
        val long = "y".repeat(3_000) + "x".repeat(2_000)
        assertEquals("x".repeat(2_000), Reasoning.visible(long))
    }

    @Test
    fun `an emoji costs one character, not two`() {
        // 2,000 Swift Characters, 2,001 UTF-16 units: the whole thing survives.
        val exact = grin + "a".repeat(1_999)
        assertEquals(exact, Reasoning.visible(exact))
    }

    @Test
    fun `the cut never lands inside a character`() {
        // 2,001 characters: the emoji goes whole rather than in halves, and the
        // tail cannot begin on a lone low surrogate.
        val over = grin + "a".repeat(2_000)
        assertEquals("a".repeat(2_000), Reasoning.visible(over))
        assertFalse(Reasoning.visible(over).first().isLowSurrogate())
    }

    @Test
    fun `a combining mark stays with the letter it sits on`() {
        val exact = "e\u0301" + "b".repeat(1_999)
        assertEquals(exact, Reasoning.visible(exact))

        val over = "e\u0301" + "b".repeat(2_000)
        assertEquals("b".repeat(2_000), Reasoning.visible(over))
    }

    @Test
    fun `shorter reasoning is shown whole`() {
        assertEquals("thinking", Reasoning.visible("thinking"))
        assertEquals("$grin ok", Reasoning.visible("$grin ok"))
    }

    @Test
    fun `steps are the non-empty lines of what is visible`() {
        assertEquals(
            listOf("first", "  second", "third"),
            Reasoning.steps("first\n\n  second\n   \nthird"),
        )
    }

    @Test
    fun `steps never reach past the cut`() {
        val tail = "y".repeat(2_000)
        assertEquals(listOf(tail), Reasoning.steps("forgotten\n" + tail))
    }
}

private fun message(
    role: Message.Role = Message.Role.BOT,
    text: String,
): Message = Message(
    id = "m1",
    role = role,
    kind = Message.Kind.TEXT,
    at = 1.0,
    text = text,
)
