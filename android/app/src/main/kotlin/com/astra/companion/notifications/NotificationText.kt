package com.astra.companion.notifications

import android.os.Build
import android.text.TextDirectionHeuristics

/**
 * Carries this app's reading-direction policy across into the notification shade.
 *
 * `CompanionTheme` settles the direction of everything Compose draws, but the
 * shade is not ours to draw: the template's `RemoteViews` are inflated in
 * SystemUI's window, and `NotificationCompat` exposes no text-direction control.
 * The only thing that crosses the boundary is the string, so the policy has to
 * travel inside it.
 *
 * The defect is not hypothetical. On a moto g32 (API 33) with the system in the
 * RTL pseudolocale, a bot answered `1 2 3 … 12` and the shade drew
 *
 * ```
 * Astra finished
 * 12 11 10 9 8 7 6 5 4 3 2 1
 * ```
 *
 * Title and body are both runtime strings from the same server frame. The title
 * has a strong character and settled itself LTR; the digit run has none, so it
 * took the shade's own RTL base level and reversed. Digits are weak (EN); with
 * an RTL base level the spaces between them resolve to R and the whole run lays
 * out right to left.
 *
 * The fix: every paragraph that does not settle its own direction gets a
 * U+200E LEFT-TO-RIGHT MARK in front of it. A paragraph that *does* settle
 * crosses untouched, so nothing here overrides a reader's own script — and
 * "settles" means what P2 means by it, which is not the same as "contains a
 * strong character somewhere": a strong character sealed inside an isolate pair
 * is skipped by P2 and settles nothing, so such a paragraph is anchored like any
 * other neutral one. English and Arabic in the ordinary case settle themselves.
 *
 * ### What counts as a paragraph
 *
 * U+000A LINE FEED, and nothing else. UAX#9's class B is wider (U+000D,
 * U+001C–U+001E, U+0085, U+2029), but the boundary that matters is the
 * *consumer's*. A multi-line `TextView` lays out through `StaticLayout`, which
 * splits by `PrecomputedText.createMeasuredParagraphs`
 * (`StaticLayout.java:869` → `PrecomputedText.java:505`), and that function looks
 * for `LINE_FEED = '\n'` (`PrecomputedText.java:80`) alone. Each slice is then
 * forced to be a single bidi paragraph by
 * `MeasuredParagraph.resetAndAnalyzeBidi` (`:709-710`), which rewrites every
 * remaining `BLOCK_SEPARATOR` as U+FFFC before re-running the ICU `Bidi`. CRLF
 * is covered by that — it ends in a feed.
 *
 * Marking the others would not be a harmless extra; measured through the same
 * `StaticLayout` the shade uses, it moves text that was already right. With
 * `"مرحبا" + U+2029 + "123"` there is one paragraph either way, and adding the
 * mark drags the Arabic in front of it from x=4000 to x=3961. With U+000A
 * instead there are two paragraphs, both fall back to RTL without the mark
 * (the digits at x=4000), and with it the second resolves LTR and the digits
 * start at x=0 — exactly what was missing.
 *
 * ### What the shade actually receives
 *
 * Both the decision and the writing are made over the prefix that survives to
 * the shade, because that prefix is what the platform resolves a direction for.
 * Two cuts apply, in this order:
 *
 *  - `NotificationCompat.Builder.limitCharSequenceLength` — a flat
 *    `subSequence(0, 5120)` on every level, applied by `setContentTitle`,
 *    `setContentText` and `BigTextStyle.bigText` alike (checked in the bytecode
 *    of `core-1.17.0`, no `SDK_INT` branch anywhere on the path);
 *  - `Notification.safeCharSequence` — `subSequence(0, MAX_CHARSEQUENCE_LENGTH)`,
 *    applied by `setContentTitle`, `setContentText` and `BigTextStyle.bigText`,
 *    where that constant is `5 * 1024` in the AOSP sources for 8.0, 8.1, 9, 10
 *    and 11 (API 26–30) and `1024` in 12, 12.1, 13, 14 and the API 37 sources
 *    installed here (API 31+); `javap` on the two `android-all` jars this suite
 *    runs agrees — 5120 on `-11`, 1024 on `-14`.
 *
 * So the delivered prefix is `min(5120, MAX_CHARSEQUENCE_LENGTH)`, which
 * [mostTheShadeKeeps] reads off `Build.VERSION.SDK_INT`.
 *
 * Deciding over anything wider than that prefix reopens the hole. A body of
 * `"1 2 3 4 5 ".repeat(200) + "Done"` settles itself — but the `Done` lives at
 * index 2000, past the 1024 the shade keeps from API 31, so the reader is handed
 * 1024 neutral characters and the shade orders them its own way. Asking about
 * the delivered prefix instead anchors it.
 *
 * ### What that costs, said plainly
 *
 * Each anchored paragraph spends one of the units the shade keeps, so a body
 * that fills the window loses one character off its tail per anchor. That is
 * the trade: characters the reader was about to lose to the cut anyway, against
 * the front of the body — including the one line a collapsed shade shows —
 * reading in the order it was written. Measured, a body of 512 one-character
 * lines spends 341 of the 1024 units on marks and the shade gets the first 342
 * of those lines. If that ever becomes the wrong bargain it changes in one
 * place, with tests that already measure both sides.
 *
 * The one thing an anchor is never spent on is a paragraph whose content the
 * cut leaves out entirely: with a single unit of room left, the character wins
 * and the mark is skipped, because a lone mark orders nothing.
 *
 * Nothing past the window is looked at either, and that is not a second policy:
 * `reach` below is both the last index the shade can be handed and the end of
 * the range every scan runs over — the search for the next break and the
 * first-strong pass alike. So an unbroken megabyte costs the same as an unbroken
 * kilobyte, and "the decision is taken over the delivered prefix" and "reading
 * stops at the delivered prefix" are one line of code, not two claims.
 *
 * ### Who decides, and who draws
 *
 * [settlesItsOwnDirection] does not answer on its own; it asks the two
 * heuristics `TEXT_DIRECTION_FIRST_STRONG` resolves to. Both wrap the same
 * `FirstStrong` algorithm and differ only in what they return when it finds
 * nothing (`TextDirectionHeuristics.java:55-63,150-190`), so they agree exactly
 * when the paragraph settles its own direction. Hand-rolling that search was
 * wrong twice over: `FirstStrong` skips everything between an isolate initiator
 * and its PDI (`:206-224`), and `isRtlCodePoint` (`:88-129`) reads a code point
 * with no entry in this device's table off the block it lives in — unassigned
 * between U+0590 and U+08FF counts as strong RTL.
 *
 * What draws the shade is not this heuristic, though: for `FIRSTSTRONG_*`,
 * `MeasuredParagraph` never calls `isRtl` at all — it asks ICU for
 * `Bidi.LEVEL_DEFAULT_RTL` and lets P2/P3 run. Two implementations of one rule,
 * which is exactly why the tests anchor with the heuristic and measure with ICU.
 */
internal object NotificationText {

    /** U+200E LEFT-TO-RIGHT MARK: strong L, invisible, zero width. */
    private const val LEFT_TO_RIGHT_MARK = '\u200E'

    /** The only break the shade's own segmentation splits paragraphs on. */
    private const val PARAGRAPH_BREAK = '\n'

    private const val CARRIAGE_RETURN = '\r'

    /** `NotificationCompat.Builder.limitCharSequenceLength`, on every level. */
    private const val COMPAT_KEEPS = 5120

    /** `Notification.MAX_CHARSEQUENCE_LENGTH` on API 26–30. */
    private const val FRAMEWORK_KEEPS_BEFORE_S = 5 * 1024

    /** `Notification.MAX_CHARSEQUENCE_LENGTH` from API 31. */
    private const val FRAMEWORK_KEEPS_FROM_S = 1024

    /**
     * [text] with an LTR anchor in front of every paragraph that would otherwise
     * take the shade's base direction, truncated to what the shade keeps.
     *
     * Never reorders a character and never removes one; the only loss is off the
     * tail, where the truncation the platform was going to apply anyway lands one
     * character earlier for each anchor written before it. An empty paragraph — a
     * blank line, including the blank line of a CRLF pair, or the stub after a
     * trailing feed — takes no anchor: it has nothing to order.
     */
    fun anchored(text: String): String =
        anchored(text, mostTheShadeKeeps(Build.VERSION.SDK_INT))

    /**
     * How many characters of one notification string reach the shade on
     * [sdkInt] — the tighter of the two cuts documented on this class.
     */
    internal fun mostTheShadeKeeps(sdkInt: Int): Int = minOf(
        COMPAT_KEEPS,
        if (sdkInt >= Build.VERSION_CODES.S) FRAMEWORK_KEEPS_FROM_S else FRAMEWORK_KEEPS_BEFORE_S,
    )

    private fun anchored(text: String, keeps: Int): String {
        if (text.isEmpty()) return text
        // For any text longer than the window, this is the final capacity: the
        // result cannot exceed `keeps`, so the builder never grows.
        val anchored = StringBuilder(minOf(keeps, text.length + 1))
        var start = 0
        while (anchored.length < keeps) {
            val room = keeps - anchored.length
            // The shade cannot be handed anything at or past here, so nothing at
            // or past here is read: not the search for the break, not the
            // first-strong pass. This one bound is the whole policy — decide
            // over the delivered prefix — and the whole cost bound with it.
            val reach = minOf(text.length, start + room)
            val breakAt = firstBreakIn(text, start, reach)
            val end = if (breakAt < 0) reach else breakAt
            // A CR before the feed is half of the break, not the last letter of
            // the line it ends — otherwise a blank CRLF line looks non-empty.
            val content =
                if (breakAt > start && text[breakAt - 1] == CARRIAGE_RETURN) breakAt - 1 else end
            // Anchoring shortens the delivered content by one, but an anchored
            // paragraph is settled by the anchor itself, so the question is only
            // ever asked about the unanchored form and stops here.
            if (content > start && room > 1 && !settlesItsOwnDirection(text, start, content)) {
                anchored.append(LEFT_TO_RIGHT_MARK)
            }
            anchored.append(text, start, minOf(end, start + (keeps - anchored.length)))
            if (breakAt < 0) break
            if (anchored.length < keeps) anchored.append(PARAGRAPH_BREAK)
            start = breakAt + 1
        }
        return anchored.toString()
    }

    /** First [PARAGRAPH_BREAK] in [text] from [from] until [until], or -1. */
    private fun firstBreakIn(text: String, from: Int, until: Int): Int {
        var i = from
        while (i < until) {
            if (text[i] == PARAGRAPH_BREAK) return i
            i++
        }
        return -1
    }

    /**
     * True when [text] from [start] until [end] settles its own base direction —
     * that is, when the platform's own first-strong pass finds a strong character
     * in it and the fallback never comes into play.
     */
    private fun settlesItsOwnDirection(text: String, start: Int, end: Int): Boolean {
        val count = end - start
        return TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(text, start, count) ==
            TextDirectionHeuristics.FIRSTSTRONG_RTL.isRtl(text, start, count)
    }
}
