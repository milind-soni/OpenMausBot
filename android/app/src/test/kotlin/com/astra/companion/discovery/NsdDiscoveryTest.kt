package com.astra.companion.discovery

import android.net.nsd.NsdManager
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class NsdDiscoveryTest {
    @Test
    fun startDiscoveryFailedReleasesLockClosesFlowAndIsIdempotent() = runTest {
        val lock = FakeMulticastLock(held = true)
        var captured: NsdManager.DiscoveryListener? = null
        var stopCalls = 0
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { stopCalls++ },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { code -> "failed:$code" },
            ).collect { states += it }
        }
        runCurrent()

        val listener = requireNotNull(captured)
        listener.onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_INTERNAL_ERROR)
        advanceUntilIdle()

        assertFalse(lock.isHeld)
        assertEquals(1, lock.releaseCount)
        assertTrue(collectJob.isCompleted)
        // A listener whose start failed was never registered with NsdManager, so
        // stopping it would throw "listener not registered". Nothing to stop.
        assertEquals(0, stopCalls)

        val last = assertIs<DiscoveryState.Active>(states.last())
        assertFalse(last.browsing)
        assertEquals("failed:${NsdManager.FAILURE_INTERNAL_ERROR}", last.failure)
        assertTrue(last.found.isEmpty())
    }

    // GAP-02: a transient FAILURE_MAX_LIMIT is the Android shape of iOS's defunct
    // DNS-SD connection — the platform is momentarily out of discovery slots, and
    // recreating the browser is the only useful recovery.

    @Test
    fun maxLimitRetriesThreeTimesWithIncrementalBackoffThenGoesTerminal() = runTest {
        val lock = FakeMulticastLock(held = true)
        val listeners = mutableListOf<NsdManager.DiscoveryListener>()
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> listeners += listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { code -> "terminal:$code" },
            ).collect { states += it }
        }
        runCurrent()
        assertEquals(1, listeners.size)

        // Attempt 1 fails: a retry is pending, and the copy says so.
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        runCurrent()
        assertEquals(DiscoveryRetry.RETRYING, assertIs<DiscoveryState.Active>(states.last()).failure)
        assertFalse(collectJob.isCompleted)

        // 350ms, and not a millisecond sooner.
        advanceTimeBy(349)
        runCurrent()
        assertEquals(1, listeners.size, "the retry must wait out its backoff")
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, listeners.size)
        assertNotSame(listeners[0], listeners[1], "a rejected listener must not be reused")

        // Attempt 2 fails: 700ms.
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        runCurrent()
        advanceTimeBy(699)
        runCurrent()
        assertEquals(2, listeners.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(3, listeners.size)

        // Attempt 3 fails: 1050ms.
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        runCurrent()
        advanceTimeBy(1049)
        runCurrent()
        assertEquals(3, listeners.size)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(4, listeners.size)
        assertTrue(lock.isHeld, "the lock is held across restarts, not re-taken")
        assertEquals(0, lock.releaseCount)

        // The fourth failure is past the bound: terminal, with copy that does not
        // promise a retry that is not coming.
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        advanceUntilIdle()

        assertTrue(collectJob.isCompleted)
        assertEquals(4, listeners.size, "the bound is three retries, not four")
        assertFalse(lock.isHeld)
        assertEquals(1, lock.releaseCount)
        val last = assertIs<DiscoveryState.Active>(states.last())
        assertEquals("terminal:${NsdManager.FAILURE_MAX_LIMIT}", last.failure)
        assertFalse(last.browsing)
    }

    @Test
    fun aRetryThatSucceedsClearsTheInterruptedMessage() = runTest {
        val lock = FakeMulticastLock(held = true)
        val listeners = mutableListOf<NsdManager.DiscoveryListener>()
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> listeners += listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { states += it }
        }
        runCurrent()

        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        advanceTimeBy(DiscoveryRetry.BASE_DELAY_MILLIS)
        runCurrent()
        assertEquals(2, listeners.size)

        listeners.last().onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        runCurrent()

        val active = assertIs<DiscoveryState.Active>(states.last())
        assertTrue(active.browsing)
        assertNull(active.failure, "a browse that came back must not still say it was interrupted")
        assertFalse(collectJob.isCompleted)

        collectJob.cancel()
        advanceUntilIdle()
        assertEquals(1, lock.releaseCount)
    }

    @Test
    fun leavingTheScreenDuringBackoffStopsRetryingAndReleasesTheLockOnce() = runTest {
        val lock = FakeMulticastLock(held = true)
        val listeners = mutableListOf<NsdManager.DiscoveryListener>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> listeners += listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { }
        }
        runCurrent()
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_MAX_LIMIT)
        runCurrent()

        // The user leaves mid-backoff.
        collectJob.cancel()
        advanceUntilIdle()

        assertEquals(1, listeners.size, "a retry must not outlive the collector")
        assertFalse(lock.isHeld)
        assertEquals(1, lock.releaseCount)
    }

    @Test
    fun internalErrorIsTerminalWithoutRetrying() = runTest {
        val lock = FakeMulticastLock(held = true)
        val listeners = mutableListOf<NsdManager.DiscoveryListener>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> listeners += listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { "terminal" },
            ).collect { }
        }
        runCurrent()
        listeners.last().onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_INTERNAL_ERROR)
        advanceUntilIdle()

        assertTrue(collectJob.isCompleted)
        assertEquals(1, listeners.size, "an internal error is not worth starting again")
    }

    @Test
    fun securityExceptionOnStartReleasesLockAndClosesFlow() = runTest {
        val lock = FakeMulticastLock(held = true)
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { throw SecurityException("denied") },
                stopBrowse = { error("stop should not run when browse never started") },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { states += it }
        }
        advanceUntilIdle()

        assertFalse(lock.isHeld)
        assertEquals(1, lock.releaseCount)
        assertTrue(collectJob.isCompleted)
        val last = assertIs<DiscoveryState.Active>(states.last())
        assertFalse(last.browsing)
        assertTrue(last.failure!!.contains("Local Network"))
    }

    @Test
    fun successfulBrowseKeepsLockUntilCollectorCancels() = runTest {
        val lock = FakeMulticastLock(held = true)
        var captured: NsdManager.DiscoveryListener? = null
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { states += it }
        }
        runCurrent()
        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        runCurrent()

        assertTrue(lock.isHeld)
        assertEquals(0, lock.releaseCount)
        val active = assertIs<DiscoveryState.Active>(states.last())
        assertTrue(active.browsing)
        assertNull(active.failure)

        collectJob.cancel()
        advanceUntilIdle()
        assertFalse(lock.isHeld)
        assertEquals(1, lock.releaseCount)
    }

    /**
     * A browse that ends — the screen closes, or a start failure goes terminal —
     * has to hand back the resolves it started. On API 34 a resolve is a
     * registration that is otherwise released only when the service is updated,
     * so one left behind outlives the screen by the life of the process.
     */
    @Test
    fun closingTheBrowseStopsTheResolvesStillListening() = runTest {
        val lock = FakeMulticastLock(held = true)
        var captured: NsdManager.DiscoveryListener? = null
        var stopResolveCalls = 0

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { lock },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                stopResolves = { stopResolveCalls += 1 },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { }
        }
        runCurrent()
        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        runCurrent()
        assertEquals(0, stopResolveCalls, "a live browse keeps its resolves")

        collectJob.cancel()
        advanceUntilIdle()

        assertEquals(1, stopResolveCalls, "leaving the screen must release every resolve")
    }

    @Test
    fun aTerminalStartFailureAlsoStopsTheResolves() = runTest {
        var captured: NsdManager.DiscoveryListener? = null
        var stopResolveCalls = 0

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { FakeMulticastLock(held = true) },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { _, _ -> },
                stopResolves = { stopResolveCalls += 1 },
                hostAddress = { null },
                failureMessage = { "terminal" },
            ).collect { }
        }
        runCurrent()
        captured!!.onStartDiscoveryFailed(NsdDiscovery.SERVICE_TYPE, NsdManager.FAILURE_INTERNAL_ERROR)
        advanceUntilIdle()

        assertTrue(collectJob.isCompleted)
        assertEquals(1, stopResolveCalls)
    }

    @Test
    fun productionFactoryPathAcquiresPerCollectionOnly() = runTest {
        // Mirrors discover()'s acquireMulticastLock factory: create+hold only when
        // invoked from inside the cold Flow's collection block.
        val locks = mutableListOf<FakeMulticastLock>()
        var acquireCalls = 0
        val acquireMulticastLock: () -> MulticastLockHandle? = {
            acquireCalls++
            FakeMulticastLock(held = true).also { locks += it }
        }

        var captured: NsdManager.DiscoveryListener? = null
        var browseStarts = 0

        val flow = browseDiscoveryFlow(
            serviceType = NsdDiscovery.SERVICE_TYPE,
            acquireMulticastLock = acquireMulticastLock,
            startBrowse = { listener ->
                browseStarts++
                captured = listener
            },
            stopBrowse = { },
            resolveService = { _, _ -> },
            hostAddress = { null },
            failureMessage = { "unused" },
        )

        // (a) Creating the cold Flow without collecting acquires nothing.
        assertEquals(0, acquireCalls)
        assertTrue(locks.isEmpty())
        assertEquals(0, browseStarts)

        // (b) First collection acquires; terminal close releases exactly once.
        val firstStates = mutableListOf<DiscoveryState>()
        val firstJob = launch { flow.collect { firstStates += it } }
        runCurrent()

        assertEquals(1, acquireCalls)
        assertEquals(1, locks.size)
        assertEquals(1, browseStarts)
        assertTrue(locks[0].isHeld)
        assertEquals(0, locks[0].releaseCount)

        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        runCurrent()
        assertTrue(assertIs<DiscoveryState.Active>(firstStates.last()).browsing)
        assertTrue(locks[0].isHeld)

        firstJob.cancel()
        advanceUntilIdle()
        assertFalse(locks[0].isHeld)
        assertEquals(1, locks[0].releaseCount)

        // (c) Second collection after the first completes gets a fresh held
        // handle; browse runs locked again (screen close → reopen).
        captured = null
        val secondStates = mutableListOf<DiscoveryState>()
        val secondJob = launch { flow.collect { secondStates += it } }
        runCurrent()

        assertEquals(2, acquireCalls)
        assertEquals(2, locks.size)
        assertEquals(2, browseStarts)
        assertNotSame(locks[0], locks[1])
        assertTrue(locks[1].isHeld)
        assertEquals(0, locks[1].releaseCount)
        // Prior collection's lock stays released — no reuse of a dead handle.
        assertFalse(locks[0].isHeld)

        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        runCurrent()
        assertTrue(assertIs<DiscoveryState.Active>(secondStates.last()).browsing)
        assertTrue(locks[1].isHeld)

        secondJob.cancel()
        advanceUntilIdle()
        assertFalse(locks[1].isHeld)
        assertEquals(1, locks[1].releaseCount)
    }
}

class DiscoveryRetryTest {
    @Test
    fun onlyAMomentaryShortageIsWorthStartingAgain() {
        assertTrue(DiscoveryRetry.isRecoverable(NsdManager.FAILURE_MAX_LIMIT))
        assertFalse(DiscoveryRetry.isRecoverable(NsdManager.FAILURE_INTERNAL_ERROR))
        assertFalse(DiscoveryRetry.isRecoverable(NsdManager.FAILURE_ALREADY_ACTIVE))
    }

    @Test
    fun retriesAreBoundedToThree() {
        val code = NsdManager.FAILURE_MAX_LIMIT
        assertTrue(DiscoveryRetry.canRetry(0, code))
        assertTrue(DiscoveryRetry.canRetry(2, code))
        assertFalse(DiscoveryRetry.canRetry(3, code))
        assertFalse(DiscoveryRetry.canRetry(0, NsdManager.FAILURE_INTERNAL_ERROR))
    }

    @Test
    fun theBackoffIsIncremental() {
        // iOS: retryCount * 350ms.
        assertEquals(350L, DiscoveryRetry.delayFor(1))
        assertEquals(700L, DiscoveryRetry.delayFor(2))
        assertEquals(1050L, DiscoveryRetry.delayFor(3))
    }
}

private class FakeMulticastLock(held: Boolean) : MulticastLockHandle {
    private var held = held
    var releaseCount = 0
        private set

    override val isHeld: Boolean
        get() = held

    override fun releaseIfHeld() {
        if (!held) return
        held = false
        releaseCount++
    }
}
