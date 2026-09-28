package com.openmausbot.companion.core

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer

class ServerSessionPairingTest {
    @Test
    fun pairsWithServerPersistsBearerSeparatelyAndRestoresIdentity() = runBlocking<Unit> {
        Fixture().use { fixture ->
            fixture.session.pair(fixture.invite, "attempt-1234")
            val saved = assertNotNull(fixture.store.saved)
            assertEquals("headless mini", saved.name)
            assertEquals("env-fixture", saved.serverEnvironmentId)
            assertEquals(listOf("client"), saved.serverScopes)
            assertEquals("omb_sess_fixture", fixture.tokens.values[saved.id])
            val serialized = CompanionJson.encodeToString(saved)
            assertFalse(serialized.contains("ABCDEFGHJKLM"))
            assertFalse(serialized.contains("omb_sess_fixture"))
            assertEquals(saved, CompanionJson.decodeFromString<Connection>(serialized))
            val post = fixture.requests.single { it.url.encodedPath == "/api/auth/pair" }
            assertNull(post.header("Authorization"))
            val body = CompanionJson.parseToJsonElement(Buffer().also { post.body!!.writeTo(it) }.readUtf8()).jsonObject
            assertEquals("ABCDEFGHJKLM", body["code"]?.jsonPrimitive?.content)
            assertEquals("Pixel", body["label"]?.jsonPrimitive?.content)
            assertEquals("attempt-1234", body["attemptId"]?.jsonPrimitive?.content)
            assertNull(body["cookie"])
            assertEquals("/.well-known/openmausbot/environment", fixture.requests.first().url.encodedPath)
            assertTrue(fixture.requests.none { it.url.encodedPath == "/api/pair" })
        }
    }

    @Test
    fun failedDescriptorNeverSpendsCodeOrSavesAConnection() = runBlocking<Unit> {
        Fixture { request -> if (request.url.encodedPath.contains("well-known")) 404 to "{}" else null }.use { f ->
            assertFailsWith<APIError.Status> { f.session.pair(f.invite) }
            assertNull(f.store.saved)
            assertTrue(f.tokens.values.isEmpty())
            assertEquals(1, f.requests.size)
        }
    }

    @Test
    fun failedRedemptionSurfacesTheServerMessageWithoutSavingCredentials() = runBlocking<Unit> {
        Fixture { request -> if (request.url.encodedPath == "/api/auth/pair") 401 to """{"error":"code expired"}""" else null }.use { f ->
            val error = assertFailsWith<APIError.Status> { f.session.pair(f.invite) }
            assertEquals(401, error.code)
            assertEquals("code expired", error.message)
            assertNull(f.store.saved)
            assertTrue(f.tokens.values.isEmpty())
        }
    }

    @Test
    fun rateLimitedCodeCanBeRetriedWithTheSameAttempt() = runBlocking<Unit> {
        var calls = 0
        Fixture { request ->
            if (request.url.encodedPath == "/api/auth/pair" && calls++ == 0)
                429 to """{"error":"try again in 60s"}""" else null
        }.use { f ->
            val error = assertFailsWith<ServerPairingRetryError> { f.session.pair(f.invite, "retry-429") }
            assertEquals("try again in 60s", error.message)
            assertNull(f.store.saved)
            f.session.pair(f.invite, "retry-429")
            val posts = f.requests.filter { it.url.encodedPath == "/api/auth/pair" }
            assertEquals(2, posts.size)
            assertEquals(1, posts.map { Buffer().also { buffer -> it.body!!.writeTo(buffer) }.readUtf8() }.distinct().size)
            assertNotNull(f.store.saved)
        }
    }

    @Test
    fun lostResponseAllowsAnIdempotentRetryOfTheSameCode() = runBlocking<Unit> {
        var calls = 0
        Fixture { request ->
            if (request.url.encodedPath == "/api/auth/pair" && calls++ == 0) throw IOException("lost response")
            null
        }.use { f ->
            assertFailsWith<ServerPairingRetryError> { f.session.pair(f.invite, "retry-1234") }
            assertNull(f.store.saved)
            f.session.pair(f.invite, "retry-1234")
            val posts = f.requests.filter { it.url.encodedPath == "/api/auth/pair" }
            assertEquals(2, posts.size)
            assertEquals(1, posts.map { Buffer().also { buffer -> it.body!!.writeTo(buffer) }.readUtf8() }.distinct().size)
            assertNotNull(f.store.saved)
        }
    }

    @Test
    fun publicHttpIsRejectedBeforeManualPairingOrSendingSavedCredentials() = runBlocking<Unit> {
        val public = assertNotNull(Connection.parse("http://public.example:8799"))
        Fixture().use { f ->
            assertFailsWith<APIError.Transport> { f.session.pair(public, "ABCDEFGHJKLM") }
            assertFailsWith<APIError.Transport> {
                CompanionClient.pairWithServer(public, "ABCDEFGHJKLM", "Pixel", "attempt-1234", f.http)
            }
            val saved = public.copy(serverEnvironmentId = "env-fixture")
            assertFailsWith<APIError.Transport> { CompanionClient(saved, "saved-bearer", f.http).fleet() }
            assertTrue(f.requests.isEmpty(), "No identity probe, pairing code or bearer may reach public HTTP")
            // The rejected local preflight must not spend a code that never reached the server.
            f.session.pair(f.invite, "corrected-origin")
            assertNotNull(f.store.saved)
        }
    }

    @Test
    fun replacedServerNeverReceivesTheSavedBearerOrStartsTheStream() = runBlocking<Unit> {
        val saved = assertNotNull(Connection.parse("https://mini.example")).copy(serverEnvironmentId = "old-env")
        Fixture(saved = saved).use { f ->
            f.session.connect()
            withTimeout(5_000) { f.session.status.first { it == Session.Status.Unauthorized } }
            assertEquals(0, f.streamStarts)
            assertTrue(f.requests.isNotEmpty())
            assertTrue(f.requests.all { it.header("Authorization") == null })
        }
    }

    @Test
    fun authenticatedActionsOnSavedConnectionsVerifyIdentityBeforeSendingTheBearer() = runBlocking<Unit> {
        val saved = assertNotNull(Connection.parse("https://mini.example")).copy(serverEnvironmentId = "old-env")
        Fixture().use { f ->
            val client = CompanionClient(saved, "saved-bearer", f.http)
            assertFailsWith<APIError.Status> { client.fleet() }
            assertEquals(1, f.requests.size)
            assertEquals("/.well-known/openmausbot/environment", f.requests.single().url.encodedPath)
            assertNull(f.requests.single().header("Authorization"))
        }
    }

    @Test
    fun sharingToAnInactiveSavedServerDoesNotBypassIdentityVerification() = runBlocking<Unit> {
        val active = Connection(name = "desktop", host = "192.168.1.20", port = 8810)
        val saved = assertNotNull(Connection.parse("https://mini.example")).copy(serverEnvironmentId = "old-env")
        Fixture(saved = active, extraSaved = saved).use { f ->
            f.session.awaitRestored()
            assertFailsWith<APIError.Status> {
                f.session.withPairedShareClient(saved.id) { it.fleet() }
            }
            assertEquals(active.id, f.session.connection.value?.id)
            assertEquals(1, f.requests.size)
            assertNull(f.requests.single().header("Authorization"))
            assertEquals("/.well-known/openmausbot/environment", f.requests.single().url.encodedPath)
        }
    }

    @Test
    fun matchingServerReceivesBearerOnlyAfterAPublicIdentityCheck() = runBlocking<Unit> {
        val saved = assertNotNull(Connection.parse("https://mini.example")).copy(serverEnvironmentId = "env-fixture")
        Fixture { request -> if (request.url.encodedPath == "/api/bots") 200 to "{\"bots\":[],\"groups\":[]}" else null }.use { f ->
            CompanionClient(saved, "saved-bearer", f.http).fleet()
            assertEquals(listOf("/.well-known/openmausbot/environment", "/api/bots"), f.requests.map { it.url.encodedPath })
            assertNull(f.requests.first().header("Authorization"))
            assertEquals("Bearer saved-bearer", f.requests.last().header("Authorization"))
        }
    }

    @Test
    fun redirectedDescriptorIsRejectedWithoutFollowingIt() = runBlocking<Unit> {
        okhttp3.mockwebserver.MockWebServer().use { server ->
            server.enqueue(okhttp3.mockwebserver.MockResponse().setResponseCode(302)
                .setHeader("Location", "/other-environment"))
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("{\"environmentId\":\"env-fixture\",\"label\":\"mini\"}"))
            server.start()
            val connection = assertNotNull(Connection.parse(server.url("/").toString()))
            val error = assertFailsWith<APIError.Status> { CompanionClient(connection, null).environment() }
            assertEquals(302, error.code)
            assertEquals(1, server.requestCount)
        }
    }

    @Test
    fun legacyConnectionsDecodeWithoutServerFields() {
        val old = CompanionJson.decodeFromString<Connection>("""{"name":"Mac","host":"192.168.1.9","port":8810}""")
        assertFalse(old.pairedWithServer)
        assertNull(old.serverScopes)
    }

    private class Fixture(
        val saved: Connection? = null,
        val extraSaved: Connection? = null,
        val response: (Request) -> Pair<Int, String>? = { null },
    ) : AutoCloseable {
        val requests = CopyOnWriteArrayList<Request>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val store = Store(saved, extraSaved)
        val tokens = Tokens().apply { listOfNotNull(saved, extraSaved).forEach { values[it.id] = "omb_sess_fixture" } }
        @Volatile var streamStarts = 0
        val http = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            requests += request
            val (status, body) = response(request) ?: if (request.url.encodedPath == "/api/auth/pair") {
                200 to """{"token":"omb_sess_fixture","session":{"id":"s1","label":"Pixel","scopes":["client"]},"environment":{"environmentId":"env-fixture","label":"headless mini"}}"""
            } else {
                200 to """{"environmentId":"env-fixture","label":"headless mini"}"""
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(status).message("fixture")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }.build()
        val invite = assertNotNull(PairingInvite.parse("https://mini.example/pair#code=ABCD-EFGH-JKLM"))
        val session = Session(
            scope, store, tokens, InMemoryOnboardingStore(), { "Pixel" }, httpClient = http,
            eventsFn = { _, _, _ -> flow { streamStarts++; awaitCancellation() } },
        )
        override fun close() { session.disconnect(); scope.cancel() }
    }

    private class Store(var saved: Connection?, val extra: Connection? = null) : ConnectionStore {
        override suspend fun loadRegistry() = ConnectionRegistryRestore(
            ConnectionRegistry(listOfNotNull(saved, extra), saved?.id), migratedLegacyConnection = false,
        )
        override suspend fun load() = saved
        override suspend fun save(connection: Connection) { saved = connection }
        override suspend fun clear() { saved = null }
    }
    private class Tokens : TokenStore {
        val values = mutableMapOf<String, String>()
        override suspend fun save(connectionId: String, token: String) { values[connectionId] = token }
        override suspend fun read(connectionId: String): TokenStore.ReadResult =
            values[connectionId]?.let { TokenStore.ReadResult.Found(it) } ?: TokenStore.ReadResult.Missing
        override suspend fun remove(connectionId: String) { values.remove(connectionId) }
    }
}
