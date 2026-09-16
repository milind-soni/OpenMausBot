package com.astra.companion.audio

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

/**
 * Preview lifecycle pinned to `ios/App/AgentProfileView.previewVoice` plus the
 * Android stops required by PORT13: replace, screen destroy, app background,
 * focus interruption, concurrent play serialization, and async error surfacing.
 *
 * Expectations come from the Swift failure copy and the work order — not from
 * inspecting [VoicePreviewController] to decide what to assert.
 */
class VoicePreviewControllerTest {

    @Test
    fun `successful play becomes playing and grants focus`() {
        val focus = FakeFocus(grant = true)
        val engines = ArrayDeque<FakeEngine>()
        val controller = VoicePreviewController(
            engineFactory = { FakeEngine(ok = true).also(engines::add) },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1, 2, 3)))
        assertTrue(controller.playing.value)
        assertEquals(1, focus.requests)
        assertEquals(1, engines.single().starts)
    }

    @Test
    fun `engine failure surfaces the iOS action-error copy`() {
        val focus = FakeFocus(grant = true)
        val controller = VoicePreviewController(
            engineFactory = { FakeEngine(ok = false) },
            focus = focus,
        )
        assertEquals(
            "The generated audio could not be played.",
            controller.play(byteArrayOf(9)),
        )
        assertFalse(controller.playing.value)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `denied audio focus fails with the same copy`() {
        val focus = FakeFocus(grant = false)
        var engines = 0
        val controller = VoicePreviewController(
            engineFactory = {
                engines += 1
                FakeEngine(ok = true)
            },
            focus = focus,
        )
        assertEquals(VoicePreviewController.PLAYBACK_ERROR, controller.play(byteArrayOf(1)))
        assertEquals(0, engines)
        assertFalse(controller.playing.value)
        // request failed immediately; abandon is still called to clear the attempt.
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `a second play releases the first engine before starting the next`() {
        val focus = FakeFocus(grant = true)
        val engines = ArrayDeque<FakeEngine>()
        val controller = VoicePreviewController(
            engineFactory = { FakeEngine(ok = true).also(engines::add) },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        val first = engines.first()
        assertNull(controller.play(byteArrayOf(2)))
        assertEquals(2, engines.size)
        assertEquals(1, first.stops)
        assertEquals(1, first.releases)
        assertTrue(controller.playing.value)
        assertEquals(1, engines.last().starts)
        // stop abandons, then the replacement requests again.
        assertEquals(2, focus.requests)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `screen destroy stops playback and abandons focus`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        controller.onScreenDestroyed()
        assertFalse(controller.playing.value)
        assertEquals(1, engine.stops)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `app background stops playback and abandons focus`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        controller.onAppBackgrounded()
        assertFalse(controller.playing.value)
        assertEquals(1, engine.stops)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `completion callback returns to idle`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        engine.onCompletion?.invoke()
        assertFalse(controller.playing.value)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `focus interruption stops playback and abandons without resurrecting`() {
        // Would fail against MAY_DUCK + empty listener: interruption was ignored.
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        assertTrue(controller.playing.value)
        val interrupted = checkNotNull(focus.lastOnInterrupted) {
            "request must register an interruption callback"
        }
        interrupted.invoke()
        assertFalse(controller.playing.value)
        assertEquals(1, engine.stops)
        assertEquals(1, engine.releases)
        assertEquals(1, focus.abandons)
        // A stale completion from the interrupted engine must not restart state.
        engine.onCompletion?.invoke()
        assertFalse(controller.playing.value)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `async engine error emits the iOS action-error copy`() = runTest {
        // Would fail when onError was wired to onCompletion: playing went idle
        // with no error the UI could turn into session.actionError.
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        assertNull(controller.play(byteArrayOf(1)))
        val errors = mutableListOf<String>()
        val collector = launch { controller.playbackErrors.collect { errors.add(it) } }
        testScheduler.runCurrent()
        engine.onError?.invoke()
        testScheduler.runCurrent()
        assertEquals(
            listOf("The generated audio could not be played."),
            errors,
        )
        assertFalse(controller.playing.value)
        assertEquals(1, focus.abandons)
        collector.cancel()
    }

    @Test
    fun `error delivered inside start is not lost before callbacks were installed`() = runTest {
        // Would fail against round-2: callbacks were assigned AFTER start(), so an
        // immediate engine error invoked a still-null onError and was dropped.
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true, errorDuringStart = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        val errors = mutableListOf<String>()
        val collector = launch { controller.playbackErrors.collect { errors.add(it) } }
        testScheduler.runCurrent()
        assertNull(controller.play(byteArrayOf(1)))
        testScheduler.runCurrent()
        assertEquals(
            listOf("The generated audio could not be played."),
            errors,
        )
        assertFalse(controller.playing.value)
        assertEquals(1, engine.releases)
        assertTrue(focus.abandons >= 1)
        collector.cancel()
    }

    @Test
    fun `concurrent play calls leave only one live engine`() {
        // Without a lock, overlapping play() bodies can both start() before
        // either assigns `engine`, orphaning a MediaPlayer. Under the lock the
        // calls serialize: N engines created, exactly one left unrealeased.
        val focus = FakeFocus(grant = true)
        val engines = Collections.synchronizedList(mutableListOf<FakeEngine>())
        val controller = VoicePreviewController(
            engineFactory = { FakeEngine(ok = true).also(engines::add) },
            focus = focus,
        )
        val threads = 16
        val done = CountDownLatch(threads)
        repeat(threads) { index ->
            Thread {
                controller.play(byteArrayOf(index.toByte()))
                done.countDown()
            }.start()
        }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals(threads, engines.size)
        assertEquals(
            1,
            engines.count { it.releases == 0 },
            "exactly one engine must remain live",
        )
        assertEquals(threads - 1, engines.count { it.releases == 1 })
        assertTrue(controller.playing.value)
    }

    private class FakeFocus(private val grant: Boolean) : PreviewAudioFocus {
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
        private val errorDuringStart: Boolean = false,
    ) : PreviewAudioEngine {
        override var onCompletion: (() -> Unit)? = null
        override var onError: (() -> Unit)? = null
        var starts = 0
        var stops = 0
        var releases = 0

        override fun start(data: ByteArray): Boolean {
            starts += 1
            if (errorDuringStart) {
                // Fire before returning — same window MediaPlayer can deliver
                // when callbacks are installed before start().
                onError?.invoke()
                    ?: error("onError must be installed before start(); round-2 dropped this")
            }
            return ok
        }

        override fun stop() {
            stops += 1
        }

        override fun release() {
            releases += 1
        }
    }
}
