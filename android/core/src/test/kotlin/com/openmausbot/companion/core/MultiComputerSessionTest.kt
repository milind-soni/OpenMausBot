package com.openmausbot.companion.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

@OptIn(ExperimentalCoroutinesApi::class)
class MultiComputerSessionTest {
    private val air = Connection(id = "air", name = "MacBook Air", host = "air.local", port = 8810)
    private val pro = Connection(id = "pro", name = "MacBook Pro", host = "pro.local", port = 8810)

    @Test
    fun switchAndRemovalKeepTokensAndRoutesIsolatedByConnectionId() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val dialed = mutableListOf<Pair<String, String?>>()
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, token ->
                dialed += connection.id to token
                CompanionClient(connection, token)
            },
            eventsFn = { _, _, _ -> emptyFlow() },
        )

        session.awaitRestored()
        assertEquals(air, session.connection.value)

        session.switchComputer(pro.id)
        runCurrent()
        assertEquals(pro, session.connection.value)
        assertEquals(pro.id, connections.registry.activeConnectionId)
        assertEquals("air-token", tokens.tokens[air.id])
        assertEquals("pro-token", tokens.tokens[pro.id])
        assertEquals(pro.id to "pro-token", dialed.last())

        session.forgetConnection(pro.id)
        runCurrent()
        assertEquals(air, session.connection.value)
        assertEquals(listOf(air), connections.registry.connections)
        assertNull(tokens.tokens[pro.id])
        assertEquals("air-token", tokens.tokens[air.id])
    }

    @Test
    fun shareClientForAnotherComputerDoesNotSwitchTheLiveSession() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, _ -> CompanionClient(connection, "token") },
            eventsFn = { _, _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        val dialed = session.withPairedShareClient(pro.id) { it.connection.id }
        assertEquals(pro.id, dialed)
        assertEquals(air, session.connection.value)
        assertEquals(air.id, connections.registry.activeConnectionId)
    }

    @Test
    fun aRejectedShareOnAnotherComputerLeavesThisSessionsStatusAlone() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, _ -> CompanionClient(connection, "token") },
            eventsFn = { _, _, _ -> emptyFlow() },
        )
        session.awaitRestored()
        // A conflated StateFlow can hide a value the assertion below would miss.
        val seen = mutableListOf<Session.Status>()
        backgroundScope.launch { session.status.collect(seen::add) }
        runCurrent()

        var attempts = 0
        val refusal = assertFailsWith<APIError.Status> {
            session.withPairedShareClient(pro.id) {
                attempts += 1
                throw APIError.Status(401)
            }
        }

        assertEquals(401, refusal.code)
        // 401 is not a gateway failure, so no second route is dialed for it.
        assertEquals(1, attempts)
        assertNotEquals(Session.Status.Unauthorized, session.status.value)
        assertFalse(
            seen.contains(Session.Status.Unauthorized),
            "a 401 from the other computer's pairing must not unauthorize the one on screen",
        )
        assertEquals(air, session.connection.value)
        assertEquals(air.id, connections.registry.activeConnectionId)
    }

    @Test
    fun removingTheActiveComputerRestoresTheRemainingOne() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val streamOpens = mutableListOf<String>()
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, _ -> CompanionClient(connection, "token") },
            eventsFn = { client, _, _ ->
                streamOpens += client.connection.id
                flow { awaitCancellation() }
            },
        )
        session.awaitRestored()
        session.connect()
        runCurrent()
        assertTrue(streamOpens.contains(air.id), "restore must open the active computer's stream")
        val opensBeforeSignOut = streamOpens.size

        session.signOutAndAwait()
        runCurrent()
        assertEquals(pro, session.connection.value)
        assertEquals(listOf(pro), connections.registry.connections)
        assertNull(tokens.tokens[air.id])
        assertEquals("pro-token", tokens.tokens[pro.id])
        assertTrue(
            streamOpens.drop(opensBeforeSignOut).contains(pro.id),
            "signOut must call connect() so the remaining computer's stream reopens",
        )
        assertEquals(pro.id, streamOpens.last())
    }

    @Test
    fun share401AfterSwitchDoesNotUnauthorizeTheNewActiveComputer() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, _ -> CompanionClient(connection, "token") },
            eventsFn = { _, _, _ -> flow { awaitCancellation() } },
        )
        session.awaitRestored()

        val seen = mutableListOf<Session.Status>()
        backgroundScope.launch { session.status.collect(seen::add) }
        runCurrent()

        val testScope = this
        assertFailsWith<APIError.Status> {
            session.withPairedShareClient(air.id) {
                // Switch away while the share HTTP call is still in flight.
                session.switchComputer(pro.id)
                testScope.runCurrent()
                assertEquals(pro, session.connection.value)
                throw APIError.Status(401)
            }
        }
        assertNotEquals(Session.Status.Unauthorized, session.status.value)
        assertFalse(seen.contains(Session.Status.Unauthorized))
        assertEquals(pro, session.connection.value)
        assertEquals(pro.id, connections.registry.activeConnectionId)
    }

    @Test
    fun share401OnTheActiveComputerMarksUnauthorized() = runTest {
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, _ -> CompanionClient(connection, "token") },
            eventsFn = { _, _, _ -> flow { awaitCancellation() } },
        )
        session.awaitRestored()

        assertFailsWith<APIError.Status> {
            session.withPairedShareClient(air.id) { throw APIError.Status(401) }
        }
        assertEquals(Session.Status.Unauthorized, session.status.value)
        assertEquals(air, session.connection.value)
    }

    @Test
    fun perform401AfterSwitchDoesNotUnauthorizeTheNewActiveComputer() = runTest {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val parkOnce = AtomicBoolean(true)
        val http = parkingUnauthorizedClient(started, release, parkOnce)
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, token -> CompanionClient(connection, token, http) },
            eventsFn = { _, _, _ -> flow { awaitCancellation() } },
        )
        session.awaitRestored()

        val seen = mutableListOf<Session.Status>()
        backgroundScope.launch { session.status.collect(seen::add) }
        runCurrent()

        val action = async { session.interrupt(sampleBot) }
        assertTrue(withContext(Dispatchers.IO) { started.await(5, TimeUnit.SECONDS) })
        session.switchComputer(pro.id)
        runCurrent()
        assertEquals(pro, session.connection.value)
        release.countDown()
        action.await()

        assertNotEquals(Session.Status.Unauthorized, session.status.value)
        assertFalse(seen.contains(Session.Status.Unauthorized))
        assertEquals(pro, session.connection.value)
        assertEquals(pro.id, connections.registry.activeConnectionId)
    }

    @Test
    fun perform401OnTheActiveComputerMarksUnauthorized() = runTest {
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            unauthorizedResponse(chain.request())
        }.build()
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, token -> CompanionClient(connection, token, http) },
            eventsFn = { _, _, _ -> flow { awaitCancellation() } },
        )
        session.awaitRestored()

        session.interrupt(sampleBot)

        assertEquals(Session.Status.Unauthorized, session.status.value)
        assertEquals(air, session.connection.value)
    }

    @Test
    fun aDownloadThatCompletesDuringAComputerSwitchDiscardsTheOldBytes() = runTest {
        val transferred = CompletableDeferred<Unit>()
        val releaseResult = CompletableDeferred<Unit>()
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .header("Content-Type", "text/plain")
                .header("Content-Disposition", "attachment; filename=\"old.txt\"")
                .body("old computer".toResponseBody("text/plain".toMediaType()))
                .build()
        }.build()
        val connections = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id))
        val tokens = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token"))
        val session = Session(
            scope = backgroundScope,
            connectionStore = connections,
            tokenStore = tokens,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            clientFactory = { connection, token -> CompanionClient(connection, token, http) },
            eventsFn = { _, _, _ -> emptyFlow() },
            afterAttachmentDownload = {
                transferred.complete(Unit)
                releaseResult.await()
            },
        )
        session.awaitRestored()

        val result = async {
            session.downloadFile("thread-1", "message-1", "/private/old.txt")
        }
        transferred.await()
        session.switchComputer(pro.id)
        runCurrent()
        assertEquals(pro, session.connection.value)
        releaseResult.complete(Unit)

        assertNull(result.await())
        assertNull(session.actionError)
    }

    @Test
    fun overviewResponsesFromPreviousComputerAreDiscarded() = runTest {
        for (status in listOf(200, 500)) {
            val started = CountDownLatch(1)
            val release = CountDownLatch(1)
            val http = OkHttpClient.Builder().addInterceptor { chain ->
                started.countDown()
                check(release.await(5, TimeUnit.SECONDS)) { "overview request was never released" }
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(status)
                    .message("Fixture")
                    .body((if (status == 200) fixtureText("bot-overview") else """{"error":"old computer failed"}""")
                        .toResponseBody("application/json".toMediaType()))
                    .build()
            }.build()
            val session = Session(
                scope = backgroundScope,
                connectionStore = RegistryStore(ConnectionRegistry(listOf(air, pro), air.id)),
                tokenStore = Tokens(mapOf(air.id to "air-token", pro.id to "pro-token")),
                onboardingStore = InMemoryOnboardingStore(),
                deviceNameProvider = { "Pixel" },
                clientFactory = { connection, token -> CompanionClient(connection, token, http) },
                eventsFn = { _, _, _ -> flow { awaitCancellation() } },
            )
            session.awaitRestored()

            val result = async { session.loadOverview("bot-1") }
            try {
                assertTrue(withContext(Dispatchers.IO) { started.await(5, TimeUnit.SECONDS) })
                session.switchComputer(pro.id)
                runCurrent()
                assertEquals(pro, session.connection.value)
            } finally {
                release.countDown()
            }

            assertNull(result.await(), "old computer's $status must not replace the new overview")
            assertNull(session.actionError, "old computer's $status must not raise an error on the new one")
        }
    }

    private val sampleBot = Bot(
        id = "bot-1",
        threadId = "thread-1",
        name = "Scout",
        title = "coder",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("i", "m"),
        createdAt = 1.0,
    )

    private fun parkingUnauthorizedClient(
        started: CountDownLatch,
        release: CountDownLatch,
        parkOnce: AtomicBoolean,
    ): OkHttpClient = OkHttpClient.Builder().addInterceptor { chain ->
        if (parkOnce.compareAndSet(true, false)) {
            started.countDown()
            check(release.await(5, TimeUnit.SECONDS)) { "timed out waiting to release parked 401" }
        }
        unauthorizedResponse(chain.request())
    }.build()

    private fun unauthorizedResponse(request: okhttp3.Request): Response = Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(401)
        .message("Unauthorized")
        .body("""{"error":"revoked"}""".toResponseBody("application/json".toMediaType()))
        .build()

    private class RegistryStore(initial: ConnectionRegistry) : ConnectionStore {
        var registry = initial
        override suspend fun load(): Connection? = registry.activeConnection
        override suspend fun save(connection: Connection) {
            registry = registry.upsert(connection)
        }
        override suspend fun clear() {
            registry = ConnectionRegistry()
        }
        override suspend fun loadRegistry() = ConnectionRegistryRestore(registry, migratedLegacyConnection = false)
        override suspend fun saveRegistry(registry: ConnectionRegistry) {
            this.registry = registry.normalized()
        }
    }

    private class Tokens(initial: Map<String, String>) : TokenStore {
        val tokens = initial.toMutableMap()
        override suspend fun save(connectionId: String, token: String) {
            tokens[connectionId] = token
        }
        override suspend fun read(connectionId: String): TokenStore.ReadResult =
            tokens[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing
        override suspend fun remove(connectionId: String) {
            tokens.remove(connectionId)
        }
    }
}
