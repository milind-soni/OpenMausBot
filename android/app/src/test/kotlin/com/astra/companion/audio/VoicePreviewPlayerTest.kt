package com.astra.companion.audio

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Screen-owner lifecycle for [VoicePreviewPlayer].
 *
 * The SwiftUI `@State` player dies with the view; Android must stop when the
 * bound [LifecycleOwner] is replaced or destroyed so preview cannot outlive a
 * navigation swap or configuration change.
 */
class VoicePreviewPlayerTest {

    @Test
    fun `replacing the screen owner stops the previous preview`() {
        // Would fail against bind-that-only-swaps-observers: audio kept playing
        // for the new owner without an explicit stop.
        val focus = FakeFocus(grant = true)
        val engines = ArrayDeque<FakeEngine>()
        val controller = VoicePreviewController(
            engineFactory = { FakeEngine(ok = true).also(engines::add) },
            focus = focus,
        )
        val player = VoicePreviewPlayer(
            controller = controller,
            processLifecycle = idleLifecycle(),
        )
        val first = TestOwner()
        val second = TestOwner()
        first.registry.currentState = Lifecycle.State.RESUMED
        player.bind(first)
        assertNull(player.play(byteArrayOf(1, 2, 3)))
        assertTrue(player.playing.value)

        second.registry.currentState = Lifecycle.State.RESUMED
        player.bind(second)

        assertFalse(player.playing.value)
        assertEquals(1, engines.single().stops)
        assertEquals(1, engines.single().releases)
        assertEquals(1, focus.abandons)

        // Unbind of the replaced owner must not double-stop or crash.
        player.unbind(first)
        assertEquals(1, focus.abandons)
    }

    @Test
    fun `unbind of the current owner stops playback`() {
        val focus = FakeFocus(grant = true)
        val engine = FakeEngine(ok = true)
        val controller = VoicePreviewController(
            engineFactory = { engine },
            focus = focus,
        )
        val player = VoicePreviewPlayer(
            controller = controller,
            processLifecycle = idleLifecycle(),
        )
        val owner = TestOwner()
        owner.registry.currentState = Lifecycle.State.RESUMED
        player.bind(owner)
        assertNull(player.play(byteArrayOf(9)))
        player.unbind(owner)
        assertFalse(player.playing.value)
        assertEquals(1, engine.stops)
        assertEquals(1, focus.abandons)
    }

    private class TestOwner : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this)
        override val lifecycle: Lifecycle get() = registry
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

    private class FakeFocus(private val grant: Boolean) : PreviewAudioFocus {
        var requests = 0
        var abandons = 0
        override fun request(onInterrupted: () -> Unit): Boolean {
            requests += 1
            return grant
        }

        override fun abandon() {
            abandons += 1
        }
    }

    private class FakeEngine(private val ok: Boolean) : PreviewAudioEngine {
        override var onCompletion: (() -> Unit)? = null
        override var onError: (() -> Unit)? = null
        var starts = 0
        var stops = 0
        var releases = 0

        override fun start(data: ByteArray): Boolean {
            starts += 1
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
