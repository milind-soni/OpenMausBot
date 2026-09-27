package com.openmausbot.companion.audio

import android.app.Application
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Speaker or earpiece is this phone's own choice, not the computer's: it is
 * kept on the phone across calls and launches, as the iPhone keeps it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveCallPreferencesTest {
    @Test
    fun theSpeakerChoiceIsKeptOnThePhone() {
        val context = RuntimeEnvironment.getApplication() as Application
        val first = SharedLiveCallPreferences(context)
        assertTrue(first.speaker, "the loudspeaker until the person picks otherwise")
        first.speaker = false
        assertFalse(SharedLiveCallPreferences(context).speaker, "a later launch reads the earpiece back")
        first.speaker = true
        assertTrue(SharedLiveCallPreferences(context).speaker)
    }

    /** The first-call disclosure, once Start call was chosen, is this phone's to remember. */
    @Test
    fun theFirstCallDisclosureIsRememberedOnThePhone() {
        val context = RuntimeEnvironment.getApplication() as Application
        val first = SharedLiveCallPreferences(context)
        assertFalse(first.disclosureShown, "a phone that never called shows it first")
        first.disclosureShown = true
        assertTrue(SharedLiveCallPreferences(context).disclosureShown, "a later launch remembers it")
    }
}
