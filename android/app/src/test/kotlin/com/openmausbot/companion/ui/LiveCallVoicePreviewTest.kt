package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.LiveCallTransport
import com.openmausbot.companion.audio.MicrophoneAccess
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.StreamFrame
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
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
 * The profile sheet's "Preview voice" while a Live call runs. A preview asks
 * for transient audio focus, and losing focus ends the call as "another app
 * took the audio", so the sheet keeps the preview off until the call is over
 * (as the chat keeps dictation off).
 *
 * The sheet reads its voice settings in a `LaunchedEffect`. Compose's default
 * test dispatcher is unconfined, so that effect would resume on OkHttp's
 * thread, where its state writes intermittently never reach the screen (about
 * one run in two, measured). A [StandardTestDispatcher] resumes it on the main
 * thread, as production does. Under it `performScrollTo` on the sheet never
 * settles, so the row is tapped through its click action instead.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalCoroutinesApi::class, ExperimentalTestApi::class)
class LiveCallVoicePreviewTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        effectContext = StandardTestDispatcher() + object : MotionDurationScale { override val scaleFactor = 0f },
    )

    private lateinit var server: MockWebServer
    private lateinit var scene: WiringScene
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private val fixture = bot().copy(threadId = "thread-bot-1")

    @Before
    fun startServer() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return when {
                    // Already attached in the 201: nothing here is about going live.
                    request.method == "POST" && request.path == "/api/live/session" ->
                        json(201, """{"call":${call("live")},"transport":{"type":"webrtc","sdp":"v=0\r\nanswer\r\n"}}""")
                    request.method == "POST" && request.path == "/api/live/call/end" -> json(200, """{"call":${call("ended")}}""")
                    request.path == "/api/live/call" -> json(200, """{"call":null}""")
                    request.path == "/api/instances" -> json(200, """{"instances":[]}""")
                    // A voice this computer can speak: the preview row is there to tap.
                    request.path == "/api/config" -> json(200, """{"tts":{"configured":true,"voice":"shared-voice"}}""")
                    request.path == "/api/tts/voices" -> json(200, """{"voices":[]}""")
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
    fun `a call keeps the voice preview off, since its audio focus would end the call`() {
        mount()
        val liveCalls = scene.environment.liveCalls
        val previewable = hasText("Preview voice") and isEnabled()
        compose.waitUntil(5_000) { compose.onAllNodes(previewable).fetchSemanticsNodes().isNotEmpty() }

        compose.runOnIdle { liveCalls.start(fixture.id, fixture.threadId, fixture.name, MicrophoneAccess { it(true) }) }
        compose.waitUntil(10_000) { compose.runOnIdle { liveCalls.state.value.phase } == LiveCallPhase.LIVE }
        compose.onNodeWithText(LiveCallRules.PREVIEW_DURING_CALL).assertExists()
        compose.onNodeWithText("Preview voice").assertIsNotEnabled()
        // The tap, through the row's click action (see above on scrolling),
        // which runs even on a disabled row: the sheet must refuse it itself.
        compose.onNodeWithText("Preview voice").performSemanticsAction(SemanticsActions.OnClick)
        // A preview starts by fetching its audio; give a fetch time to reach the server.
        val fetched = runCatching { compose.waitUntil(1_000) { requests.any { it.path == "/api/tts/speak" } } }.isSuccess
        assertFalse(fetched, "no preview is fetched, so none can take the audio")
        assertEquals(LiveCallPhase.LIVE, liveCalls.state.value.phase)

        compose.runOnIdle { liveCalls.hangUp() }
        compose.waitUntil(5_000) { compose.onAllNodes(previewable).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithText(LiveCallRules.PREVIEW_DURING_CALL).assertCountEquals(0)
    }

    private fun mount() {
        scene = WiringScene(
            connection = Connection(id = "live-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
            liveTransports = { SilentTransport() },
            events = {
                flow {
                    emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1))
                    awaitCancellation()
                }
            },
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    val state by scene.session.state.collectAsState()
                    if (state.bot(fixture.id) != null) AgentProfileSheet(fixture, onDismiss = {}, onOpenOverview = {})
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

    /** Media is not what this test is about: an offer, an answer and an open channel, nothing else. */
    private class SilentTransport : LiveCallTransport {
        private var listener: LiveCallTransport.Listener? = null

        override suspend fun offer(listener: LiveCallTransport.Listener): String {
            this.listener = listener
            return "v=0\r\noffer\r\n"
        }

        override suspend fun accept(answerSdp: String) {
            listener?.onChannelOpen()
        }
        override fun setMuted(muted: Boolean) = Unit
        override fun sendClose() = Unit
        override fun close() = Unit
    }
}
