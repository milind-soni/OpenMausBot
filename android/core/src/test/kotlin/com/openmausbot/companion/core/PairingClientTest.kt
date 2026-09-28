package com.openmausbot.companion.core

import java.io.IOException
import java.net.ConnectException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.Buffer
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

@OptIn(ExperimentalCoroutinesApi::class)
class PairingClientTest {
    @Test
    fun protectedInviteNeverProbesOrRedeemsLanOrBonjour() = runBlocking {
        val stub = PairingStub { request ->
            if (request.url.host == "192.168.1.42") StubAction.reply(200, HEALTH)
            else StubAction.Failure()
        }
        val connection = Connection(
            name = "Mac",
            host = "mac.tail1234.ts.net",
            port = 8810,
            hosts = listOf("mac.tail1234.ts.net", "192.168.1.42", "openmausbot-aa.local"),
        )

        val error = assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(connection, CREDENTIAL, "Pixel", client = stub.client)
        }

        assertEquals(listOf("http://mac.tail1234.ts.net:8810"), error.attemptedRoutes)
        // This is the whole of what a stalled pairing tells the person, so the
        // switch it names has to be the one the desktop actually has: Phone
        // access, not a Companion toggle (`ios/Sources/CompanionCore/Client.swift:317`).
        assertEquals(
            "Couldn't reach this computer through any available route " +
                "(http://mac.tail1234.ts.net:8810). Keep Phone access turned on in " +
                "OpenMausBot, then try again.",
            error.message,
        )
        assertEquals(listOf("mac.tail1234.ts.net"), stub.requests.map { it.url.host })
        assertTrue(stub.requests.all { it.url.encodedPath == "/api/health" })
    }

    @Test
    fun concurrentProbeRespectsAdvertisedPriorityInsteadOfFirstResponse() = runBlocking {
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0)
        val tailnet = endpoint("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100)
        val stub = PairingStub { request ->
            when {
                request.url.encodedPath == "/api/health" && request.url.host == hosted.host ->
                    StubAction.reply(200, HEALTH, delayMillis = 80)
                request.url.encodedPath == "/api/health" -> StubAction.reply(200, HEALTH)
                else -> StubAction.reply(201, PAIRED)
            }
        }
        val connection = typedConnection(hosted, tailnet)

        val outcome = CompanionClient.pairFirstReachable(
            connection,
            CREDENTIAL,
            "Pixel",
            client = stub.client,
        )

        assertEquals(hosted, outcome.connection.activeEndpoint)
        assertEquals(hosted.host, stub.pairRequests.single().url.host)
        assertEquals(setOf(hosted.host, tailnet.host), stub.healthRequests.map { it.url.host }.toSet())
        assertTrue(stub.timeoutsFor("/api/health").all { it == 4L })
        assertEquals(listOf(8L), stub.timeoutsFor("/api/pair"))
    }

    @Test
    fun transportFailureRetriesProtectedFallbackWithSameRequestId() = runBlocking {
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0)
        val tailnet = endpoint("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100)
        val requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec"
        val stub = PairingStub { request ->
            when {
                request.url.encodedPath == "/api/health" -> StubAction.reply(200, HEALTH)
                request.url.host == hosted.host -> StubAction.Failure(IOException("response lost"))
                else -> StubAction.reply(201, PAIRED)
            }
        }

        val outcome = CompanionClient.pairFirstReachable(
            typedConnection(hosted, tailnet),
            CREDENTIAL,
            "Pixel",
            requestId,
            stub.client,
        )

        assertEquals(tailnet, outcome.connection.activeEndpoint)
        assertEquals(listOf(hosted.host, tailnet.host), stub.pairRequests.map { it.url.host })
        assertEquals(listOf(requestId, requestId), stub.pairRequests.map { it.stringBody("pairRequestId") })
    }

    @Test
    fun hostedFailureNeverFallsBackToUnchosenDirectHttp() = runBlocking {
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0)
        val lan = endpoint("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200)
        val stub = PairingStub { request ->
            if (request.url.scheme == "https") StubAction.Failure() else StubAction.reply(200, HEALTH)
        }

        val error = assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(
                typedConnection(hosted, lan),
                CREDENTIAL,
                "Pixel",
                client = stub.client,
            )
        }

        assertEquals(listOf(hosted.url), error.attemptedRoutes)
        assertEquals(1, stub.requests.size)
        assertEquals("https", stub.requests.single().url.scheme)
        assertFalse(stub.requests.any { it.url.host == lan.host })
    }

    @Test
    fun hostedGatewayRetriesTailnetButNeverLan() = runBlocking {
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0)
        val tailnet = endpoint("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100)
        val lan = endpoint("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200)
        val requestId = "d350b2ac-7f92-4f30-bf80-21e040c1494b"
        val stub = PairingStub { request ->
            when {
                request.url.encodedPath == "/api/health" -> StubAction.reply(200, HEALTH)
                request.url.scheme == "https" -> StubAction.reply(502, "")
                else -> StubAction.reply(201, PAIRED)
            }
        }

        val outcome = CompanionClient.pairFirstReachable(
            typedConnection(hosted, tailnet, lan),
            CREDENTIAL,
            "Pixel",
            requestId,
            stub.client,
        )

        assertEquals(tailnet, outcome.connection.activeEndpoint)
        assertEquals(listOf(hosted.host, tailnet.host), stub.pairRequests.map { it.url.host })
        assertFalse(stub.requests.any { it.url.host == lan.host })
        assertEquals(listOf(requestId, requestId), stub.pairRequests.map { it.stringBody("pairRequestId") })
    }

    @Test
    fun retryRecoversLostResponseWithSameLogicalRequestId() = runBlocking {
        val pairAttempts = AtomicInteger()
        val requestId = "4c825d5b-cf40-4db7-aac5-2455f805a8ec"
        val stub = PairingStub { request ->
            if (request.url.encodedPath == "/api/health") {
                StubAction.reply(200, HEALTH)
            } else if (pairAttempts.incrementAndGet() == 1) {
                StubAction.Failure(IOException("response lost after commit"))
            } else {
                StubAction.reply(201, PAIRED)
            }
        }
        val connection = Connection(name = "Mac", host = "192.168.1.42", port = 8810)

        assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(
                connection,
                CREDENTIAL,
                "Pixel",
                requestId,
                stub.client,
            )
        }
        val outcome = CompanionClient.pairFirstReachable(
            connection,
            CREDENTIAL,
            "Pixel",
            requestId,
            stub.client,
        )

        assertEquals("omb_device", outcome.response.token)
        assertEquals(listOf(requestId, requestId), stub.pairRequests.map { it.stringBody("pairRequestId") })
    }

    @Test
    fun failedProbesNeverPresentTheCredential() = runBlocking {
        val stub = PairingStub { StubAction.Failure(IOException("timed out")) }
        val connection = Connection(
            name = "Mac",
            host = "mac.tail1234.ts.net",
            port = 8810,
            hosts = listOf("192.168.1.42"),
        )

        assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(connection, CREDENTIAL, "Pixel", client = stub.client)
        }

        assertTrue(stub.requests.isNotEmpty())
        assertTrue(stub.requests.all { it.url.encodedPath == "/api/health" && it.body == null })
        assertFalse(stub.requests.any { request -> request.bodyText().contains(CREDENTIAL) })
    }

    @Test
    fun rejectsServiceWithWrongIdentityWithoutPairing() = runBlocking {
        val stub = PairingStub { StubAction.reply(200, """{"app":"something-else"}""") }
        val connection = Connection(name = "Mac", host = "192.168.1.42", port = 8810)

        assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(connection, CREDENTIAL, "Pixel", client = stub.client)
        }

        assertTrue(stub.pairRequests.isEmpty())
    }

    @Test
    fun correctIdentityOnNon2xxHealthResponseIsStillRejected() = runBlocking {
        val stub = PairingStub { StubAction.reply(401, HEALTH) }
        val connection = Connection(name = "Mac", host = "192.168.1.42", port = 8810)

        assertFailsWith<PairingRouteError> {
            CompanionClient.pairFirstReachable(connection, CREDENTIAL, "Pixel", client = stub.client)
        }

        assertEquals(1, stub.healthRequests.size)
        assertTrue(stub.pairRequests.isEmpty())
    }

    @Test
    fun clientRejectionIsAuthoritativeAndNotSentToFallback() = runBlocking {
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0)
        val tailnet = endpoint("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100)
        val stub = PairingStub { request ->
            if (request.url.encodedPath == "/api/health") StubAction.reply(200, HEALTH)
            else StubAction.reply(401, """{"error":"pairing expired"}""")
        }

        val error = assertFailsWith<APIError.Status> {
            CompanionClient.pairFirstReachable(
                typedConnection(hosted, tailnet),
                CREDENTIAL,
                "Pixel",
                client = stub.client,
            )
        }

        assertEquals(401, error.code)
        assertEquals("pairing expired", error.serverMessage)
        assertEquals(1, stub.pairRequests.size)
    }

    @Test
    fun explicitManualLanStillPairs() = runBlocking {
        val stub = PairingStub { request ->
            if (request.url.encodedPath == "/api/health") StubAction.reply(200, HEALTH)
            else StubAction.reply(201, PAIRED)
        }
        val connection = Connection(name = "Mac", host = "192.168.1.42", port = 8810)

        val outcome = CompanionClient.pairFirstReachable(
            connection,
            "004209",
            "Pixel",
            client = stub.client,
        )

        assertEquals("192.168.1.42", outcome.connection.host)
        assertEquals("omb_device", outcome.response.token)
        assertTrue(stub.requests.all { it.url.host == "192.168.1.42" })
        assertEquals("004209", stub.pairRequests.single().stringBody("code"))
    }

    @Test
    fun pairingProbeWinnerRemainsTheRatchetHeadUntilItsOneWayUpgrade() = runTest {
        val local = endpoint("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 0)
        val hosted = endpoint("https://mac.companion.example", CompanionEndpointKind.HOSTED, 100)
        val unchosenBonjour = endpoint(
            "http://openmausbot-aa.local:8810",
            CompanionEndpointKind.BONJOUR,
            200,
        )
        val pairedWithHostedFirst = """{
            "token":"omb_device",
            "device":{"id":"d","name":"Pixel","createdAt":1,"lastSeenAt":1},
            "serverName":"Mac",
            "endpoints":[
                {"url":"${hosted.url}","kind":"hosted","priority":0},
                {"url":"${local.url}","kind":"lan","priority":200},
                {"url":"${unchosenBonjour.url}","kind":"bonjour","priority":300}
            ]
        }""".trimIndent()
        val stub = PairingStub { request ->
            when {
                request.url.encodedPath == "/api/health" && request.url.host == local.host ->
                    StubAction.reply(200, HEALTH, delayMillis = 40)
                request.url.encodedPath == "/api/health" -> StubAction.reply(200, HEALTH)
                request.url.encodedPath == "/api/pair" -> StubAction.reply(201, pairedWithHostedFirst)
                else -> StubAction.reply(404, "")
            }
        }
        var savedConnection: Connection? = null
        val connectionStore = object : ConnectionStore {
            override suspend fun load(): Connection? = savedConnection
            override suspend fun save(connection: Connection) {
                savedConnection = connection
            }
            override suspend fun clear() {
                savedConnection = null
            }
        }
        val savedTokens = mutableMapOf<String, String>()
        val tokenStore = object : TokenStore {
            override suspend fun save(connectionId: String, token: String) {
                savedTokens[connectionId] = token
            }
            override suspend fun read(connectionId: String): TokenStore.ReadResult =
                savedTokens[connectionId]?.let(TokenStore.ReadResult::Found)
                    ?: TokenStore.ReadResult.Missing
            override suspend fun remove(connectionId: String) {
                savedTokens.remove(connectionId)
            }
        }
        val streamRoutes = mutableListOf<String>()
        val session = Session(
            scope = backgroundScope,
            connectionStore = connectionStore,
            tokenStore = tokenStore,
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            httpClient = stub.client,
            clientFactory = { connection, token ->
                streamRoutes += connection.baseUrl.toString()
                CompanionClient(connection, token, stub.client)
            },
            eventsFn = { client, _, _ ->
                when (client.connection.baseUrl.toString()) {
                    local.url -> flow<StreamFrame> { throw ConnectException("refused") }
                    hosted.url -> flow {
                        emit(StreamFrame(Frame.Hello(cursor = "s:1", resumed = true), seq = 1))
                        awaitCancellation()
                    }
                    else -> flow { error("the ratchet selected an unapproved route") }
                }
            },
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
            metadataFn = { throw APIError.Status(404) },
        )
        session.awaitRestored()

        session.pair(
            typedConnection(local, hosted, unchosenBonjour),
            CREDENTIAL,
            "pair-request-integrated",
        )

        assertEquals(setOf(local.host, hosted.host), stub.healthRequests.map { it.url.host }.toSet())
        assertEquals(listOf(local.host), stub.pairRequests.map { it.url.host })
        assertFalse(stub.requests.any { it.url.host == unchosenBonjour.host })
        assertEquals(listOf(local.url), streamRoutes, "the probe winner leads the live ratchet")
        assertEquals(local.url, assertNotNull(savedConnection).activeEndpoint?.url)

        runCurrent()

        assertEquals(
            listOf(local.url, hosted.url),
            streamRoutes,
            "the chosen cleartext route upgrades to hosted instead of being pruned or walking sideways",
        )
        assertFalse(streamRoutes.contains(unchosenBonjour.url))

        advanceTimeBy(1_100)
        runCurrent()

        assertEquals(Session.Status.Live, session.status.value)
        assertEquals(hosted.url, assertNotNull(savedConnection).activeEndpoint?.url)
    }

    private fun endpoint(url: String, kind: CompanionEndpointKind, priority: Int): CompanionEndpoint =
        assertNotNull(CompanionEndpoint.create(url, kind, priority))

    private fun typedConnection(vararg endpoints: CompanionEndpoint): Connection {
        val active = endpoints.first()
        return Connection(
            name = "Mac",
            host = active.host,
            port = active.port,
            activeEndpoint = active,
            endpoints = endpoints.toList(),
        )
    }

    private companion object {
        const val CREDENTIAL = "omb_pair_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val HEALTH = """{"app":"openmausbot","pid":42,"static":true}"""
        const val PAIRED =
            """{"token":"omb_device","device":{"id":"d","name":"Pixel","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["192.168.1.42"]}"""
    }
}

private sealed interface StubAction {
    data class Reply(val code: Int, val body: String, val delayMillis: Long) : StubAction
    data class Failure(val error: IOException = IOException("cannot connect")) : StubAction

    companion object {
        fun reply(code: Int, body: String, delayMillis: Long = 0) = Reply(code, body, delayMillis)
    }
}

private class PairingStub(private val action: (Request) -> StubAction) : Interceptor {
    val requests: MutableList<Request> = CopyOnWriteArrayList()
    private val timeoutSeconds: MutableList<Pair<String, Long>> =
        CopyOnWriteArrayList()
    val client: OkHttpClient = OkHttpClient.Builder().addInterceptor(this).build()

    val healthRequests: List<Request> get() = requests.filter { it.url.encodedPath == "/api/health" }
    val pairRequests: List<Request> get() = requests.filter { it.url.encodedPath == "/api/pair" }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        requests += request
        timeoutSeconds += request.url.encodedPath to
            TimeUnit.NANOSECONDS.toSeconds(chain.call().timeout().timeoutNanos())
        return when (val result = action(request)) {
            is StubAction.Failure -> throw result.error
            is StubAction.Reply -> {
                if (result.delayMillis > 0) Thread.sleep(result.delayMillis)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(result.code)
                    .message("stub")
                    .header("Content-Type", "application/json")
                    .body(result.body.toResponseBody("application/json".toMediaType()))
                    .build()
            }
        }
    }

    fun timeoutsFor(path: String): List<Long> = timeoutSeconds.filter { it.first == path }.map { it.second }
}

private fun Request.bodyText(): String = body?.let { body ->
    Buffer().also(body::writeTo).readUtf8()
}.orEmpty()

private fun Request.stringBody(field: String): String =
    CompanionJson.parseToJsonElement(bodyText()).jsonObject.getValue(field).jsonPrimitive.content
