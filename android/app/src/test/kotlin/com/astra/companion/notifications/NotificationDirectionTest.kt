package com.astra.companion.notifications

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.text.Layout
import android.text.StaticLayout
import android.text.TextDirectionHeuristics
import android.text.TextPaint
import com.astra.companion.core.NotificationFrame
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Which way a notification reads once SystemUI has it.
 *
 * On a moto g32 (API 33) with the system in the RTL pseudolocale, a bot answered
 * `1 2 3 … 12` and the shade drew the count backwards under a title that came
 * out right. Both strings arrived in the same server frame, so the difference
 * was not the pseudolocale: the title has a strong character and settled itself,
 * the digit run has none and took the shade's RTL base level.
 *
 * The tests that carry the argument do not assert that a marker was inserted —
 * an assertion like that would be green against any implementation that inserts
 * markers, right ones and wrong ones alike. They post through the real
 * [LocalNotificationPoster], read the string back out of the [Notification] the
 * platform built, and lay it out with the same [StaticLayout] the shade's
 * `TextView` uses, under [TextDirectionHeuristics.FIRSTSTRONG_RTL] — which is
 * what `TEXT_DIRECTION_FIRST_STRONG` resolves to in a mirrored window. What they
 * assert is the resolved paragraph direction and the x each digit was placed at.
 *
 * Not all 21 do that, though, and the difference is worth naming (the groups
 * overlap, so the counts do not add up to 21):
 *
 *  - **Direction, measured — 13.** They post and then measure the laid-out
 *    paragraph: its resolved direction, and for the counted ones the x of each
 *    digit. These are the ones the defect and the fix are argued from. Four of
 *    them also assert the string came back byte for byte unchanged.
 *  - **Came back unchanged — 5.** They post and compare strings without laying
 *    anything out: four against the input, because for an over-anchoring guard
 *    "unchanged" *is* the assertion, and one between the collapsed body and the
 *    expanded one.
 *  - **A marker written out — 2.** The blank line of a CRLF pair and the ceiling
 *    on what gets built spell an anchor into an expected value, because in both
 *    the subject is a character nobody can see.
 *  - **Reaching past the poster — 2.** `what the shade keeps is read off the API
 *    level` never posts; the per-level table has no other surface. And the first
 *    half of `a body longer than the shade keeps is anchored no further than
 *    that` calls [NotificationText.anchored] directly because it has to: the
 *    *posted* string cannot tell a bounded build from an unbounded one, since
 *    the platform truncates to the same length either way, so the only place to
 *    see where the building stopped is what was built.
 *
 * The level matters. What reaches the shade is
 * `min(5120, Notification.MAX_CHARSEQUENCE_LENGTH)` — 5120 up to API 30, 1024
 * from API 31 — so tests that cross that boundary run at both levels this
 * suite's `android-all` jars cover: 30 and 34.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
// Robolectric's legacy graphics gives no font metrics these assertions can be
// read off; native graphics lays the text out with the real font stack, which is
// what makes a glyph's x evidence rather than decoration.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotificationDirectionTest {

    // ---------------------------------------------------------------- policy

    @Test
    fun `English text crosses to the shade untouched`() {
        val body = "I finished the report and left it on your desk."
        assertEquals(body, postedBody(body), "a paragraph that settles itself is not ours to touch")
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            inArabicShade(postedBody(body)).getParagraphDirection(0),
            "English settles its own direction, mirrored window or not",
        )
    }

    @Test
    fun `Arabic keeps its own direction in the shade`() {
        val body = "مرحبا بالعالم"
        assertEquals(body, postedBody(body), "Arabic is nobody's to anchor")
        assertEquals(
            Layout.DIR_RIGHT_TO_LEFT,
            inArabicShade(postedBody(body)).getParagraphDirection(0),
            "Arabic has to keep reading right to left",
        )
    }

    @Test
    fun `a counted list stays in ascending order in an Arabic shade`() {
        val body = "1 2 3 4 5 6 7 8 9 10 11 12"
        val shade = inArabicShade(postedBody(body))
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "a count is nobody else's to settle; without an anchor it falls back to the shade",
        )
        assertAscending(shade, postedBody(body), "1", "2", "3")
    }

    @Test
    fun `a count in front of Arabic words still reads right to left`() {
        val body = "12 رسائل جديدة"
        assertEquals(body, postedBody(body), "P2 walks past the digits and the Arabic settles it")
        assertEquals(
            Layout.DIR_RIGHT_TO_LEFT,
            inArabicShade(postedBody(body)).getParagraphDirection(0),
            "the paragraph belongs to the Arabic in it",
        )
    }

    // ----------------------------------------------------------- paragraphs

    @Test
    fun `a counted list stays in ascending order on every line it takes`() {
        for (separator in listOf("\n", "\r\n")) {
            val body = "1 2${separator}3 4"
            val shade = inArabicShade(postedBody(body))
            assertEquals(2, shade.lineCount, "a line feed opens a second paragraph")
            for (line in 0 until shade.lineCount) {
                assertEquals(
                    Layout.DIR_LEFT_TO_RIGHT,
                    shade.getParagraphDirection(line),
                    "a later paragraph is nobody else's to settle either (line $line)",
                )
            }
        }
    }

    @Test
    fun `a counted line under an English line is anchored on its own`() {
        val shade = inArabicShade(postedBody("Done\n1 2 3"))
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "the English line settles itself",
        )
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(1),
            "the count under an English line is still a paragraph of its own",
        )
    }

    @Test
    fun `an Arabic line keeps its direction while the line under it is anchored`() {
        val shade = inArabicShade(postedBody("مرحبا\n1 2 3"))
        assertEquals(
            Layout.DIR_RIGHT_TO_LEFT,
            shade.getParagraphDirection(0),
            "the Arabic line is its own paragraph and keeps its direction",
        )
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(1),
            "the count below it is not",
        )
    }

    @Test
    fun `only a line feed starts a new paragraph in the shade`() {
        // UAX#9 class B is wider than this, but the boundary that matters is the
        // consumer's: StaticLayout splits on U+000A alone and forces every other
        // block separator to a neutral before ICU sees it.
        for (separator in listOf('\r', '\u001C', '\u001D', '\u001E', '\u0085', '\u2029')) {
            val body = "1 2${separator}3 4"
            val posted = postedBody(body)
            val shade = inArabicShade(posted)
            assertEquals(
                1,
                shade.lineCount,
                "U+%04X is inside the paragraph the leading anchor settles".format(separator.code),
            )
            assertEquals(
                Layout.DIR_LEFT_TO_RIGHT,
                shade.getParagraphDirection(0),
                "one anchor at the front governs all of it",
            )
            assertAscending(shade, posted, "1", "2", "3", "4")
        }
    }

    @Test
    fun `a separator that is not a line feed is left unmarked inside Arabic`() {
        // Measured: an anchor after U+2029 lands inside an already-resolved
        // paragraph and moves the Arabic in front of it from x=4000 to x=3946.
        val body = "مرحبا\u2029123"
        assertEquals(body, postedBody(body), "there is no second paragraph here to anchor")
    }

    // ------------------------------------------------- who reads the strings

    @Test
    fun `strong text inside an isolate settles nothing, and the line is anchored`() {
        // P2 and the platform's FirstStrong both skip everything between an
        // isolate initiator and its PDI, so this paragraph has no strong
        // character of its own.
        val shade = inArabicShade(postedBody("\u2067مرحبا\u2069 1 2"))
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "the only strong text is sealed inside an isolate, so the paragraph is still " +
                "nobody's to settle and has to be anchored",
        )
    }

    @Test
    fun `strong text outside the isolates still settles the paragraph`() {
        val body = "Reply \u2067مرحبا\u2069 1 2"
        assertEquals(body, postedBody(body), "the R outside the isolate settles this paragraph")
    }

    @Test
    fun `a code point this device has no table for is still the platform's to read`() {
        // U+05EC is unassigned; isRtlCodePoint reads it off the block it lives
        // in, and unassigned between U+0590 and U+08FF counts as strong RTL.
        val body = "\u05EC 1 2"
        assertEquals(body, postedBody(body), "the paragraph settles its own direction")
    }

    @Test
    fun `a blank CRLF line takes no anchor, exactly like a blank line`() {
        // Reads the marker on purpose: its whole subject is a character nobody
        // sees. The CR is half of the break, not the last letter of the line it
        // ends, so the blank line between the two has nothing to order.
        assertEquals(
            "\u200E1 2\r\n\r\n\u200E3 4",
            postedBody("1 2\r\n\r\n3 4"),
            "the blank line has nothing to order, so it is not paid for",
        )
    }

    // ------------------------------------------- the prefix the shade is given

    @Test
    fun `the character that settles a paragraph counts from where the shade stops reading`() {
        // The strong "Done" sits at index 2000, past the 1024 this level keeps.
        // Deciding over the whole paragraph finds it, adds no anchor, and hands
        // the reader 1024 neutral characters for the shade to order its own way.
        val body = "1 2 3 4 5 ".repeat(200) + "Done"
        val posted = postedBody(body)
        assertEquals(1024, posted.length, "this is the body the shade was handed")
        assertTrue("Done" !in posted, "the character that settles it never reaches the shade")
        val shade = inArabicShade(posted)
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "what the shade resolves a direction for is what the shade was given",
        )
        assertAscending(shade, posted, "1", "2", "3")
    }

    @Test
    fun `an unbroken body is decided at the window like any other`() {
        // No line feed anywhere: the paragraph is the whole megabyte, and the
        // strong "Done" that would settle it sits a million characters past
        // what the shade keeps. Nothing here may be read, and nothing is.
        val body = "1 2 3 4 5 ".repeat(100_000) + "Done"
        val posted = postedBody(body)
        assertEquals(1024, posted.length, "this is the body the shade was handed")
        assertTrue("Done" !in posted, "the character that would settle it never reaches the shade")
        val shade = inArabicShade(posted)
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "an unbroken body is still resolved from the prefix the shade was given",
        )
        assertAscending(shade, posted, "1", "2", "3")
    }

    @Test
    @Config(sdk = [30])
    fun `the same body settles itself where the shade keeps more of it`() {
        // Same body, a level whose ceiling is 5120: "Done" arrives, so the
        // paragraph settles itself and nothing is anchored.
        val body = "1 2 3 4 5 ".repeat(200) + "Done"
        val posted = postedBody(body)
        assertEquals(body, posted, "a paragraph that settles itself is handed over untouched")
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            inArabicShade(posted).getParagraphDirection(0),
            "the Done at the end settles it",
        )
    }

    @Test
    fun `what the shade keeps is read off the API level`() {
        for (level in 26..30) {
            assertEquals(
                5120,
                NotificationText.mostTheShadeKeeps(level),
                "Notification.MAX_CHARSEQUENCE_LENGTH is 5 * 1024 on API $level",
            )
        }
        for (level in 31..37) {
            assertEquals(
                1024,
                NotificationText.mostTheShadeKeeps(level),
                "Notification.MAX_CHARSEQUENCE_LENGTH is 1024 on API $level",
            )
        }
    }

    @Test
    fun `a body longer than the shade keeps is anchored no further than that`() {
        val body = "1 2\n".repeat(256_000) // 1,024,000 characters
        val built = NotificationText.anchored(body)
        assertEquals(
            1024,
            built.length,
            "anchoring a ${body.length}-character body produced ${built.length} characters — " +
                "the building is supposed to stop where the shade does",
        )
        // Every line of this body is neutral, so the front of it anchored line by
        // line is just the anchored line repeated.
        assertEquals(
            "\u200E1 2\n".repeat(205).take(1024),
            built,
            "what was built is not the front of the whole body anchored",
        )
        assertEquals(built, postedBody(body), "and that is what the shade was handed")
    }

    @Test
    fun `an anchor is never the last unit the shade has room for`() {
        // The second paragraph starts on the final unit of room. Spending it on
        // an anchor would order nothing and would push the only character of
        // that line out of what the shade keeps.
        val body = "A".repeat(1022) + "\n5"
        val posted = postedBody(body)
        assertEquals(1024, posted.length, "this is the whole window")
        assertEquals(body, posted, "the character wins the last unit, not the mark")
    }

    // ------------------------------------------------------------- the title

    @Test
    fun `a title with no strong character is anchored too`() {
        val title = "1 2 3"
        val posted = postedTitle(title)
        val shade = inArabicShade(posted)
        assertEquals(
            Layout.DIR_LEFT_TO_RIGHT,
            shade.getParagraphDirection(0),
            "a title is a paragraph in the same window as the body",
        )
        assertAscending(shade, posted, "1", "2", "3")
    }

    @Test
    fun `the expanded body is the same string as the collapsed one`() {
        val body = "1 2 3\n4 5 6"
        assertEquals(
            postedBody(body),
            postedExtra(Notification.EXTRA_BIG_TEXT, body = body),
            "BigTextStyle draws the same body and needs the same anchoring",
        )
    }

    // ------------------------------------------------------------- machinery

    private fun postedBody(body: String): String = postedExtra(Notification.EXTRA_TEXT, body = body)

    private fun postedTitle(title: String): String =
        postedExtra(Notification.EXTRA_TITLE, title = title)

    /** Posts one frame through the real poster and reads [extra] back off it. */
    private fun postedExtra(
        extra: String,
        title: String = "Astra finished",
        body: String = "done",
    ): String {
        val context = RuntimeEnvironment.getApplication() as Application
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancelAll()
        LocalNotificationPoster(context).deliver(
            NotificationFrame(
                kind = "done",
                botId = "luna",
                botName = "Astra",
                threadId = "t1",
                title = title,
                body = body,
            ),
            sequence = 1,
        )
        val posted = shadowOf(manager).allNotifications.single()
        return posted.extras.getCharSequence(extra).toString()
    }

    /** The layout the shade's own `TextView` would build in a mirrored window. */
    private fun inArabicShade(text: String): StaticLayout {
        val paint = TextPaint().apply { textSize = 24f }
        return StaticLayout.Builder
            .obtain(text, 0, text.length, paint, SHADE_WIDTH)
            .setTextDirection(TextDirectionHeuristics.FIRSTSTRONG_RTL)
            .build()
    }

    /** Each of [pieces] has to have been drawn to the right of the one before. */
    private fun assertAscending(shade: StaticLayout, text: String, vararg pieces: String) {
        var from = 0
        var previousX = Float.NEGATIVE_INFINITY
        var previous = ""
        for (piece in pieces) {
            val at = text.indexOf(piece, from)
            assertTrue(at >= 0, "\"$piece\" is not in the string the shade was handed")
            val x = shade.getPrimaryHorizontal(at)
            assertTrue(
                x > previousX,
                "\"$piece\" was drawn at x=$x, left of \"$previous\" at x=$previousX — " +
                    "the shade read it backwards",
            )
            previousX = x
            previous = piece
            from = at + piece.length
        }
    }

    private companion object {
        const val SHADE_WIDTH = 4000
    }
}
