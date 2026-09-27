package com.openmausbot.companion.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/**
 * Why a hang-up during "Connecting…" cannot reach a disposed peer: the WebRTC
 * transport waits on its native callbacks through this guard, and a close
 * fails the wait. The transport itself needs the native library, so the rules
 * are pinned here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TransportCloseGuardTest {
    @Test
    fun `a wait in progress fails when the transport closes`() = runTest {
        val guard = TransportCloseGuard()
        val callback = CompletableDeferred<String>()
        val waiter = async { runCatching { guard.await(callback) } }
        runCurrent()

        assertTrue(guard.close())
        guard.failPending()
        runCurrent()
        assertEquals(TransportCloseGuard.CLOSED, waiter.await().exceptionOrNull()?.message)
        // The disposed peer's observer firing afterwards is a no-op, not a second resume.
        assertFalse(callback.complete("late"))
    }

    @Test
    fun `a callback that landed just before the close still fails the wait`() = runTest {
        val guard = TransportCloseGuard()
        val callback = CompletableDeferred<String>()
        val waiter = async { runCatching { guard.await(callback) } }
        runCurrent()

        // The WebRTC thread delivers; the main thread closes before the waiter resumes.
        callback.complete("v=0")
        guard.close()
        guard.failPending()
        runCurrent()
        assertEquals(TransportCloseGuard.CLOSED, waiter.await().exceptionOrNull()?.message)
    }

    @Test
    fun `nothing native starts once the transport is closed`() = runTest {
        val guard = TransportCloseGuard()
        guard.close()
        var started = false
        val failure = runCatching { guard.await(CompletableDeferred<Unit>()) { started = true } }.exceptionOrNull()
        assertEquals(TransportCloseGuard.CLOSED, failure?.message)
        assertFalse(started)
        assertFailsWith<IllegalStateException> { guard.ensureOpen() }
        assertFalse(guard.close(), "a second close is a no-op")
    }

    @Test
    fun `an open transport's wait returns the callback's value`() = runTest {
        val guard = TransportCloseGuard()
        val callback = CompletableDeferred<String>()
        assertEquals("v=0", guard.await(callback) { callback.complete("v=0") })
        assertFalse(guard.isClosed)
        guard.close()
        guard.failPending() // nothing is waiting: nothing happens
        assertTrue(guard.isClosed)
    }
}
