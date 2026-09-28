package com.openmausbot.companion.ui

import androidx.compose.material3.Text
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.openmausbot.companion.core.ConfigFlag
import com.openmausbot.companion.core.ConfigStatus
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Which sentence the Voice section puts in which slot, read off the mounted
 * composition in the order the composition built it.
 *
 * This is the one thing about [VoiceSection] no pure function can answer. The
 * rules were already right and pinned when the screen drew a correct sentence
 * in the wrong place: two public `(ConfigStatus?) -> String` selectors were
 * interchangeable to the compiler, and swapping them left the suite green
 * while the user read *"ElevenLabs is not configured"* as the footer of a
 * working voice picker.
 *
 * The order matters, and asserting presence does not capture it. An earlier
 * version of this file asked only that both sentences exist somewhere in the
 * tree, which a *mutual* swap survives untouched — footer and notice trade
 * places, both strings stay present, and the user reads the state where the
 * explanation belongs and the explanation where the state belongs. So each
 * case pins the whole sequence, the way [TableReadingOrderTest] pins the
 * table: `FormSection` emits its header, then its content, then its footer
 * (`AgentProfileSheet`), so a slot swap moves a sentence in this list and the
 * comparison fails on position rather than on existence.
 *
 * Known limit, measured rather than assumed: this reads the order of the
 * text in the tree, not which parameter of `FormSection` carried it. Passing
 * `footer = null` and emitting the same sentence as the content's last child
 * — duplicating the footer's `13.sp` and `secondaryTint` by hand — keeps this
 * sequence identical and survives. That is a deliberate reimplementation of a
 * component that already has a `footer` parameter rather than a slip anyone
 * makes, so it is left open knowingly; the swap of two arguments, which is
 * the regression that does happen, is what these assertions kill.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VoiceSectionWiringTest {

    @get:Rule
    val compose = createComposeRule()

    /** Stands in for the picker, so "the section can speak" is observable. */
    private val pickerSlot = "voice-picker-slot"

    private val elevenLabsNotice = "ElevenLabs is not configured"
    private val elevenLabsFooter =
        "Add the shared ElevenLabs key in this agent's profile on the computer. " +
            "The key is never returned to this phone."
    private val readyFooter =
        "The voice choice belongs to this agent. Workspace default uses the shared voice " +
            "selected on your computer."
    private val systemNotice = "Your computer's built-in voices are unavailable"
    private val systemFooter =
        "Your computer's built-in voices need no key, and it reports none it can use. " +
            "Switch the voice engine in OpenMausBot on the computer to turn speech back on."
    private val chatterboxNotice = "The Chatterbox server is not connected"
    private val chatterboxFooter =
        "Add the address of your Chatterbox server in OpenMausBot on the computer to turn " +
            "speech back on."

    /**
     * The engine picker rides above the branch, so its label leads every
     * sequence. The collapsed field reports no text for the selected engine;
     * the row is there, and which engine it holds is the picker's business.
     */
    private val engine = listOf("Voice engine")

    /** Everything the merged tree carries, in the order the tree carries it. */
    private fun spoken(node: SemanticsNode): List<String> = buildList {
        node.config.getOrNull(SemanticsProperties.Text)?.forEach { add(it.text) }
        node.children.forEach { addAll(spoken(it)) }
    }

    private fun sectionFor(config: ConfigStatus?): List<String> {
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                VoiceSection(config = config) { Text(pickerSlot) }
            }
        }
        return spoken(compose.onRoot().fetchSemanticsNode())
    }

    @Test
    fun `the unconfigured section states the engine, then explains the remedy`() {
        assertEquals(
            listOf("VOICE") + engine + listOf(elevenLabsNotice, elevenLabsFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = false))),
            "the short state stands in for the picker; the remedy is the footer under it",
        )
    }

    @Test
    fun `a section that can speak draws the picker under the ready footer`() {
        assertEquals(
            listOf("VOICE") + engine + listOf(pickerSlot, readyFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = true, voice = "shared-voice"))),
        )
    }

    @Test
    fun `the built-in provider's section names no brand in either slot`() {
        val drawn = sectionFor(ConfigStatus(tts = ConfigFlag(configured = false, provider = "system")))

        assertEquals(listOf("VOICE") + engine + listOf(systemNotice, systemFooter), drawn)
        drawn.forEach { line ->
            assertEquals(false, line.contains("ElevenLabs"), "no brand reaches the screen: $line")
        }
    }

    @Test
    fun `the built-in provider keeps the picker and the shared footer when it can speak`() {
        assertEquals(
            listOf("VOICE") + engine + listOf(pickerSlot, readyFooter),
            sectionFor(
                ConfigStatus(tts = ConfigFlag(configured = true, voice = "Albert", provider = "system")),
            ),
        )
    }

    @Test
    fun `the chatterbox section offers the switch that repairs it`() {
        assertEquals(
            listOf("VOICE") + engine + listOf(chatterboxNotice, chatterboxFooter),
            sectionFor(ConfigStatus(tts = ConfigFlag(configured = false, provider = "chatterbox"))),
            "an engine whose credential is missing is exactly when switching engines matters",
        )
    }
}
