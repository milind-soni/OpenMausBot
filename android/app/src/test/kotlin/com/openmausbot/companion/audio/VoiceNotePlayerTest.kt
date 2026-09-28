package com.openmausbot.companion.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

/**
 * Voice-note lifecycle pinned to the desktop VoiceNoteBubble contract: the
 * one-voice rule, pause-in-place with resume, seek, completion parking the
 * clip at its end, focus loss and app background pausing rather than
 * stopping, and failure surfacing the retry copy.
 */
class VoiceNotePlayerTest {

    @Test
    fun `play publishes playing with the engine's measured duration`() {
        val focus = FakeFocus(grant = true)
        val controller = VoiceNoteController(
            engineFactory = { FakeEngine(ok = true, duration = 4000L) },
            focus = focus,
        )

        assertNull(controller.play("m1:/attachments/note.mp3", byteArrayOf(1, 2, 3)))

        val state = controller.playback.value
        assertTrue(state != null && state.playing)
        assertEquals("m1:/attachments/note.mp3", state.key)
        assertEquals(0L, state.positionMs)
        assertEquals(4000L, state.durationMs)
        assertEquals(1, focus.requests)
        assertEquals(0, focus.abandons)
    }

    @Test
    fun `starting a second note releases the first and takes the voice`() {
        val focus = FakeFocus(grant = true)
        val engines = ArrayDeque<FakeEngine>()
        val controller = VoiceNoteController(
            engineFactory = { FakeEngine(ok = true).also(engines::add) },
            focus = focus,
        )

        assertNull(controller.play("a", byteArrayOf(1)))
        val first = engines.first()
        assertNull(controller.play("b", byteArrayOf(2)))

        assertEquals(2, engines.size)
        assertEquals(1, first.stops)
        assertEquals(1, first.releases)
        assertEquals("b", controller.playback.value?.key)
        assertTrue(controller.playback.value?.playing == true)
        assertEquals(2, focus.requests)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `pause keeps the position and gives back the voice`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.reportedPositionMs = 1200L
        controller.pause()

        val state = controller.playback.value
        assertTrue(state != null && !state.playing)
        assertEquals(1200L, state.positionMs)
        assertEquals(1, engine.pauses)
        assertEquals(0, engine.releases)
        assertEquals(1, focus.abandons)
        assertTrue(controller.resumable("a"))
    }

    @Test
    fun `resume re-claims focus and continues in place`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.reportedPositionMs = 1500L
        controller.pause()
        assertNull(controller.resume())

        assertTrue(controller.playback.value?.playing == true)
        assertEquals(1500L, controller.playback.value?.positionMs)
        assertEquals(1, engine.resumes)
        assertEquals(2, focus.requests)
    }

    @Test
    fun `denied focus on resume leaves the note paused`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        controller.pause()
        focus.grant = false

        assertEquals(VoiceNoteController.PLAYBACK_ERROR, controller.resume())
        assertTrue(controller.playback.value?.playing == false)
        assertEquals(0, engine.resumes)
        assertEquals(0, engine.releases)
    }

    @Test
    fun `seek works while paused and playing, clamped to the clip`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true, duration = 4000L)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        controller.seek("a", 1500L)
        assertEquals(1500L, controller.playback.value?.positionMs)
        assertEquals(1, engine.seeks)

        controller.pause()
        controller.seek("a", 999_999L)
        assertEquals(3999L, controller.playback.value?.positionMs)

        // A seek for another row's note never touches this engine.
        controller.seek("other", 10L)
        assertEquals(3999L, controller.playback.value?.positionMs)
        assertEquals(2, engine.seeks)
    }

    @Test
    fun `refresh pulls the engine position only while playing`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true, duration = 4000L)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.reportedPositionMs = 2000L
        controller.refresh()
        assertEquals(2000L, controller.playback.value?.positionMs)

        controller.pause()
        engine.reportedPositionMs = 3000L
        controller.refresh()
        assertEquals(2000L, controller.playback.value?.positionMs)
    }

    @Test
    fun `completion parks the clip at its end without dropping it`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true, duration = 4000L)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.onCompletion?.invoke()

        val state = controller.playback.value
        assertTrue(state != null && !state.playing)
        assertEquals(4000L, state.positionMs)
        assertEquals(1, engine.stops)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
        assertFalse(controller.resumable("a"))

        // Playing again restarts from the beginning, like an ended audio element.
        assertNull(controller.play("a", byteArrayOf(1)))
        assertEquals(0L, controller.playback.value?.positionMs)
    }

    @Test
    fun `focus loss pauses the note instead of stopping it`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.reportedPositionMs = 900L
        focus.lastOnInterrupted?.invoke()

        val state = controller.playback.value
        assertTrue(state != null && !state.playing)
        assertEquals(900L, state.positionMs)
        assertEquals(1, engine.pauses)
        assertEquals(0, engine.releases)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `synchronous engine failure returns the error copy`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = false)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertEquals(VoiceNoteController.PLAYBACK_ERROR, controller.play("a", byteArrayOf(1)))
        assertNull(controller.playback.value)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `denied focus fails before creating an engine`() {
        val focus = FakeFocus(grant = false)
        var engines = 0
        val controller = VoiceNoteController(
            engineFactory = {
                engines += 1
                FakeEngine(ok = true)
            },
            focus = focus,
        )

        assertEquals(VoiceNoteController.PLAYBACK_ERROR, controller.play("a", byteArrayOf(1)))
        assertEquals(0, engines)
        assertNull(controller.playback.value)
        // The refused request is still cleared.
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `asynchronous engine error emits the failing key and parks idle`() = runTest {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)
        val errors = mutableListOf<VoiceNotePlaybackError>()
        val collector = launch { controller.playbackErrors.collect { errors += it } }
        testScheduler.runCurrent()

        assertNull(controller.play("a", byteArrayOf(1)))
        engine.onError?.invoke()
        testScheduler.runCurrent()

        assertEquals(listOf(VoiceNotePlaybackError("a")), errors)
        assertNull(controller.playback.value)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
        collector.cancel()
    }

    @Test
    fun `app background pauses the note in place`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoiceNoteController(engineFactory = { engine }, focus = focus)

        assertNull(controller.play("a", byteArrayOf(1)))
        controller.onAppBackgrounded()

        assertTrue(controller.playback.value?.playing == false)
        assertEquals(1, engine.pauses)
        assertEquals(0, engine.releases)
        assertEquals(1, focus.abandons)
    }

    private class FakeFocus(var grant: Boolean) : PreviewAudioFocus {
        var requests = 0
        var abandons = 0
        var lastOnInterrupted: (() -> Unit)? = null

        override fun request(onInterrupted: () -> Unit): Boolean {
            requests += 1
            lastOnInterrupted = onInterrupted
            return grant
        }

        override fun abandon() {
            abandons += 1
        }
    }

    private class FakeEngine(
        private val ok: Boolean,
        private val duration: Long = 4000L,
    ) : VoiceNoteEngine {
        override var onCompletion: (() -> Unit)? = null
        override var onError: (() -> Unit)? = null
        var starts = 0
        var pauses = 0
        var resumes = 0
        var seeks = 0
        var stops = 0
        var releases = 0
        var reportedPositionMs = 0L

        override fun start(data: ByteArray, startPositionMs: Long): Boolean {
            starts += 1
            reportedPositionMs = startPositionMs
            return ok
        }

        override fun pause() {
            pauses += 1
        }

        override fun resume() {
            resumes += 1
        }

        override fun seekTo(positionMs: Long) {
            seeks += 1
            reportedPositionMs = positionMs
        }

        override fun positionMs(): Long = reportedPositionMs

        override fun durationMs(): Long = duration

        override fun stop() {
            stops += 1
        }

        override fun release() {
            releases += 1
        }
    }
}

