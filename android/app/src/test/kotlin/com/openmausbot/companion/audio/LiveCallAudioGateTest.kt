package com.openmausbot.companion.audio

import android.app.Application
import android.content.Context
import android.media.AudioManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The players as the app builds them ([com.openmausbot.companion.OpenMausApp]):
 * the shared focus gate itself refuses a voice note or a voice preview while
 * this phone's Live call holds the audio, before anything asks Android for
 * the focus. Whatever reaches the player then (a note whose download
 * finishes after the call started, a preview fetched before it) cannot take
 * the call's audio and end it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveCallAudioGateTest {
    private val context = RuntimeEnvironment.getApplication() as Application
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    @Test
    fun theGateRefusesVoiceNotesAndPreviewsWhileACallHoldsTheAudio() {
        val notes = VoiceNotePlayer(context, idleLifecycle(), liveCallHoldsAudio = { true })
        assertEquals(VoiceNoteController.DURING_LIVE_CALL, notes.play("m1:/attachments/note.mp3", ByteArray(64)))
        assertNull(notes.playback.value)
        assertNull(shadowOf(audioManager).lastAudioFocusRequest, "nothing asked Android for the focus")

        val previews = VoicePreviewPlayer(context, idleLifecycle(), liveCallHoldsAudio = { true })
        assertEquals(VoicePreviewController.DURING_LIVE_CALL, previews.play(ByteArray(64)))
        assertEquals(false, previews.playing.value)
        assertNull(shadowOf(audioManager).lastAudioFocusRequest, "nothing asked Android for the focus")
    }

    private fun idleLifecycle(): Lifecycle {
        val owner = object : LifecycleOwner {
            lateinit var registry: LifecycleRegistry
            override val lifecycle: Lifecycle get() = registry
        }
        val registry = LifecycleRegistry.createUnsafe(owner)
        owner.registry = registry
        registry.currentState = Lifecycle.State.STARTED
        return registry
    }
}
