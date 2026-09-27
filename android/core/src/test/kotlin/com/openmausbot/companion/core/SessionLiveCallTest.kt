package com.openmausbot.companion.core

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * What [Session] adds on top of the client: the current call is re-read after
 * a fresh hello (the fleet snapshot never carries it), a 401 on a Live route
 * revokes the session the way every other authenticated action does, and the
 * quiet calls never raise the global error dialog. Newer news about the line
 * — a `live.call` frame, a hang-up's answer — is never overwritten by an
 * older answer that was still on its way, and a hang-up the computer answers
 * with 404 reads the line again rather than leave a call that is gone.
 */
class SessionLiveCallTest {
    private lateinit var server: MockWebServer
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private var liveCallCode = 200
    private var liveCallBody = """{"call":null}"""
    @Volatile private var endCode = 404
    @Volatile private var endBody = """{"error":"That call is not running."}"""
    /** Holds the answer to `POST /api/live/call/end` until the test lets it go. */
    @Volatile private var endGate: CountDownLatch? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient()
    private val running =
        """{"callId":"c1","botId":"b1","threadId":"t1","client":"desktop","voice":"marin","startedAt":1,"status":"live"}"""

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return when (request.path) {
                    "/api/live/call" -> json(liveCallCode, liveCallBody)
                    "/api/live/session" -> json(401, """{"error":"revoked"}""")
                    "/api/live/call/end" -> {
                        endGate?.await(5, TimeUnit.SECONDS)
                        json(endCode, endBody)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @AfterTest
    fun tearDown() {
        scope.cancel()
        server.shutdown()
        http.connectionPool.evictAll()
        http.dispatcher.executorService.shutdown()
    }

    @Test
    fun aFreshHelloReadsTheRunningCallIntoState() = runBlocking {
        liveCallBody = """{"call":$running}"""
        val session = session()
        try {
            session.connect()
            withTimeout(5_000) { session.state.first { it.liveCall?.callId == "c1" } }
            assertEquals(1, requests.count { it.path == "/api/live/call" })
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun anOlderComputerWithoutTheRouteLeavesTheStateAlone() = runBlocking {
        liveCallCode = 404
        liveCallBody = """{"error":"no route"}"""
        val session = session()
        try {
            session.connect()
            withTimeout(5_000) { session.status.first { it is Session.Status.Live } }
            withTimeout(5_000) { while (requests.none { it.path == "/api/live/call" }) delay(20) }
            delay(100)
            assertNull(session.state.value.liveCall)
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun aLateReadFromAnEarlierStreamDoesNotOverwriteTheCurrentOne() = runBlocking {
        val reads = AtomicInteger(0)
        val firstAnswer = CompletableDeferred<Unit>()
        val stale = LiveCallState("c1", "b1", "t1", "desktop", "marin", 1.0, LiveCallStatus.LIVE)
        val session = session(
            liveCallFn = {
                if (reads.incrementAndGet() == 1) {
                    firstAnswer.await()
                    stale
                } else {
                    null
                }
            },
        )
        try {
            session.connect()
            withTimeout(5_000) { while (reads.get() < 1) delay(10) }
            // A stream restart (a screen watcher here; a switch of computer
            // bumps the same generation) reads again, and finds no call.
            session.watchScreen("b1")
            withTimeout(5_000) { while (reads.get() < 2) delay(10) }
            delay(100)

            firstAnswer.complete(Unit)
            delay(300)
            assertNull(session.state.value.liveCall, "the first stream's late answer belongs to a stream that is gone")
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun a401OnStartRevokesTheSessionAndRethrows() = runBlocking<Unit> {
        val session = session()
        try {
            session.connect()
            withTimeout(5_000) { session.status.first { it is Session.Status.Live } }
            val refused = assertFailsWith<APIError.Status> { session.startLiveCall("b1", "t1", "v=0\r\n") }
            assertEquals(401, refused.code)
            withTimeout(5_000) { session.status.first { it is Session.Status.Unauthorized } }
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun endIsQuietWhenTheComputerNoLongerKnowsTheCall() = runBlocking {
        val session = session()
        try {
            session.connect()
            withTimeout(5_000) { session.status.first { it is Session.Status.Live } }
            withTimeout(5_000) { while (requests.none { it.path == "/api/live/call" }) delay(10) }
            val lookups = requests.count { it.path == "/api/live/call" }
            assertNull(session.endLiveCall("gone"))
            assertNull(session.actionErrorFlow.value)
            assertEquals(lookups, requests.count { it.path == "/api/live/call" }, "a call the line does not show needs no second look")
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun aFrameThatLandsWhileTheLookupIsOutWinsOverItsAnswer() = runBlocking {
        val lookupOut = CompletableDeferred<Unit>()
        val answer = CompletableDeferred<Unit>()
        val frames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
        val call = LiveCallState("c1", "b1", "t1", "desktop", "marin", 1.0, LiveCallStatus.LIVE)
        val session = session(
            liveCallFn = {
                lookupOut.complete(Unit)
                answer.await()
                null
            },
            frames = frames,
        )
        try {
            session.connect()
            withTimeout(5_000) { lookupOut.await() }
            withTimeout(5_000) { while (frames.subscriptionCount.value == 0) delay(10) }
            // A call starts while the lookup is out: its frame is newer than the lookup's answer.
            frames.emit(StreamFrame(Frame.LiveCall("b1", "t1", call), seq = 2))
            withTimeout(5_000) { session.state.first { it.liveCall?.callId == "c1" } }

            answer.complete(Unit)
            delay(300)
            assertEquals(call, session.state.value.liveCall, "the lookup's older null must not end the call the frame brought")
        } finally {
            session.disconnect()
        }
    }

    @Test
    fun aHangUpAnswerDoesNotOverwriteANewerCall() = runBlocking {
        val frames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
        val first = LiveCallState("c1", "b1", "t1", "desktop", "marin", 1.0, LiveCallStatus.LIVE)
        val second = first.copy(callId = "c2", client = "ios")
        val session = session(frames = frames)
        try {
            session.connect()
            withTimeout(5_000) { session.status.first { it is Session.Status.Live } }
            withTimeout(5_000) { while (requests.none { it.path == "/api/live/call" }) delay(10) }
            withTimeout(5_000) { while (frames.subscriptionCount.value == 0) delay(10) }
            frames.emit(StreamFrame(Frame.LiveCall("b1", "t1", first), seq = 2))
            withTimeout(5_000) { session.state.first { it.liveCall?.callId == "c1" } }

            endCode = 200
            endBody = """{"call":{"callId":"c1","botId":"b1","threadId":"t1","client":"desktop","voice":"marin","startedAt":1,"status":"ended","endReason":"hung-up"}}"""
            val gate = CountDownLatch(1).also { endGate = it }
            val hangUp = async { session.endLiveCall("c1") }
            withTimeout(5_000) { while (requests.none { it.path == "/api/live/call/end" }) delay(10) }
            // While the answer is on its way, c1 ends and another device starts c2.
            frames.emit(StreamFrame(Frame.LiveCall("b1", "t1", second), seq = 3))
            withTimeout(5_000) { session.state.first { it.liveCall?.callId == "c2" } }
            gate.countDown()

            assertEquals("c1", hangUp.await()?.callId)
            assertEquals(second, session.state.value.liveCall, "c1's answer is older news than the frame about c2")
        } finally {
            endGate?.countDown()
            session.disconnect()
        }
    }

    @Test
    fun aHangUpThatFindsTheCallAlreadyGoneReadsTheLineAgain() = runBlocking {
        val frames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
        val running = LiveCallState("c1", "b1", "t1", "desktop", "marin", 1.0, LiveCallStatus.LIVE)
        val session = session(frames = frames)
        try {
            session.connect()
            withTimeout(5_000) { session.status.first { it is Session.Status.Live } }
            withTimeout(5_000) { while (requests.none { it.path == "/api/live/call" }) delay(10) }
            withTimeout(5_000) { while (frames.subscriptionCount.value == 0) delay(10) }
            frames.emit(StreamFrame(Frame.LiveCall("b1", "t1", running), seq = 2))
            withTimeout(5_000) { session.state.first { it.liveCall?.callId == "c1" } }
            val lookups = requests.count { it.path == "/api/live/call" }

            // The frame that ended c1 was missed: the computer answers 404.
            assertNull(session.endLiveCall("c1"))
            assertEquals(lookups + 1, requests.count { it.path == "/api/live/call" }, "the line is read again")
            assertNull(session.state.value.liveCall, "and what the computer reports replaces the call that is gone")
            assertNull(session.actionErrorFlow.value)
        } finally {
            session.disconnect()
        }
    }

    private suspend fun session(
        liveCallFn: suspend (CompanionClient) -> LiveCallState? = { it.liveCall() },
        /** What the stream carries after its hello. */
        frames: Flow<StreamFrame> = emptyFlow(),
    ): Session {
        val connection = Connection(id = "fixture", name = "Fixture", host = "127.0.0.1", port = server.port)
        val session = Session(
            scope = scope,
            connectionStore = Store(connection),
            tokenStore = Tokens(),
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Fixture phone" },
            httpClient = http,
            eventsFn = { _, _, _ ->
                flow {
                    emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false)))
                    emitAll(frames)
                    awaitCancellation()
                }
            },
            hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
            instancesFn = { emptyList() },
            metadataFn = { throw APIError.Status(404) },
            liveCallFn = liveCallFn,
        )
        session.awaitRestored()
        return session
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

    private fun json(code: Int, body: String): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
