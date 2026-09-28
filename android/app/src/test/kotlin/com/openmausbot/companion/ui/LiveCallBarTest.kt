package com.openmausbot.companion.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import kotlin.math.roundToInt
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The bar as a person meets it: which line and which buttons each phase shows,
 * what the buttons call, and that on a narrow phone a long reason still says
 * what to do and a long caption still shows its newest words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiveCallBarTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val taps = mutableListOf<String>()
    private val actions = LiveCallBarActions(
        onMute = { taps += "mute:$it" },
        onSettings = { taps += "settings" },
        onHangUp = { taps += "hangup" },
        onRetry = { taps += "retry" },
        onDismiss = { taps += "dismiss" },
    )

    private fun mount(model: LiveCallBarModel) {
        compose.setContent { CompanionTheme(darkTheme = false) { LiveCallBar(model, actions) } }
    }

    @Test
    fun aLiveBarShowsTheClockTheCaptionAndTheThreeControls() {
        mount(LiveCallBarModel.Local("Live with Ada", "Hello there", "", muted = false, speaker = true, phase = LiveCallPhase.LIVE, clock = "1:05"))
        compose.onNodeWithContentDescription("Live call").assertExists()
        compose.onNodeWithText("Live with Ada", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(" · 1:05", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("Captions").assertTextEquals("Hello there")
        // TalkBack reads the caption, not a label standing in for it.
        compose.onAllNodesWithContentDescription("Captions").assertCountEquals(0)
        compose.onNodeWithContentDescription("Mute").performClick()
        compose.onNodeWithContentDescription("Live call settings").performClick()
        compose.onNodeWithContentDescription("Hang up").performClick()
        assertEquals(listOf("mute:true", "settings", "hangup"), taps)
        compose.onAllNodesWithText("Try again").assertCountEquals(0)
    }

    @Test
    fun thePersonsOwnWordsReplaceTheCaptionWhileTheySpeakAndMuteReadsUnmute() {
        mount(LiveCallBarModel.Local("Live with Ada · 0:09", "It is noon.", "what time", muted = true, speaker = true, phase = LiveCallPhase.LIVE))
        compose.onNodeWithTag("Captions").assertTextEquals("what time")
        compose.onNodeWithContentDescription("Unmute").performClick()
        assertEquals(listOf("mute:false"), taps)
    }

    @Test
    fun connectingHasNoCaptionLineYet() {
        mount(LiveCallBarModel.Local("Connecting…", "", "", muted = false, speaker = true, phase = LiveCallPhase.STARTING))
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        compose.onAllNodesWithTag("Captions").assertCountEquals(0)
        compose.onNodeWithContentDescription("Hang up").assertIsDisplayed()
    }

    @Test
    fun anEndedBarOffersTryAgainAndDismissOnly() {
        mount(LiveCallBarModel.Local("Call dropped", "", "", muted = false, speaker = true, phase = LiveCallPhase.ENDED))
        compose.onNodeWithText("Call dropped").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Hang up").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Mute").assertCountEquals(0)
        compose.onAllNodesWithTag("Captions").assertCountEquals(0)
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithContentDescription("Dismiss").performClick()
        assertEquals(listOf("retry", "dismiss"), taps)
    }

    @Test
    fun hangingUpShowsWhatIsHappeningAndNoControls() {
        mount(LiveCallBarModel.Local("Hanging up…", "", "", muted = false, speaker = true, phase = LiveCallPhase.ENDING))
        compose.onNodeWithContentDescription("Live call").assertExists()
        compose.onNodeWithText("Hanging up…").assertIsDisplayed()
        listOf("Hang up", "Mute", "Live call settings", "Dismiss").forEach {
            compose.onAllNodesWithContentDescription(it).assertCountEquals(0)
        }
        compose.onAllNodesWithText("Try again").assertCountEquals(0)
        compose.onAllNodesWithTag("Captions").assertCountEquals(0)
    }

    @Test
    fun anEndThatTryingAgainCannotFixOffersOnlyTheCross() {
        mount(LiveCallBarModel.Local(LiveCallRules.NEEDS_KEY_MESSAGE, "", "", muted = false, speaker = true, phase = LiveCallPhase.ENDED, canRetry = false))
        compose.onNodeWithText(LiveCallRules.NEEDS_KEY_MESSAGE).assertIsDisplayed()
        compose.onAllNodesWithText("Try again").assertCountEquals(0)
        compose.onNodeWithContentDescription("Dismiss").performClick()
        assertEquals(listOf("dismiss"), taps)
    }

    @Test
    @Config(qualifiers = "w320dp-h640dp")
    fun aLongReasonWithoutTryAgainStillWrapsWholeWithTheCrossUnderIt() {
        val busy = LiveCallRules.busyMessage(LiveCallState("c1", "b1", "t1", "desktop", startedAt = 0.0, status = LiveCallStatus.LIVE))
        mountInChat { LiveCallBarModel.Local(busy, "", "", muted = false, speaker = true, phase = LiveCallPhase.ENDED, canRetry = false) }
        assertFalse(layoutOf(busy).multiParagraph.didExceedMaxLines, "cut off: $busy")
        val reason = compose.onNodeWithText(busy).fetchSemanticsNode().boundsInRoot
        val dismiss = compose.onNodeWithContentDescription("Dismiss").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertFalse(dismiss.overlaps(reason), "the cross covers the reason")
        compose.onAllNodesWithText("Try again").assertCountEquals(0)
    }

    @Test
    fun aRemoteBarOnlyHangsUp() {
        mount(LiveCallBarModel.Remote("Live with Ada", "0:09", "From your computer", "c1"))
        compose.onNodeWithContentDescription("Live call on another device").assertExists()
        compose.onNodeWithText("Live with Ada", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(" · 0:09", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("From your computer").assertIsDisplayed()
        compose.onAllNodesWithContentDescription("Mute").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Live call settings").assertCountEquals(0)
        compose.onNodeWithText("Hang up").performClick()
        assertEquals(listOf("hangup"), taps)
    }

    /**
     * A name too long for the line gives way, and only the name: on the
     * narrowest phone in common use the clock, where the call is and every
     * button stay whole, on the remote bar and on this phone's own call.
     */
    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun aLongNameGivesWayToTheClockOnBothBars() {
        val name = "Live with $LONG_NAME"
        var model by mutableStateOf<LiveCallBarModel>(LiveCallBarModel.Remote(name, "12:34", "From your computer", "c1"))
        mountInChat { model }
        assertTheNameGivesWay(name, " · 12:34", before = compose.onNodeWithText("Hang up"))
        val device = compose.onNodeWithText("From your computer", useUnmergedTree = true).assertIsDisplayed()
        val where = layoutOf("From your computer")
        assertFalse(where.multiParagraph.didExceedMaxLines || where.isLineEllipsized(0), "where the call is was cut off")
        val bar = compose.onNodeWithContentDescription("Live call on another device").fetchSemanticsNode().boundsInRoot
        val line = device.fetchSemanticsNode().boundsInRoot
        assertTrue(line.left >= bar.left && line.top >= bar.top && line.right <= bar.right && line.bottom <= bar.bottom, "where the call is sits outside the bar: $line $bar")

        compose.runOnIdle {
            model = LiveCallBarModel.Local(name, "It is noon.", "", muted = false, speaker = true, phase = LiveCallPhase.LIVE, clock = "12:34")
        }
        assertTheNameGivesWay(name, " · 12:34", before = compose.onNodeWithContentDescription("Live call settings"))
        listOf("Live call settings", "Mute", "Hang up").forEach { compose.onNodeWithContentDescription(it).assertIsDisplayed() }
    }

    @Test
    fun hiddenDrawsNothing() {
        mount(LiveCallBarModel.Hidden)
        compose.onAllNodesWithContentDescription("Live call").assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Live call on another device").assertCountEquals(0)
    }

    @Test
    @Config(qualifiers = "w320dp-h640dp")
    fun aLongReasonWrapsWholeWithTryAgainAndTheCrossUnderIt() {
        val busy = "A Live call is already running from your computer. Hang up there first."
        mountInChat { ended(busy) }
        val layout = layoutOf(busy)
        // On one line it read "A Live call is already running …" and never said what to do.
        assertTrue(layout.lineCount in 2..3, "the reason wraps: ${layout.lineCount} line(s)")
        assertFalse(layout.multiParagraph.didExceedMaxLines, "\"Hang up there first.\" was cut off")
        val reason = compose.onNodeWithText(busy).fetchSemanticsNode().boundsInRoot
        val retry = compose.onNodeWithText("Try again").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val dismiss = compose.onNodeWithContentDescription("Dismiss").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue(retry.top >= reason.bottom && dismiss.top >= reason.bottom, "the buttons sit under the reason: $reason $retry $dismiss")
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithContentDescription("Dismiss").performClick()
        assertEquals(listOf("retry", "dismiss"), taps)
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp")
    fun everyReasonTheBarKnowsReadsWholeAt130PercentFont() {
        val busy = listOf("desktop", "ios", "android", "watch").map { client ->
            LiveCallRules.busyMessage(LiveCallState("c1", "b1", "t1", client, startedAt = 0.0, status = LiveCallStatus.LIVE))
        }
        val endings = listOf("idle", "expired", "content", "deleted", "shutdown", "error", null).map { LiveCallRules.endNotice(it).text }
        val reasons = listOf(
            LiveCallRules.NEEDS_KEY_MESSAGE,
            LiveCallRules.MIC_DENIED_MESSAGE,
            LiveCallRules.AUDIO_FAILED_MESSAGE,
            LiveCallRules.AUDIO_TIMEOUT_MESSAGE,
            LiveCallRules.START_FAILED_MESSAGE,
            LiveCallRules.LAST_CALL_ENDING,
            LiveCallRules.FOCUS_LOST_MESSAGE,
            LiveCallRules.SIGNED_OUT_MESSAGE,
        ) + busy + endings
        var reason by mutableStateOf(reasons.first())
        mountInChat(fontScale = 1.3f) { ended(reason) }
        reasons.forEach { text ->
            compose.runOnIdle { reason = text }
            assertFalse(layoutOf(text).multiParagraph.didExceedMaxLines, "cut off at 130 %: $text")
            val shown = compose.onNodeWithText(text).fetchSemanticsNode().boundsInRoot
            listOf(compose.onNodeWithText("Try again"), compose.onNodeWithContentDescription("Dismiss")).forEach { button ->
                val bounds = button.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
                assertFalse(bounds.overlaps(shown), "a button covers \"$text\"")
            }
        }
    }

    @Test
    @Config(qualifiers = "w320dp-h640dp")
    fun atTheLargestFontTheReasonStopsAtThreeLinesAndTheButtonsStayInReach() {
        val reason = LiveCallRules.MIC_DENIED_MESSAGE
        mountInChat(fontScale = 2f) { ended(reason) }
        assertTrue(layoutOf(reason).lineCount <= 3, "the bar grows no further over the chat")
        val shown = compose.onNodeWithText(reason).fetchSemanticsNode().boundsInRoot
        val retry = compose.onNodeWithText("Try again").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val dismiss = compose.onNodeWithContentDescription("Dismiss").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertFalse(retry.overlaps(shown) || dismiss.overlaps(shown), "a button covers the reason")
        compose.onNodeWithText("Try again").performClick()
        compose.onNodeWithContentDescription("Dismiss").performClick()
        assertEquals(listOf("retry", "dismiss"), taps)
    }

    @Test
    @Config(qualifiers = "w320dp-h640dp")
    fun aShortReasonKeepsTryAgainAndTheCrossOnItsLine() {
        mountInChat { ended(LiveCallRules.CALL_ENDED) }
        assertEquals(1, layoutOf(LiveCallRules.CALL_ENDED).lineCount)
        val reason = compose.onNodeWithText(LiveCallRules.CALL_ENDED).fetchSemanticsNode().boundsInRoot
        val retry = compose.onNodeWithText("Try again").fetchSemanticsNode().boundsInRoot
        val dismiss = compose.onNodeWithContentDescription("Dismiss").fetchSemanticsNode().boundsInRoot
        assertTrue(
            listOf(retry, dismiss).all { it.left >= reason.right && it.top < reason.bottom && reason.top < it.bottom },
            "the buttons share the reason's line: $reason $retry $dismiss",
        )
    }

    @Test
    fun aLongCaptionShowsItsNewestWordsOnOneLine() {
        val tail = " then I open the report and read every failure to you, one by one"
        var caption by mutableStateOf("Here is the plan.\nFirst I run the tests,$tail")
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                LiveCallBar(LiveCallBarModel.Local("Live with Ada · 1:05", caption, "", muted = false, speaker = true, phase = LiveCallPhase.LIVE), actions)
            }
        }
        // A line break reads as a space: it would end the line and hide the words after it.
        compose.onNodeWithTag("Captions").assertTextEquals("Here is the plan. First I run the tests,$tail")
        val drawn = captionPixels()
        compose.runOnIdle { caption = "So this is what we will do.\nI run the tests,$tail" }
        assertTrue(drawn.contentEquals(captionPixels()), "only the oldest words changed, and they are the ones off the line")
        compose.runOnIdle { caption = "Here is the plan.\nFirst I run the tests,$tail, twice" }
        assertFalse(drawn.contentEquals(captionPixels()), "the newest words changed, and they are the ones on the line")
    }

    private fun ended(reason: String) =
        LiveCallBarModel.Local(reason, "", "", muted = false, speaker = true, phase = LiveCallPhase.ENDED)

    /** The line's name part is cut short; its clock is whole, and ends before [before], the line's first button. */
    private fun assertTheNameGivesWay(name: String, clock: String, before: SemanticsNodeInteraction) {
        assertTrue(layoutOf(name).isLineEllipsized(0), "the name should give way")
        compose.onNodeWithText(name, useUnmergedTree = true).assertIsDisplayed()
        val shown = compose.onNodeWithText(clock, useUnmergedTree = true).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val clockLayout = layoutOf(clock)
        // It never wraps, so its layout is as wide as its words: drawn whole, the node is too.
        val whole = clockLayout.multiParagraph.intrinsics.maxIntrinsicWidth
        assertTrue(shown.width >= whole - 0.5f, "the clock was cut off: ${shown.width} of $whole px")
        val button = before.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue(shown.right <= button.left, "the clock runs into the button: $shown $button")
    }

    /**
     * The bar as `ChatScreen` places it, full width less 12 dp a side, on the
     * phone the test's qualifiers set up: w320dp is the narrowest Android draws
     * a normal screen at, w360dp the narrowest phone in common use.
     * [fontScale] scales sp linearly, never smaller than a phone's own curve at
     * the same setting.
     */
    private fun mountInChat(fontScale: Float = 1f, model: () -> LiveCallBarModel) {
        compose.setContent {
            val phone = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(phone.density, fontScale)) {
                CompanionTheme(darkTheme = false) {
                    LiveCallBar(model(), actions, Modifier.fillMaxWidth().padding(horizontal = 12.dp))
                }
            }
        }
    }

    /**
     * The layout the reason's text node published. A `Text(String)` rebuilds it
     * on request (see ParagraphDirectionTest); at the same width and with an end
     * ellipsis it breaks the lines where the drawn one does, which is all these
     * tests read. It ignores a start ellipsis, so the caption is read as pixels.
     */
    private fun layoutOf(text: String): TextLayoutResult {
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
        val results = mutableListOf<TextLayoutResult>()
        val action = node.config[SemanticsActions.GetTextLayoutResult].action
        assertTrue(action != null && action(results), "the node produced no text layout")
        return results.first()
    }

    /** The caption line as drawn: the window drawn into a bitmap, cut to the line's bounds. */
    private fun captionPixels(): IntArray {
        val line = compose.onNodeWithTag("Captions").fetchSemanticsNode().boundsInRoot
        return compose.runOnIdle {
            val window = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(window.width, window.height, Bitmap.Config.ARGB_8888)
            window.draw(Canvas(bitmap))
            val root = IntArray(2).also { compose.activity.findViewById<View>(android.R.id.content).getLocationInWindow(it) }
            val width = line.width.roundToInt()
            val height = line.height.roundToInt()
            IntArray(width * height).also { pixels ->
                bitmap.getPixels(pixels, 0, width, root[0] + line.left.roundToInt(), root[1] + line.top.roundToInt(), width, height)
            }
        }
    }

    private companion object {
        /** Forty characters: more than the bar's line holds on a phone. */
        const val LONG_NAME = "Scout, the Quarterly Release Coordinator"
    }
}
