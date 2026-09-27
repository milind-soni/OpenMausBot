package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.openmausbot.companion.core.LiveSettings
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The gear's sheet: every row writes exactly the one field it owns, the key
 * is never on offer, and the sheet says in plain words what a Live call sends
 * to OpenAI and what turning off typed replies keeps back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiveCallSettingsFormTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val changes = mutableListOf<String>()

    private fun mount(settings: LiveSettings?, speaker: Boolean = true) {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                LiveCallSettingsForm(
                    settings = settings,
                    speaker = speaker,
                    saving = false,
                    error = null,
                    onDone = { changes += "done" },
                    onVoice = { changes += "voice:$it" },
                    onSpeaker = { changes += "speaker:$it" },
                    onReadTypedReplies = { changes += "typed:$it" },
                    onIdleMinutes = { changes += "idle:$it" },
                )
            }
        }
    }

    @Test
    fun everyRowWritesTheOneFieldItOwns() {
        mount(LiveSettings(configured = true, voice = "marin", readTypedReplies = true, idleMinutes = 5))
        compose.onNodeWithText("Earpiece").performScrollTo().performClick()
        compose.onNodeWithText("Cedar").performScrollTo().performClick()
        compose.onNodeWithText("Read replies to typed messages").performScrollTo().performClick()
        compose.onNodeWithText("10 minutes").performScrollTo().performClick()
        assertEquals(listOf("speaker:false", "voice:cedar", "typed:false", "idle:10"), changes)
    }

    @Test
    fun theSheetSaysWhatReachesOpenAIAndAnOddIdleValueStaysSelectable() {
        mount(LiveSettings(configured = true, voice = "", readTypedReplies = false, idleMinutes = 7))
        // Before any choice: what a call sends, and that the key stays on the computer.
        compose.onNodeWithText(LiveCallRules.DISCLOSURE).assertIsDisplayed()
        compose.onNodeWithText(LiveCallRules.TYPED_REPLIES_FOOTER).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("7 minutes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("3 minutes").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(LiveCallRules.VOICE_APPLIES_NEXT_CALL).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Done").performClick()
        assertEquals(listOf("done"), changes)
    }

    @Test
    fun theDisclosureNamesEverythingACallSendsAndWhereTheKeyStays() {
        val text = LiveCallRules.DISCLOSURE
        listOf("voice", "recent messages", "the bot's answers", "details of any approval", "OpenAI", "key stays on your computer")
            .forEach { assertTrue(it in text, "the disclosure leaves out \"$it\": $text") }
        assertTrue("OpenAI" in LiveCallRules.TYPED_REPLIES_FOOTER)
    }

    /** The route rule (`LiveCallAudioRouting`) gives a connected headset the call whatever is picked here. */
    @Test
    fun soundOutputShowsThisPhonesChoiceAndSaysAHeadsetTakesTheCall() {
        mount(LiveSettings(configured = true), speaker = false)
        compose.onNodeWithText("Earpiece").performScrollTo().assertIsSelected()
        compose.onNodeWithText("Speaker").assertIsNotSelected()
        compose.onNodeWithText("A connected headset takes the call instead.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun nothingIsOfferedBeforeTheSettingsLoad() {
        mount(null)
        compose.onNodeWithText("Loading…").assertIsDisplayed()
        compose.onAllNodesWithText("Cedar").assertCountEquals(0)
    }
}
