package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/**
 * Route state — `_connection`, what is on disk, `rotation` and `client` — is one
 * fact, and every writer of it holds `gate`. These pin the two that did not.
 *
 * The window both tests use is real rather than contrived: a connection store
 * *suspends*. `DataStoreConnectionStore.save` hands the write to DataStore's
 * own IO dispatcher, so the coroutine that called it gives up the thread in the
 * middle. `Dispatchers.Main.immediate` — the scope `AstraApp` gives the
 * session — is precisely a dispatcher on which another coroutine then runs.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionRouteSerializationTest {

    private val hosted = assertNotNull(
        CompanionEndpoint.create("https://mac.example", CompanionEndpointKind.HOSTED, 0),
    )
    private val tailnet = assertNotNull(
        CompanionEndpoint.create("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100),
    )

    private fun saved() = Connection(
        id = "hosted",
        name = "Mac",
        host = hosted.host,
        port = hosted.port,
        activeEndpoint = hosted,
        endpoints = listOf(hosted, tailnet),
    )

    /**
     * A promotion writes the route that carried the stream. It used to read
     * `_connection`, write it, and only then suspend in the store with nothing
     * held — so a manual address edit could take the whole of `gate` during that
     * suspension, save its own address, and be overwritten a moment later by the
     * promotion's older save. Memory said one address, the disk said another, and
     * the next launch believed the disk.
     */
    @Test
    fun `an address edit during the promotion save is what the phone comes back on`() = runTest {
        val park = CompletableDeferred<Unit>()
        val store = ParkingConnectionStore(saved(), parkFirstSaveOn = park)
        var opens = 0
        val session = session(
            connectionStore = store,
            events = { _, _ ->
                opens += 1
                if (opens == 1) {
                    flow { throw APIError.Status(522) }
                } else {
                    flow {
                        emit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
                        awaitCancellation()
                    }
                }
            },
        )
        session.awaitRestored()

        session.connect()
        runCurrent()
        advanceTimeBy(1_100)
        runCurrent()

        // The hosted route failed, the walk moved to the tailnet one, the stream
        // came up on it — and the promotion that records that is now parked
        // inside the store.
        assertEquals(1, store.parked, "the promotion never reached the store")
        assertEquals(emptyList(), store.writes, "the parked save must not have landed yet")

        // Someone types a new address while that save is in flight.
        val edit = backgroundScope.launch {
            session.updateAddressAndAwait("http://192.168.1.9:8899")
        }
        runCurrent()

        park.complete(Unit)
        // `advanceUntilIdle` stops as soon as only background events remain, and
        // every coroutine the session owns is in `backgroundScope`. `runCurrent`
        // does run them, so the pump is explicit.
        settle()
        edit.join()
        settle()

        val onDisk = assertNotNull(store.saved).baseUrl.toString()
        assertEquals(
            session.connection.value?.baseUrl?.toString(),
            onDisk,
            "the stored connection and the live one disagree: writes were ${store.writes}",
        )
        assertEquals("http://192.168.1.9:8899", onDisk)
    }

    /**
     * The other half of the same fact. A metadata refresh replaces `rotation`
     * inside `gate`, and suspends in the store first. A stream failure landing in
     * that window used to advance the *old* rotation and rebuild `client` for the
     * route it picked — and then the refresh's next line threw that rotation
     * away. `client` was left dialing one route while `rotation.currentEndpoint`
     * named another, so the promotion that follows writes down the route that did
     * not carry the stream.
     */
    @Test
    fun `a failure during a metadata refresh leaves the walk and the client on the same route`() = runTest {
        val park = CompletableDeferred<Unit>()
        val store = ParkingConnectionStore(saved(), parkFirstSaveOn = park)
        val dialed = mutableListOf<String>()
        var opens = 0
        val session = session(
            connectionStore = store,
            clientFactory = { connection, token ->
                dialed += connection.baseUrl.toString()
                CompanionClient(connection, token)
            },
            // An answering sidecar, so the refresh actually reaches the store.
            metadata = {
                CompanionConnectionMetadata(
                    serverName = "Mac",
                    hosts = emptyList(),
                    endpoints = listOf(hosted, tailnet),
                )
            },
            events = { _, _ ->
                opens += 1
                when (opens) {
                    // Hello, a beat, then a route failure on the same stream. The
                    // beat is what lets the refresh the Hello launched reach the
                    // store — so the failure lands while that save is suspended,
                    // which is the whole window.
                    1 -> flow {
                        emit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
                        kotlinx.coroutines.delay(10)
                        throw APIError.Status(522)
                    }
                    else -> flow {
                        emit(StreamFrame(Frame.Hello(cursor = "s:2", resumed = true), seq = 2))
                        awaitCancellation()
                    }
                }
            },
        )
        session.awaitRestored()

        session.connect()
        runCurrent()
        runCurrent()

        assertEquals(1, store.parked, "the refresh never reached the store: writes=${store.writes}")
        assertEquals(emptyList(), store.writes, "the refresh save must still be in flight")

        // The stream fails while that save is suspended.
        advanceTimeBy(11)
        runCurrent()

        park.complete(Unit)
        settle()
        advanceTimeBy(2_100)
        settle()

        val stored = assertNotNull(store.saved)
        assertEquals(
            dialed.last(),
            stored.activeEndpoint?.url,
            "the stored route is not the one the live client was built for: dialed=$dialed",
        )
    }

    /** Drain everything runnable at the current virtual time, background included. */
    private fun TestScope.settle() = repeat(6) { runCurrent() }

    private fun TestScope.session(
        connectionStore: ConnectionStore,
        events: (String?, Boolean) -> Flow<StreamFrame> = { _, _ -> emptyFlow() },
        clientFactory: (Connection, String?) -> CompanionClient = { connection, token ->
            CompanionClient(connection, token)
        },
        metadata: suspend (CompanionClient) -> CompanionConnectionMetadata = { throw APIError.Status(404) },
    ): Session = Session(
        scope = backgroundScope,
        connectionStore = connectionStore,
        tokenStore = SingleTokenStore("hosted", "device-token"),
        onboardingStore = InMemoryOnboardingStore(),
        deviceNameProvider = { "Pixel" },
        clientFactory = clientFactory,
        eventsFn = { _, since, screens -> events(since, screens) },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        metadataFn = metadata,
    )
}

/**
 * A store whose first write suspends until the test says so.
 *
 * Two properties, both taken from `DataStoreConnectionStore`, which is the store
 * the app actually runs:
 *
 * - **`save` suspends.** DataStore's `edit` moves the write to its own IO
 *   dispatcher, so the calling coroutine gives up the thread in the middle of a
 *   save. That suspension is the window these tests are about.
 * - **Cancelling the caller does not un-write the bytes.** `DataStore.updateData`
 *   hands the transform to an actor of its own and the caller merely waits for
 *   the acknowledgement; a caller that goes away leaves the write to finish. The
 *   park below is therefore [NonCancellable] — a cancellable park would model a
 *   store that rolls its write back when the caller is cancelled, which is not
 *   the store this app has, and would hide the very interleaving under test.
 */
private class ParkingConnectionStore(
    initial: Connection?,
    private val parkFirstSaveOn: CompletableDeferred<Unit>,
) : ConnectionStore {
    var saved: Connection? = initial
    val writes = mutableListOf<String>()
    var parked = 0
        private set
    private var parkedOnce = false

    override suspend fun load(): Connection? = saved

    override suspend fun save(connection: Connection) =
        kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
            if (!parkedOnce) {
                parkedOnce = true
                parked += 1
                parkFirstSaveOn.await()
            }
            saved = connection
            writes += connection.baseUrl.toString()
            Unit
        }

    override suspend fun clear() {
        saved = null
        writes += "<cleared>"
    }
}

private class SingleTokenStore(connectionId: String, token: String) : TokenStore {
    private val values = mutableMapOf(connectionId to token)
    override suspend fun save(connectionId: String, token: String) {
        values[connectionId] = token
    }
    override suspend fun read(connectionId: String): TokenStore.ReadResult =
        values[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing
    override suspend fun remove(connectionId: String) {
        values.remove(connectionId)
    }
}
