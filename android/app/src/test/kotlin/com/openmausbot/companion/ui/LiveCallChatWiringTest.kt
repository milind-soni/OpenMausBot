package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.LiveCallTransport
import com.openmausbot.companion.audio.MicrophoneAccess
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.StreamFrame
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The chat screen end to end, with only the WebRTC transport faked: the phone
 * button starts a call through the real manager, the real Session and a
 * loopback server; the bar says "Connecting…" until the computer reports the
 * call attached and the data channel is open, then shows the bot's name; Hang
 * up ends it on the server. The phone button is hidden while this phone is on
 * a call and while the computer reports one running from another device. A
 * call the computer reports on this chat shows as the remote bar. A call
 * keeps the microphone wherever the person goes: another chat's dictation
 * stays off, since its audio focus would end the call.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class LiveCallChatWiringTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )

    private lateinit var server: MockWebServer
    private lateinit var scene: WiringScene
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private val frames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 16)
    private val transport = FakeTransport()
    private val fixture = bot().copy(
        threadId = "thread-bot-1",
        messages = listOf(Message("m1", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "what time is it", via = "call")),
    )
    private val nova = bot(id = "bot-2", name = "Nova")
    /** Scout's chat, longer than the screen, ending on the answer to a spoken request. */
    private val longChat = fixture.copy(
        messages = (1..14).map { index ->
            if (index % 2 == 1) {
                Message("q$index", Message.Role.USER, Message.Kind.TEXT, index.toDouble(), text = "Where are we with release step $index?")
            } else {
                Message("a$index", Message.Role.BOT, Message.Kind.TEXT, index.toDouble(), text = "Step $index is done: the branch is cut, the notes are drafted and the nightly build passed.")
            }
        } + listOf(
            Message("q15", Message.Role.USER, Message.Kind.TEXT, 15.0, text = "What is left on the release checklist?", via = "call"),
            Message("a16", Message.Role.BOT, Message.Kind.TEXT, 16.0, text = NEWEST),
        ),
    )

    /** Set to hold the computer's answer to a hang-up, so the bar stays on "Hanging up…". */
    @Volatile private var endGate: CountDownLatch? = null

    @Before
    fun startServer() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return when {
                    request.method == "POST" && request.path == "/api/live/session" ->
                        json(201, """{"call":${call("connecting")},"transport":{"type":"webrtc","sdp":"v=0\r\nanswer\r\n"}}""")
                    request.method == "POST" && request.path == "/api/live/call/end" -> {
                        endGate?.await(5, TimeUnit.SECONDS)
                        json(200, """{"call":${call("ended")}}""")
                    }
                    request.path == "/api/live/call" -> json(200, """{"call":null}""")
                    request.path == "/api/instances" -> json(200, """{"instances":[]}""")
                    request.path?.startsWith("/api/threads/") == true -> json(200, """{"messages":[],"hasMore":false}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stopServer() {
        if (::scene.isInitialized) scene.session.disconnect()
        server.shutdown()
    }

    @Test
    fun `the phone button starts a call, the bar shows it and Hang up ends it on the Mac`() {
        mount { chatScreen() }
        compose.onNodeWithText("via call").assertIsDisplayed()

        compose.onNodeWithContentDescription("Call Scout").performClick()
        compose.waitUntil(10_000) { requests.any { it.path == "/api/live/session" } }
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        attach()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Live with Scout", substring = true).fetchSemanticsNodes().isNotEmpty() }

        val start = requests.first { it.path == "/api/live/session" }
        val body = CompanionJson.parseToJsonElement(start.body.readUtf8()).jsonObject
        assertEquals("android", body.getValue("client").jsonPrimitive.content)
        assertEquals("thread-bot-1", body.getValue("threadId").jsonPrimitive.content)
        assertEquals(FakeTransport.OFFER, body.getValue("sdp").jsonPrimitive.content)
        assertEquals("v=0\r\nanswer\r\n", transport.accepted)
        compose.onNodeWithContentDescription("Call Scout").assertDoesNotExist()

        compose.onNodeWithContentDescription("Hang up").performClick()
        compose.waitUntil(5_000) { requests.any { it.path == "/api/live/call/end" } }
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("Live call").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Call Scout").assertIsEnabled()
        assertEquals(1, transport.closeSent)
    }

    /**
     * A phone has no Live switch: its first call is where Live is turned on,
     * so it says first what a call sends to OpenAI, with Start call and
     * Cancel. Cancel starts nothing and asks again on the next tap; Start call
     * starts the call, and the phone does not ask again.
     */
    @Test
    fun `a phone's first call says what it sends to OpenAI first, once`() {
        mount(disclosureShown = false) { chatScreen() }
        compose.onNodeWithContentDescription("Call Scout").performClick()
        compose.onNodeWithText(LiveCallRules.DISCLOSURE).assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        compose.onAllNodesWithText(LiveCallRules.DISCLOSURE).assertCountEquals(0)
        assertTrue(requests.none { it.path == "/api/live/session" }, "Cancel starts nothing")
        assertEquals(0, transport.offers)

        compose.onNodeWithContentDescription("Call Scout").performClick()
        compose.onNodeWithText(LiveCallRules.DISCLOSURE).assertIsDisplayed()
        compose.onNodeWithText(LiveCallRules.START_CALL).performClick()
        compose.waitUntil(10_000) { requests.any { it.path == "/api/live/session" } }
        compose.onAllNodesWithText(LiveCallRules.DISCLOSURE).assertCountEquals(0)

        compose.onNodeWithContentDescription("Hang up").performClick()
        compose.waitUntil(5_000) { requests.any { it.path == "/api/live/call/end" } }
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("Call Scout").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Call Scout").performClick()
        compose.waitUntil(10_000) { requests.count { it.path == "/api/live/session" } == 2 }
        compose.onAllNodesWithText(LiveCallRules.DISCLOSURE).assertCountEquals(0)
    }

    @Test
    fun `a call from the Mac shows as a remote bar with Hang up`() {
        mount { chatScreen() }
        // A replay-0 flow drops what is emitted before the stream subscribes.
        compose.waitUntil(5_000) { frames.subscriptionCount.value > 0 }
        compose.runOnIdle {
            frames.tryEmit(
                StreamFrame(
                    Frame.LiveCall(
                        "bot-1", "thread-bot-1",
                        LiveCallState("c7", "bot-1", "thread-bot-1", "desktop", "marin", System.currentTimeMillis().toDouble(), LiveCallStatus.LIVE),
                    ),
                    seq = 2,
                ),
            )
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("From your computer").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithContentDescription("Mute").assertCountEquals(0)
        // The line is busy: a call from here would only be refused.
        compose.onNodeWithContentDescription("Call Scout").assertDoesNotExist()

        compose.onNodeWithText("Hang up").performClick()
        compose.waitUntil(5_000) { requests.any { it.path == "/api/live/call/end" } }
        val end = requests.first { it.path == "/api/live/call/end" }
        assertEquals("c7", CompanionJson.parseToJsonElement(end.body.readUtf8()).jsonObject.getValue("callId").jsonPrimitive.content)
        assertEquals(0, transport.offers, "another device's call never touches this phone's media")
    }

    /**
     * The bar sits under the transcript and changes height: one line while it
     * connects, a caption line more once the call is live, one line again
     * while it hangs up; the remote bar comes with a second line of its own.
     * Each time, the chat's newest message stays whole above the bar.
     */
    @Test
    @Config(qualifiers = "w411dp-h891dp")
    fun `the newest message stays above the bar as the bar grows and shrinks`() {
        mount(bots = listOf(longChat)) { chatScreen(longChat) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(NEWEST, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

        compose.onNodeWithContentDescription("Call Scout").performClick()
        compose.waitUntil(10_000) { requests.any { it.path == "/api/live/session" } }
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        assertNewestAbove("Live call")

        attach()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Live with Scout", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.runOnIdle { transport.say("""{"type":"session.output_transcript.delta","delta":"Three things are left."}""") }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Three things are left.").fetchSemanticsNodes().isNotEmpty() }
        assertNewestAbove("Live call")

        endGate = CountDownLatch(1)
        compose.onNodeWithContentDescription("Hang up").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Hanging up…").fetchSemanticsNodes().isNotEmpty() }
        assertNewestAbove("Live call")
        endGate?.countDown()
        compose.waitUntil(5_000) { compose.onAllNodesWithContentDescription("Live call").fetchSemanticsNodes().isEmpty() }

        compose.runOnIdle {
            frames.tryEmit(
                StreamFrame(
                    Frame.LiveCall(
                        "bot-1", "thread-bot-1",
                        LiveCallState("c7", "bot-1", "thread-bot-1", "desktop", "marin", System.currentTimeMillis().toDouble(), LiveCallStatus.LIVE),
                    ),
                    seq = 4,
                ),
            )
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("From your computer").fetchSemanticsNodes().isNotEmpty() }
        assertNewestAbove("Live call on another device")
    }

    @Test
    fun `a call in one chat keeps dictation off in every other chat`() {
        mount(bots = listOf(fixture, nova)) { chatScreen(nova) }
        val liveCalls = scene.environment.liveCalls
        val dictation = scene.environment.dictation
        // The call runs on Scout's chat; the person has since opened Nova's.
        compose.runOnIdle { liveCalls.start(fixture.id, fixture.threadId, fixture.name, MicrophoneAccess { it(true) }) }
        compose.waitUntil(10_000) { requests.any { it.path == "/api/live/session" } }
        attach()
        // Reads through runOnIdle: the 201 lands on the main looper, which only
        // an idle sync drains here (no node query in the condition would).
        compose.waitUntil(10_000) { compose.runOnIdle { liveCalls.state.value.phase } == LiveCallPhase.LIVE }
        compose.onNodeWithContentDescription("Call Nova").assertDoesNotExist()

        compose.onNodeWithContentDescription("Start dictation").performClick()
        compose.waitForIdle()
        assertFalse(dictation.locksComposer(), "dictation must not start while a call holds the microphone")
        assertNull(dictation.error.value, "the tap must not reach dictation")
        assertEquals(LiveCallPhase.LIVE, liveCalls.state.value.phase)
        assertTrue(requests.none { it.path == "/api/live/call/end" }, "the call is still up")

        // Once the call is over, the same tap reaches dictation (which the
        // scene denies the microphone, so it settles on the denied notice).
        compose.runOnIdle { liveCalls.hangUp() }
        compose.waitUntil(5_000) { compose.runOnIdle { liveCalls.state.value.phase } == LiveCallPhase.IDLE }
        compose.onNodeWithContentDescription("Start dictation").performClick()
        compose.waitUntil(5_000) { compose.runOnIdle { dictation.error.value } != null }
    }

    /** The computer's `live` frame for this phone's call, once its sideband has attached. */
    private fun attach() {
        compose.waitUntil(5_000) { frames.subscriptionCount.value > 0 }
        compose.runOnIdle {
            frames.tryEmit(
                StreamFrame(
                    Frame.LiveCall(
                        "bot-1", "thread-bot-1",
                        LiveCallState("c1", "bot-1", "thread-bot-1", "android", "marin", System.currentTimeMillis().toDouble(), LiveCallStatus.LIVE),
                    ),
                    seq = 3,
                ),
            )
        }
    }

    /**
     * The newest message is whole above the bar [description] names: its last
     * line ends at or above the bar's top. Its own size and place, not what
     * the list's clip leaves of it.
     */
    private fun assertNewestAbove(description: String) {
        compose.waitForIdle()
        val newest = compose.onNodeWithText(NEWEST, useUnmergedTree = true).fetchSemanticsNode()
        val bottom = newest.positionInRoot.y + newest.size.height
        val bar = compose.onNodeWithContentDescription(description).fetchSemanticsNode().boundsInRoot
        assertTrue(bottom <= bar.top, "the newest message runs under the bar: it ends at $bottom, the bar starts at ${bar.top}")
    }

    @Composable
    private fun chatScreen(target: Bot = fixture) {
        ChatScreen(
            destination = Destination.Chat(ChatTarget.Bot(target.id, target.threadId)),
            onResolved = {},
            onBack = {},
            onOpenComputer = {},
            onOpenOverview = {},
        )
    }

    /** [disclosureShown]: this phone made a Live call before (the first-call disclosure is behind it). */
    private fun mount(bots: List<Bot> = listOf(fixture), disclosureShown: Boolean = true, content: @Composable () -> Unit) {
        scene = WiringScene(
            connection = Connection(id = "live-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(bots, emptyList()),
            liveTransports = { transport },
            liveDisclosureShown = disclosureShown,
            events = {
                flow {
                    emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1))
                    emitAll(frames)
                }
            },
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    val state by scene.session.state.collectAsState()
                    if (state.bot(fixture.id) != null) content()
                }
            }
        }
        compose.runOnIdle { scene.session.connect() }
        compose.waitUntil(5_000) { scene.session.state.value.bot(fixture.id) != null }
        compose.waitForIdle()
    }

    private fun call(status: String): String =
        """{"callId":"c1","botId":"bot-1","threadId":"thread-bot-1","client":"android","voice":"marin","startedAt":${System.currentTimeMillis()},"status":"$status"}"""

    private fun json(code: Int, body: String): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    /**
     * The manager test's fake, repeated: fakes stay private to the test that
     * owns them. Its data channel opens as the answer goes in, as a working
     * connection's does.
     */
    private class FakeTransport : LiveCallTransport {
        var accepted: String? = null
        var offers = 0
        var closeSent = 0
        private var listener: LiveCallTransport.Listener? = null

        override suspend fun offer(listener: LiveCallTransport.Listener): String {
            offers += 1
            this.listener = listener
            return OFFER
        }

        override suspend fun accept(answerSdp: String) {
            accepted = answerSdp
            listener?.onChannelOpen()
        }

        /** A frame on the data channel, as OpenAI would send it. */
        fun say(json: String) {
            listener?.onMessage(json)
        }

        override fun setMuted(muted: Boolean) = Unit

        override fun sendClose() {
            closeSent += 1
        }

        override fun close() = Unit

        companion object {
            const val OFFER = "v=0\r\noffer\r\n"
        }
    }

    private companion object {
        const val NEWEST = "Three things: update the changelog, tag the release, and post the notes."
    }
}
