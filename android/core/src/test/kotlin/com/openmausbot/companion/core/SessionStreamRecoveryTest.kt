package com.openmausbot.companion.core

import java.net.InetAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/** Actual Session, HTTP transport and SSE parser, with disposable loopback routes only. */
class SessionStreamRecoveryTest {
    @Test
    fun emptyHttpStreamRecoversThroughTheAdvertisedFallbackWithoutRestarting() = runBlocking<Unit> {
        MockWebServer().use { primary ->
            MockWebServer().use { backup ->
                primary.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest) = MockResponse()
                        .setHeader("Content-Type", "text/event-stream").setBody(": closed before hello\n\n")
                }
                backup.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                    "data: {\"kind\":\"hello\",\"cursor\":\"stream:4\",\"resumed\":false}\n\n" +
                        "data: {\"kind\":\"config\",\"seq\":5}\n\n",
                ))
                primary.start()
                backup.start()
                // Synthetic tailnet names retain production protected-route policy; DNS is pinned
                // to loopback so no installed Tailscale, external network or user pairing is used.
                val first = assertNotNull(CompanionEndpoint.create(
                    "http://primary.fixture.ts.net:${primary.port}", CompanionEndpointKind.TAILNET, 0,
                ))
                val second = assertNotNull(CompanionEndpoint.create(
                    "http://backup.fixture.ts.net:${backup.port}", CompanionEndpointKind.TAILNET, 1,
                ))
                val connection = Connection(id = "fixture", name = "Fixture", host = first.host, port = first.port,
                    activeEndpoint = first, endpoints = listOf(first, second)).establishingRoutePolicyFromInvite()
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                val http = OkHttpClient.Builder().dns(object : okhttp3.Dns {
                    override fun lookup(hostname: String) = listOf(InetAddress.getByName("127.0.0.1"))
                }).build()
                val session = Session(scope, Store(connection), Tokens(), InMemoryOnboardingStore(), { "Fixture phone" },
                    httpClient = http,
                    hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
                    instancesFn = { emptyList() },
                    metadataFn = { throw APIError.Status(404) },
                )
                try {
                    session.awaitRestored()
                    session.connect()
                    withTimeout(5_000) { session.state.first { it.cursor == "stream:5" } }
                    assertEquals("primary.fixture.ts.net:${primary.port}", primary.takeRequest().getHeader("Host"))
                    val recovered = backup.takeRequest()
                    assertEquals("/api/events?screens=off", recovered.path)
                    assertEquals("Bearer fixture-token", recovered.getHeader("Authorization"))
                    assertEquals(second.url, session.connection.value?.activeEndpoint?.url)
                } finally {
                    session.disconnect()
                    scope.cancel()
                    http.connectionPool.evictAll()
                    http.dispatcher.executorService.shutdown()
                }
            }
        }
    }

    private class Store(var connection: Connection) : ConnectionStore {
        override suspend fun load() = connection
        override suspend fun save(connection: Connection) { this.connection = connection }
        override suspend fun clear() = Unit
    }

    private class Tokens : TokenStore {
        override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("fixture-token")
        override suspend fun save(connectionId: String, token: String) = Unit
        override suspend fun remove(connectionId: String) = Unit
    }
}
