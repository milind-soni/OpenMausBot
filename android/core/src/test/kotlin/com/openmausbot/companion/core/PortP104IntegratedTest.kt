package com.openmausbot.companion.core

import java.net.InetAddress
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/**
 * PORT-P1-04: the three security passes composed against real HTTP/TLS sockets.
 *
 * The sidecar below is deliberately not an OkHttp interceptor or a Session function seam. Each
 * logical route is DNS-mapped to a MockWebServer socket, and the server records the request after
 * it crossed the transport boundary: scheme, logical authority, Authorization and body. That
 * record is the security oracle used by every scenario.
 */
class PortP104IntegratedTest {
    @Test
    fun oldAddressOnlySidecarPairsConnectsAndSurvivesStoreOnlyRestart() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val stores = DurableStores()
            sidecar.handle(OLD_TAILNET) { request ->
                standardSidecarResponse(request, pairResponse())
            }
            val legacy = Connection(
                id = CONNECTION_ID,
                name = "Old Mac",
                host = OLD_TAILNET,
                port = sidecar.httpPort,
            )

            val first = session(sidecar, stores)
            try {
                first.session.pair(legacy, QR_CREDENTIAL, REQUEST_ID)
                awaitLive(first.session)
                eventually {
                    sidecar.requests(OLD_TAILNET, "/api/companion/endpoints").isNotEmpty()
                }
                val health = sidecar.requests(OLD_TAILNET, "/api/health").single()
                assertEquals("GET", health.method)
                assertNull(health.authorization, "the health preflight carried a credential")
                assertTrue(health.body.isEmpty(), "the health preflight carried a request body")
                val refresh = sidecar.requests(OLD_TAILNET, "/api/companion/endpoints").single()
                assertEquals("GET", refresh.method)
                assertEquals("Bearer $DEVICE_TOKEN", refresh.authorization)
                assertEquals(Session.Status.Live, first.session.status.value, "the legacy refresh 404 ended the live session")
                assertNull(stores.connection?.endpoints, "old sidecars still persist the legacy shape")
                assertEquals(OLD_TAILNET, stores.connection?.host)
            } finally {
                first.close()
            }

            val eventsBeforeRestart = sidecar.requests(OLD_TAILNET, "/api/events").size
            val restored = session(sidecar, stores)
            try {
                restored.session.awaitRestored()
                restored.session.connect()
                eventually {
                    sidecar.requests(OLD_TAILNET, "/api/events").size > eventsBeforeRestart &&
                        restored.session.status.value == Session.Status.Live
                }
                assertEquals("Bearer $DEVICE_TOKEN", sidecar.requests(OLD_TAILNET, "/api/events").last().authorization)
            } finally {
                restored.close()
            }

            assertEquals(1, sidecar.requests(OLD_TAILNET, "/api/pair").size)
            sidecar.assertNoSecretsOnLocalHttp(setOf(QR_CREDENTIAL, DEVICE_TOKEN))
        }
    }

    @Test
    fun hostedQrUsesRealHttpsInsteadOfItsLegacyLanAddressAndRestoresThere() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val stores = DurableStores()
            val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 0)
            val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 100)
            val response = pairResponse(endpoints = listOf(hosted, lan))
            sidecar.handle(HOSTED) { request -> standardSidecarResponse(request, response) }
            sidecar.handle(LEGACY_LAN) { request -> standardSidecarResponse(request, response) }
            val invite = assertNotNull(PairingInvite.parse(invite(sidecar.httpUrl(LEGACY_LAN), listOf(hosted, lan))))

            val first = session(sidecar, stores)
            try {
                first.session.pair(invite, REQUEST_ID)
                awaitLive(first.session)
                assertEquals(hosted.url, stores.connection?.activeEndpoint?.url)
            } finally {
                first.close()
            }

            val hostedEvents = sidecar.requests(HOSTED, "/api/events").size
            val restored = session(sidecar, stores)
            try {
                restored.session.awaitRestored()
                restored.session.connect()
                eventually {
                    sidecar.requests(HOSTED, "/api/events").size > hostedEvents &&
                        restored.session.status.value == Session.Status.Live
                }
            } finally {
                restored.close()
            }

            val pair = sidecar.requests(path = "/api/pair").single()
            assertEquals("https", pair.scheme)
            assertEquals(HOSTED, pair.host)
            assertTrue(sidecar.requests(LEGACY_LAN).isEmpty(), "the legacy LAN must not even be probed")
            sidecar.assertNoSecretsOnLocalHttp(setOf(QR_CREDENTIAL, DEVICE_TOKEN))
        }
    }

    @Test
    fun tailnetKeepsHttpAndTsNetPolicyWithoutWalkingToLan() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val stores = DurableStores()
            val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 0)
            val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 100)
            val response = pairResponse(endpoints = listOf(tailnet, lan))
            sidecar.handle(TAILNET) { request -> standardSidecarResponse(request, response) }
            sidecar.handle(LEGACY_LAN) { request -> standardSidecarResponse(request, response) }
            val parsed = assertNotNull(PairingInvite.parse(invite(sidecar.httpUrl(LEGACY_LAN), listOf(tailnet, lan))))

            val first = session(sidecar, stores)
            try {
                first.session.pair(parsed, REQUEST_ID)
                awaitLive(first.session)
            } finally {
                first.close()
            }

            val restored = session(sidecar, stores)
            try {
                restored.session.awaitRestored()
                restored.session.connect()
                awaitLive(restored.session)
            } finally {
                restored.close()
            }

            assertEquals("http", stores.connection?.activeEndpoint?.baseUrl?.scheme)
            assertEquals(CompanionEndpointKind.TAILNET, stores.connection?.activeEndpoint?.kind)
            assertTrue(stores.connection?.activeEndpoint?.host?.endsWith(".ts.net") == true)
            assertTrue(sidecar.requests(TAILNET).any { it.authorization == "Bearer $DEVICE_TOKEN" })
            assertTrue(sidecar.requests(LEGACY_LAN).isEmpty())
            sidecar.assertNoSecretsOnLocalHttp(setOf(QR_CREDENTIAL, DEVICE_TOKEN))
        }
    }

    @Test
    fun explicitLanIsTriedOnceThenHostedUpgradePrunesItAcrossRestart() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val local = endpoint(sidecar.httpUrl(EXPLICIT_LAN), CompanionEndpointKind.LAN, 0)
            val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 100)
            val stores = DurableStores(
                connection = Connection(
                    id = CONNECTION_ID,
                    name = "Mac",
                    host = hosted.host,
                    port = hosted.port,
                    activeEndpoint = hosted,
                    endpoints = listOf(hosted),
                ),
                token = DEVICE_TOKEN,
            )
            sidecar.handle(EXPLICIT_LAN) { request ->
                when (request.path) {
                    "/api/events" -> jsonResponse("", 502)
                    else -> jsonResponse("", 404)
                }
            }
            sidecar.handle(HOSTED) { request ->
                when (request.path) {
                    "/api/events" -> liveStream()
                    "/api/companion/endpoints" -> metadataResponse(listOf(local, hosted))
                    else -> jsonResponse("", 404)
                }
            }

            val first = session(sidecar, stores)
            try {
                first.session.awaitRestored()
                first.session.connect()
                awaitLive(first.session)
                assertTrue(first.session.updateAddressAndAwait("$EXPLICIT_LAN:${sidecar.httpPort}"))
                eventually { sidecar.requests(EXPLICIT_LAN, "/api/events").size == 1 }
                eventually {
                    first.session.status.value == Session.Status.Live &&
                        sidecar.requests(HOSTED, "/api/events").size >= 2
                }
                eventually { stores.connection?.activeEndpoint?.url == hosted.url }
            } finally {
                first.close()
            }

            val localAttempts = sidecar.requests(EXPLICIT_LAN, "/api/events").size
            val hostedAttempts = sidecar.requests(HOSTED, "/api/events").size
            val restored = session(sidecar, stores)
            try {
                restored.session.awaitRestored()
                restored.session.connect()
                eventually {
                    restored.session.status.value == Session.Status.Live &&
                        sidecar.requests(HOSTED, "/api/events").size > hostedAttempts
                }
                assertEquals(
                    localAttempts,
                    sidecar.requests(EXPLICIT_LAN, "/api/events").size,
                    "store-only restart retried the pruned cleartext LAN with the bearer",
                )
                assertEquals(hosted.url, restored.session.connection.value?.activeEndpoint?.url)
            } finally {
                restored.close()
            }

            val explicitAttempt = sidecar.requests(EXPLICIT_LAN, "/api/events").single()
            assertEquals("Bearer $DEVICE_TOKEN", explicitAttempt.authorization)
            assertFalse(explicitAttempt.body.contains(QR_CREDENTIAL))
            sidecar.assertNoSecretsOnLocalHttp(
                secrets = setOf(QR_CREDENTIAL, DEVICE_TOKEN),
                explicitlyAuthorizedHosts = setOf(EXPLICIT_LAN),
            )
        }
    }

    @Test
    fun lostPairResponseReplaysSameRequestOnProtectedRouteWithoutOrphan() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 0)
            val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 100)
            val endpoints = listOf(tailnet, hosted)
            val ledger = ConcurrentHashMap<String, String>()
            sidecar.handle(TAILNET) { request ->
                when (request.path) {
                    "/api/health" -> healthResponse()
                    "/api/pair" -> {
                        val id = request.jsonField("pairRequestId")
                        ledger.computeIfAbsent(id) { pairResponse(endpoints = endpoints) }
                        MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                    "/api/events" -> liveStream()
                    "/api/companion/endpoints" -> jsonResponse("", 404)
                    else -> jsonResponse("", 404)
                }
            }
            sidecar.handle(HOSTED) { request ->
                when (request.path) {
                    "/api/health" -> healthResponse()
                    "/api/pair" -> jsonResponse(ledger.computeIfAbsent(request.jsonField("pairRequestId")) {
                        pairResponse(endpoints = endpoints)
                    }, 201)
                    "/api/events" -> liveStream()
                    "/api/companion/endpoints" -> jsonResponse("", 404)
                    else -> jsonResponse("", 404)
                }
            }
            val stores = DurableStores()
            val connection = typedConnection(tailnet, hosted)

            val first = session(sidecar, stores)
            try {
                first.session.pair(connection, QR_CREDENTIAL, REQUEST_ID)
                awaitLive(first.session)
                assertEquals(DEVICE_TOKEN, stores.tokenFor(CONNECTION_ID))
            } finally {
                first.close()
            }

            val pairs = sidecar.requests(path = "/api/pair")
            assertEquals(listOf(TAILNET, HOSTED), pairs.map { it.host })
            assertEquals(listOf(REQUEST_ID, REQUEST_ID), pairs.map { it.jsonField("pairRequestId") })
            assertEquals(1, ledger.size, "the sidecar minted one logical device/token result")
            assertEquals(1, pairs.map { ledger.getValue(it.jsonField("pairRequestId")) }.distinct().size)

            val tailnetEvents = sidecar.requests(TAILNET, "/api/events").size
            val restored = session(sidecar, stores)
            try {
                restored.session.awaitRestored()
                restored.session.connect()
                eventually {
                    sidecar.requests(TAILNET, "/api/events").size > tailnetEvents &&
                        restored.session.status.value == Session.Status.Live
                }
            } finally {
                restored.close()
            }
            sidecar.assertNoSecretsOnLocalHttp(setOf(QR_CREDENTIAL, DEVICE_TOKEN))
        }
    }

    @Test
    fun exactHealthIdentityIsRequiredBeforeCredentialCrossesTheNetwork() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 0)
            val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 100)
            val endpoints = listOf(tailnet, hosted)
            sidecar.handle(TAILNET) { request ->
                when (request.path) {
                    "/api/health" -> jsonResponse("""{"app":"openmausbot-proxy"}""")
                    "/api/pair" -> jsonResponse(pairResponse(endpoints = endpoints), 201)
                    else -> jsonResponse("", 404)
                }
            }
            sidecar.handle(HOSTED) { request -> standardSidecarResponse(request, pairResponse(endpoints = endpoints)) }
            val stores = DurableStores()
            val running = session(sidecar, stores)
            try {
                running.session.pair(typedConnection(tailnet, hosted), QR_CREDENTIAL, REQUEST_ID)
                assertTrue(
                    sidecar.requests(TAILNET, "/api/pair").isEmpty(),
                    "a service whose identity is only a prefix match received the pairing credential",
                )
                assertEquals(1, sidecar.requests(HOSTED, "/api/pair").size)
                awaitLive(running.session)
            } finally {
                running.close()
            }

            sidecar.assertNoSecretsOnLocalHttp(setOf(QR_CREDENTIAL, DEVICE_TOKEN))
        }
    }

    @Test
    fun invalidCertificateAndEveryGatewayStatusMoveOnlyToProtectedRoute() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val invalid = endpoint(sidecar.invalidHttpsUrl(INVALID_TLS), CompanionEndpointKind.HOSTED, 0)
            val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 100)
            val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 200)
            sidecar.handle(TAILNET) { request -> standardRestoredResponse(request) }
            sidecar.handle(LEGACY_LAN) { request -> standardRestoredResponse(request) }
            sidecar.handle(INVALID_TLS) { request -> standardRestoredResponse(request) }
            val invalidStores = DurableStores(typedConnection(invalid, tailnet, lan), DEVICE_TOKEN)

            val invalidSession = session(sidecar, invalidStores)
            try {
                invalidSession.session.awaitRestored()
                invalidSession.session.connect()
                eventually(timeoutMillis = FAILOVER_TIMEOUT_MS) {
                    val protectedRouteIsLive = invalidSession.session.status.value == Session.Status.Live &&
                        sidecar.requests(TAILNET, "/api/events").isNotEmpty()
                    val retriedInvalidAuthority = sidecar.tlsAttempts(INVALID_TLS) >= 2 &&
                        sidecar.requests(TAILNET, "/api/events").isEmpty()
                    protectedRouteIsLive || retriedInvalidAuthority
                }
                assertFalse(
                    sidecar.tlsAttempts(INVALID_TLS) >= 2 &&
                        sidecar.requests(TAILNET, "/api/events").isEmpty(),
                    "TLS failure kept retrying the invalid authority instead of advancing to the protected route",
                )
                assertTrue(sidecar.requests(TAILNET, "/api/events").isNotEmpty())
            } finally {
                invalidSession.close()
            }
            assertTrue(sidecar.requests(INVALID_TLS).isEmpty(), "an invalid TLS handshake exposes no HTTP request")
            assertTrue(sidecar.requests(LEGACY_LAN).isEmpty())
            sidecar.assertNoSecretsOnLocalHttp(setOf(DEVICE_TOKEN))
        }

        for (status in GATEWAY_STATUSES) {
            NetworkSidecar().use { sidecar ->
                val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 0)
                val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 100)
                val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 200)
                sidecar.handle(HOSTED) { request ->
                    if (request.path == "/api/events") jsonResponse("", status) else jsonResponse("", 404)
                }
                sidecar.handle(TAILNET) { request -> standardRestoredResponse(request) }
                sidecar.handle(LEGACY_LAN) { request -> standardRestoredResponse(request) }
                val stores = DurableStores(typedConnection(hosted, tailnet, lan), DEVICE_TOKEN)
                val running = session(sidecar, stores)
                try {
                    running.session.awaitRestored()
                    running.session.connect()
                    eventually(timeoutMillis = FAILOVER_TIMEOUT_MS) {
                        running.session.status.value == Session.Status.Live &&
                            sidecar.requests(TAILNET, "/api/events").isNotEmpty()
                    }
                } finally {
                    running.close()
                }
                assertTrue(sidecar.requests(LEGACY_LAN).isEmpty(), "HTTP $status must not authorize LAN")
                sidecar.assertNoSecretsOnLocalHttp(setOf(DEVICE_TOKEN))
            }
        }
    }

    @Test
    fun exhaustedProtectedRoutesNeverBroadenFailoverToCleartextLan() = runBlocking {
        NetworkSidecar().use { sidecar ->
            val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 0)
            val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 100)
            val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 200)
            sidecar.handle(HOSTED) { request ->
                if (request.path == "/api/events") jsonResponse("", 502) else jsonResponse("", 404)
            }
            sidecar.handle(TAILNET) { request ->
                if (request.path == "/api/events") jsonResponse("", 522) else jsonResponse("", 404)
            }
            sidecar.handle(LEGACY_LAN) { request -> standardRestoredResponse(request) }
            val stores = DurableStores(typedConnection(hosted, tailnet, lan), DEVICE_TOKEN)
            val running = session(sidecar, stores)
            try {
                running.session.awaitRestored()
                running.session.connect()
                eventually(timeoutMillis = 2_000) {
                    sidecar.requests(TAILNET, "/api/events").isNotEmpty()
                }
                // Observe the attempt after the live 2s backoff instead of racing it with a fixed
                // sleep. The protected-only set wraps to hosted; a broadened set reaches LAN.
                eventually(timeoutMillis = 5_000) {
                    sidecar.requests(HOSTED, "/api/events").size >= 2 ||
                        sidecar.requests(LEGACY_LAN, "/api/events").isNotEmpty()
                }
                assertTrue(
                    sidecar.requests(LEGACY_LAN).isEmpty(),
                    "exhausting protected routes sent the bearer to cleartext LAN",
                )
                assertEquals(2, sidecar.requests(HOSTED, "/api/events").size)
            } finally {
                running.close()
            }
            sidecar.assertNoSecretsOnLocalHttp(setOf(DEVICE_TOKEN))
        }
    }

    @Test
    fun applicationErrorsNeverMoveTheBearerToAnotherRoute() = runBlocking {
        for (status in APPLICATION_STATUSES) {
            NetworkSidecar().use { sidecar ->
                val hosted = endpoint(sidecar.trustedHttpsUrl(HOSTED), CompanionEndpointKind.HOSTED, 0)
                val tailnet = endpoint(sidecar.httpUrl(TAILNET), CompanionEndpointKind.TAILNET, 100)
                val lan = endpoint(sidecar.httpUrl(LEGACY_LAN), CompanionEndpointKind.LAN, 200)
                sidecar.handle(HOSTED) { request ->
                    if (request.path == "/api/events") jsonResponse("", status) else jsonResponse("", 404)
                }
                sidecar.handle(TAILNET) { request -> standardRestoredResponse(request) }
                sidecar.handle(LEGACY_LAN) { request -> standardRestoredResponse(request) }
                val stores = DurableStores(typedConnection(hosted, tailnet, lan), DEVICE_TOKEN)
                val running = session(sidecar, stores)
                try {
                    running.session.awaitRestored()
                    running.session.connect()
                    eventually { sidecar.requests(HOSTED, "/api/events").isNotEmpty() }
                    if (status == 401) {
                        eventually { running.session.status.value == Session.Status.Unauthorized }
                    } else {
                        // Wait for the next real attempt after the 1s backoff. A fixed delay could
                        // assert before a slow CI worker had actually dialed the wrong route.
                        eventually(timeoutMillis = 4_000) {
                            sidecar.requests(path = "/api/events").size >= 2
                        }
                    }
                    assertTrue(
                        sidecar.requests(TAILNET, "/api/events").isEmpty(),
                        "application HTTP $status must stay on the hosted route",
                    )
                    assertTrue(sidecar.requests(LEGACY_LAN).isEmpty())
                } finally {
                    running.close()
                }
                sidecar.assertNoSecretsOnLocalHttp(setOf(DEVICE_TOKEN))
            }
        }
    }

    private fun standardSidecarResponse(request: ObservedRequest, pairBody: String): MockResponse =
        when (request.path) {
            "/api/health" -> healthResponse()
            "/api/pair" -> jsonResponse(pairBody, 201)
            "/api/events" -> liveStream()
            "/api/companion/endpoints" -> jsonResponse("", 404)
            else -> jsonResponse("", 404)
        }

    private fun standardRestoredResponse(request: ObservedRequest): MockResponse =
        when (request.path) {
            "/api/events" -> liveStream()
            "/api/companion/endpoints" -> jsonResponse("", 404)
            else -> jsonResponse("", 404)
        }

    private fun session(sidecar: NetworkSidecar, stores: DurableStores): RunningSession {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        return RunningSession(
            session = Session(
                scope = scope,
                connectionStore = stores.connectionStore,
                tokenStore = stores.tokenStore,
                onboardingStore = InMemoryOnboardingStore(),
                deviceNameProvider = { "P1-04 Pixel" },
                httpClient = sidecar.client,
            ),
            scope = scope,
        )
    }

    private suspend fun awaitLive(session: Session) {
        eventually { session.status.value == Session.Status.Live }
    }

    private suspend fun eventually(timeoutMillis: Long = 2_500, condition: () -> Boolean) {
        withTimeout(timeoutMillis) {
            while (!condition()) delay(20)
        }
    }

    private fun typedConnection(vararg endpoints: CompanionEndpoint): Connection {
        val active = endpoints.first()
        return Connection(
            id = CONNECTION_ID,
            name = "Mac",
            host = active.host,
            port = active.port,
            activeEndpoint = active,
            endpoints = endpoints.toList(),
        )
    }

    private fun endpoint(url: HttpUrl, kind: CompanionEndpointKind, priority: Int): CompanionEndpoint =
        assertNotNull(CompanionEndpoint.create(url.toString().removeSuffix("/"), kind, priority))

    private fun invite(legacyAddress: HttpUrl, endpoints: List<CompanionEndpoint>): String {
        val encodedEndpoints = Base64.getUrlEncoder().withoutPadding().encodeToString(
            CompanionJson.encodeToString(endpoints).toByteArray(StandardCharsets.UTF_8),
        )
        val address = URLEncoder.encode(
            "${legacyAddress.host}:${legacyAddress.port}",
            StandardCharsets.UTF_8,
        ).replace("+", "%20")
        return "openmausbot://pair?address=$address&token=$QR_CREDENTIAL&endpoints=$encodedEndpoints"
    }

    private fun pairResponse(endpoints: List<CompanionEndpoint>? = null): String {
        val endpointField = endpoints?.let { ",\"endpoints\":${CompanionJson.encodeToString(it)}" }.orEmpty()
        return """{"token":"$DEVICE_TOKEN","device":{"id":"$DEVICE_ID","name":"P1-04 Pixel","createdAt":1,"lastSeenAt":1},"serverName":"Mac"$endpointField}"""
    }

    private fun metadataResponse(endpoints: List<CompanionEndpoint>): MockResponse = jsonResponse(
        """{"serverName":"Mac","endpoints":${CompanionJson.encodeToString(endpoints)}}""",
    )

    companion object {
        /**
         * A hang detector, not a latency budget. Reaching the protected route after a refused
         * authority costs a reconnect backoff — Session doubles it 1s → 15s — plus real TLS
         * handshakes against three MockWebServers on a shared CI runner. A window sized for a
         * quiet laptop fails the run for being slow rather than for being wrong, which is what
         * happened: one timeout in ~31 runs, on a tree whose android/ was byte-identical to a
         * green main. eventually() returns the moment its condition holds, so a generous
         * ceiling costs a passing run nothing — it only bounds how long we wait before calling
         * it hung. The assertions after each wait are what still judge the routing.
         */
        const val FAILOVER_TIMEOUT_MS = 15_000L

        const val CONNECTION_ID = "p1-04-connection"
        const val DEVICE_ID = "p1-04-device"
        const val DEVICE_TOKEN = "omb_device_p1_04_secret"
        const val QR_CREDENTIAL = "omb_pair_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val REQUEST_ID = "5a8e9d25-ef9c-40a2-a8b6-e8a3fd723102"

        const val HOSTED = "mac.p104.companion.example"
        const val INVALID_TLS = "invalid.p104.companion.example"
        const val TAILNET = "mac.p104-tailnet.ts.net"
        const val OLD_TAILNET = "old-mac.p104-tailnet.ts.net"
        // These are DNS authorities classified as LAN (not .ts.net/.local), which lets the
        // harness route them to loopback while preserving the exact policy the client sees.
        const val LEGACY_LAN = "legacy-lan.p104.test"
        const val EXPLICIT_LAN = "explicit-lan.p104.test"

        val LOGICAL_HOSTS = setOf(HOSTED, INVALID_TLS, TAILNET, OLD_TAILNET, LEGACY_LAN, EXPLICIT_LAN)
        val LOCAL_HTTP_HOSTS = setOf(LEGACY_LAN, EXPLICIT_LAN)
        val GATEWAY_STATUSES = (502..504).toList() + (520..530).toList()
        val APPLICATION_STATUSES = listOf(400, 401, 403, 404, 409, 500, 501)
    }
}

private data class RunningSession(val session: Session, val scope: CoroutineScope) {
    fun close() {
        session.disconnect()
        scope.cancel()
    }
}

private class DurableStores(
    connection: Connection? = null,
    token: String? = null,
) {
    @Volatile
    var connection: Connection? = connection
        private set

    private val tokens = ConcurrentHashMap<String, String>().apply {
        if (connection != null && token != null) put(connection.id, token)
    }

    val connectionStore = object : ConnectionStore {
        override suspend fun load(): Connection? = this@DurableStores.connection

        override suspend fun save(connection: Connection) {
            this@DurableStores.connection = connection
        }

        override suspend fun clear() {
            this@DurableStores.connection = null
        }
    }

    val tokenStore = object : TokenStore {
        override suspend fun save(connectionId: String, token: String) {
            tokens[connectionId] = token
        }

        override suspend fun read(connectionId: String): TokenStore.ReadResult =
            tokens[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing

        override suspend fun remove(connectionId: String) {
            tokens.remove(connectionId)
        }
    }

    fun tokenFor(connectionId: String): String? = tokens[connectionId]
}

private data class ObservedRequest(
    val scheme: String,
    val host: String,
    val port: Int,
    val method: String,
    val path: String,
    val authorization: String?,
    val body: String,
) {
    fun jsonField(name: String): String = CompanionJson.parseToJsonElement(body)
        .jsonObject.getValue(name).jsonPrimitive.content

    override fun toString(): String = "$method $scheme://$host:$port$path auth=${authorization ?: "<none>"} body=$body"
}

private class NetworkSidecar : AutoCloseable {
    private val observed = Collections.synchronizedList(mutableListOf<ObservedRequest>())
    private val attemptedTlsAuthorities = Collections.synchronizedList(mutableListOf<String>())
    private val handlers = ConcurrentHashMap<String, (ObservedRequest) -> MockResponse>()

    private val trustedCertificate = HeldCertificate.Builder()
        .commonName("PORT-P1-04 trusted sidecar")
        .apply { PortP104IntegratedTest.LOGICAL_HOSTS.forEach(::addSubjectAlternativeName) }
        .build()
    private val trustedServerCertificates = HandshakeCertificates.Builder()
        .heldCertificate(trustedCertificate)
        .build()
    private val invalidServerCertificates = HandshakeCertificates.Builder()
        .heldCertificate(
            HeldCertificate.Builder()
                .commonName("PORT-P1-04 invalid sidecar")
                .addSubjectAlternativeName(PortP104IntegratedTest.INVALID_TLS)
                .build(),
        )
        .build()
    private val clientCertificates = HandshakeCertificates.Builder()
        .addTrustedCertificate(trustedCertificate.certificate)
        .build()

    private val http = MockWebServer().apply {
        dispatcher = RecordingDispatcher("http", observed, handlers)
        start()
    }
    private val trustedHttps = MockWebServer().apply {
        useHttps(trustedServerCertificates.sslSocketFactory(), false)
        dispatcher = RecordingDispatcher("https", observed, handlers)
        start()
    }
    private val invalidHttps = MockWebServer().apply {
        useHttps(invalidServerCertificates.sslSocketFactory(), false)
        dispatcher = RecordingDispatcher("https", observed, handlers)
        start()
    }

    val httpPort: Int get() = http.port

    val client: OkHttpClient = OkHttpClient.Builder()
        .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
        .eventListener(object : EventListener() {
            override fun secureConnectStart(call: Call) {
                attemptedTlsAuthorities += call.request().url.host
            }
        })
        // RecordedRequest exposes the actual HTTP/1.1 Host header. Keeping this harness on 1.1
        // makes the server-side authority oracle explicit instead of relying on HTTP/2 internals.
        .protocols(listOf(Protocol.HTTP_1_1))
        .retryOnConnectionFailure(false)
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                return if (hostname in PortP104IntegratedTest.LOGICAL_HOSTS) {
                    listOf(InetAddress.getByName("127.0.0.1"))
                } else {
                    Dns.SYSTEM.lookup(hostname)
                }
            }
        })
        .build()

    fun handle(host: String, handler: (ObservedRequest) -> MockResponse) {
        handlers[host] = handler
    }

    fun httpUrl(host: String): HttpUrl = http.url("/").newBuilder().host(host).build()

    fun trustedHttpsUrl(host: String): HttpUrl = trustedHttps.url("/").newBuilder().host(host).build()

    fun invalidHttpsUrl(host: String): HttpUrl = invalidHttps.url("/").newBuilder().host(host).build()

    fun requests(host: String? = null, path: String? = null): List<ObservedRequest> = synchronized(observed) {
        observed.filter { request ->
            (host == null || request.host == host) && (path == null || request.path == path)
        }
    }

    fun tlsAttempts(host: String): Int = synchronized(attemptedTlsAuthorities) {
        attemptedTlsAuthorities.count { it == host }
    }

    /** Explicit, server-side credential assertion — never inferred from the client's intent. */
    fun assertNoSecretsOnLocalHttp(
        secrets: Set<String>,
        explicitlyAuthorizedHosts: Set<String> = emptySet(),
    ) {
        val leaks = requests().filter { request ->
            request.scheme == "http" &&
                request.host in PortP104IntegratedTest.LOCAL_HTTP_HOSTS &&
                request.host !in explicitlyAuthorizedHosts &&
                secrets.any { secret -> request.authorization.orEmpty().contains(secret) || request.body.contains(secret) }
        }
        assertTrue(leaks.isEmpty(), "credential reached an unapproved local cleartext sidecar:\n${leaks.joinToString("\n")}")
    }

    override fun close() {
        client.dispatcher.executorService.shutdownNow()
        client.connectionPool.evictAll()
        http.shutdown()
        trustedHttps.shutdown()
        invalidHttps.shutdown()
    }
}

private class RecordingDispatcher(
    private val scheme: String,
    private val observed: MutableList<ObservedRequest>,
    private val handlers: Map<String, (ObservedRequest) -> MockResponse>,
) : Dispatcher() {
    override fun dispatch(request: RecordedRequest): MockResponse {
        val url = assertNotNull(request.requestUrl)
        val receivedAuthority = request.getHeader("Host").orEmpty()
        val receivedHost = receivedAuthority.substringBeforeLast(':').ifEmpty { url.host }
        val record = ObservedRequest(
            scheme = scheme,
            host = receivedHost,
            port = url.port,
            method = request.method.orEmpty(),
            path = url.encodedPath,
            authorization = request.getHeader("Authorization"),
            body = request.body.clone().readUtf8(),
        )
        observed += record
        return handlers[record.host]?.invoke(record) ?: jsonResponse("", 404)
    }
}

private fun healthResponse(): MockResponse = jsonResponse("""{"app":"openmausbot","pid":42,"static":true}""")

private fun jsonResponse(body: String, code: Int = 200): MockResponse = MockResponse()
    .setResponseCode(code)
    .setHeader("Content-Type", "application/json")
    .setBody(body)

/** Delivers a hello immediately, then keeps the real socket occupied until the Session cancels. */
private fun liveStream(): MockResponse = MockResponse()
    .setResponseCode(200)
    .setHeader("Content-Type", "text/event-stream")
    .setBody(
        "data: {\"kind\":\"hello\",\"cursor\":\"p104:1\",\"resumed\":true}\n\n" +
            " ".repeat(64 * 1_024),
    )
    .throttleBody(256, 1, TimeUnit.SECONDS)
