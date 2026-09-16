package com.astra.companion.discovery

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What happens to a resolve that does not answer.
 *
 * Robolectric, because both halves need a real [NsdServiceInfo]: the browse
 * hands one to `onServiceFound`, and the API 34 callback hands one back. The
 * plain JVM stub throws on every setter, so a fake service name is not
 * constructible without the framework.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalCoroutinesApi::class)
class NsdResolveTest {

    private fun service(name: String) = NsdServiceInfo().apply {
        serviceName = name
        serviceType = NsdDiscovery.SERVICE_TYPE
        port = 8810
    }

    @Test
    fun `a refused resolve is tried once more and the computer appears`() = runTest {
        val attempts = mutableListOf<String>()
        var captured: NsdManager.DiscoveryListener? = null
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { null },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { info, onResolved ->
                    attempts += info.serviceName
                    // The platform refuses the first attempt — FAILURE_ALREADY_ACTIVE
                    // is what a browse that found two computers at once produces.
                    if (attempts.size == 1) onResolved(null) else onResolved(info)
                },
                hostAddress = { "192.168.1.42" },
                failureMessage = { "unused" },
            ).collect { states += it }
        }
        runCurrent()
        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        captured!!.onServiceFound(service("astra-aa"))
        runCurrent()

        assertEquals(1, attempts.size)
        assertTrue(
            assertIs<DiscoveryState.Active>(states.last()).found.isEmpty(),
            "a refused resolve has no address to offer yet",
        )

        advanceTimeBy(ResolveRetry.DELAY_MILLIS - 1)
        runCurrent()
        assertEquals(1, attempts.size, "the retry must wait out its backoff")

        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, attempts.size)
        val found = assertIs<DiscoveryState.Active>(states.last()).found
        assertEquals(listOf("astra-aa"), found.map { it.name })
        assertEquals("192.168.1.42", found.single().host)
        assertEquals(8810, found.single().port)

        collectJob.cancel()
        advanceUntilIdle()
    }

    @Test
    fun `a second refusal leaves the computer out and stops trying`() = runTest {
        var attempts = 0
        var captured: NsdManager.DiscoveryListener? = null
        val states = mutableListOf<DiscoveryState>()

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { null },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { _, onResolved ->
                    attempts += 1
                    onResolved(null)
                },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { states += it }
        }
        runCurrent()
        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        captured!!.onServiceFound(service("astra-bb"))
        advanceTimeBy(10_000)
        runCurrent()

        assertEquals(
            ResolveRetry.MAX_ATTEMPTS,
            attempts,
            "a name that will not resolve must not become a retry loop",
        )
        assertTrue(assertIs<DiscoveryState.Active>(states.last()).found.isEmpty())

        collectJob.cancel()
        advanceUntilIdle()
    }

    @Test
    fun `a pending retry does not outlive the collector`() = runTest {
        var attempts = 0
        var captured: NsdManager.DiscoveryListener? = null

        val collectJob = launch {
            browseDiscoveryFlow(
                serviceType = NsdDiscovery.SERVICE_TYPE,
                acquireMulticastLock = { null },
                startBrowse = { listener -> captured = listener },
                stopBrowse = { },
                resolveService = { _, onResolved ->
                    attempts += 1
                    onResolved(null)
                },
                hostAddress = { null },
                failureMessage = { "unused" },
            ).collect { }
        }
        runCurrent()
        captured!!.onDiscoveryStarted(NsdDiscovery.SERVICE_TYPE)
        captured!!.onServiceFound(service("astra-cc"))
        runCurrent()
        assertEquals(1, attempts)

        collectJob.cancel()
        advanceUntilIdle()

        assertEquals(1, attempts, "leaving the screen during the backoff cancels the retry")
    }

    /**
     * The registration side, driven directly. Each terminal outcome has to leave
     * nothing listening, because nothing else ever will: a leaked
     * `registerServiceInfoCallback` lives as long as the process.
     */
    @Test
    fun `an updated service is answered once and released`() {
        val unregistered = mutableListOf<NsdManager.ServiceInfoCallback>()
        val resolver = ServiceInfoResolver(unregister = { unregistered += it })
        val answers = mutableListOf<NsdServiceInfo?>()
        var callback: NsdManager.ServiceInfoCallback? = null

        resolver.resolve(register = { callback = it }, onResolved = { answers += it })
        assertEquals(1, resolver.outstanding)

        val info = service("astra-dd")
        callback!!.onServiceUpdated(info)

        assertSame(info, answers.single())
        assertEquals(listOf(callback), unregistered)
        assertEquals(0, resolver.outstanding)

        // A subscription keeps talking; a resolve is one answer.
        callback!!.onServiceUpdated(service("astra-dd"))
        assertEquals(1, answers.size)
        assertEquals(1, unregistered.size)
    }

    @Test
    fun `a service that goes away before it resolves is released, not left listening`() {
        val unregistered = mutableListOf<NsdManager.ServiceInfoCallback>()
        val resolver = ServiceInfoResolver(unregister = { unregistered += it })
        val answers = mutableListOf<NsdServiceInfo?>()
        var callback: NsdManager.ServiceInfoCallback? = null

        resolver.resolve(register = { callback = it }, onResolved = { answers += it })
        callback!!.onServiceLost()

        assertNull(answers.single())
        assertEquals(listOf(callback), unregistered)
        assertEquals(0, resolver.outstanding)
    }

    @Test
    fun `a registration that never happened is answered but never unregistered`() {
        val unregistered = mutableListOf<NsdManager.ServiceInfoCallback>()
        val resolver = ServiceInfoResolver(unregister = { unregistered += it })
        val answers = mutableListOf<NsdServiceInfo?>()
        var callback: NsdManager.ServiceInfoCallback? = null

        resolver.resolve(register = { callback = it }, onResolved = { answers += it })
        callback!!.onServiceInfoCallbackRegistrationFailed(NsdManager.FAILURE_MAX_LIMIT)

        assertNull(answers.single())
        assertEquals(
            emptyList(),
            unregistered,
            "unregistering a listener the platform never took throws below T extension 22",
        )
        assertEquals(0, resolver.outstanding)

        // A register that throws is the same outcome, reported rather than swallowed.
        val thrower = ServiceInfoResolver(unregister = { unregistered += it })
        val thrown = mutableListOf<NsdServiceInfo?>()
        thrower.resolve(register = { throw SecurityException("denied") }, onResolved = { thrown += it })
        assertNull(thrown.single())
        assertEquals(0, thrower.outstanding)
    }

    @Test
    fun `closing the browse releases the resolves still listening`() {
        val unregistered = mutableListOf<NsdManager.ServiceInfoCallback>()
        val resolver = ServiceInfoResolver(unregister = { unregistered += it })
        val callbacks = mutableListOf<NsdManager.ServiceInfoCallback>()

        repeat(3) { resolver.resolve(register = { callbacks += it }, onResolved = { }) }
        callbacks[0].onServiceUpdated(service("astra-ee"))
        assertEquals(2, resolver.outstanding)

        resolver.stopAll()

        assertEquals(3, unregistered.size, "every registration must be handed back exactly once")
        assertEquals(callbacks.toSet(), unregistered.toSet())
        assertEquals(0, resolver.outstanding)

        // Idempotent: a terminal close plus awaitClose must not double-unregister.
        resolver.stopAll()
        assertEquals(3, unregistered.size)
    }
}
