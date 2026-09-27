package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmausbot.companion.audio.LiveCallApi
import com.openmausbot.companion.audio.LiveCallLink
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.LiveCallTransport
import com.openmausbot.companion.audio.MicrophoneAccess
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.LiveCallStart
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The thin strip that follows a call to every other screen: tapping it goes
 * back to the call's chat, Hang up hangs up without going anywhere, and the
 * call's own chat — which has the bar — never shows it. The host reads the
 * real manager, so a call that outlives its chat (Computer pushed over it)
 * keeps its clock in the banner.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LiveCallBannerTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun tappingTheBannerOpensTheChatAndHangUpOnlyHangsUp() {
        val taps = mutableListOf<String>()
        compose.setContent {
            CompanionTheme(darkTheme = false) {
                LiveCallBanner(title = "Live with Ada · 0:05", onOpen = { taps += "open" }, onHangUp = { taps += "hangup" })
            }
        }
        compose.onNodeWithText("Live with Ada · 0:05").assertIsDisplayed().performClick()
        compose.onNodeWithText("Hang up").performClick()
        assertEquals(listOf("open", "hangup"), taps)
    }

    @Test
    fun theCallsOwnChatHidesTheBanner() {
        assertTrue(LiveCallBannerRules.onCallsChat(Destination.Chat(ChatTarget.Bot("b1", "t1")), "t1"))
        assertTrue(LiveCallBannerRules.onCallsChat(Destination.Thread("t1"), "t1"))
        assertFalse(LiveCallBannerRules.onCallsChat(Destination.Chat(ChatTarget.Bot("b1", "t2")), "t1"), "another task of the same bot")
        assertFalse(LiveCallBannerRules.onCallsChat(Destination.Roster, "t1"))
        assertFalse(LiveCallBannerRules.onCallsChat(Destination.Computer("b1"), "t1"), "Computer over the chat still shows the banner")
    }

    @Test
    fun `the banner shows on other screens while the call runs`() {
        val api = FakeApi()
        // The call went live 90 s ago on this phone's clock: the clock reads
        // "1:" for a full 30 s of wall time around the assertion.
        val scene = WiringScene(
            liveTransports = { FakeTransport() },
            liveApi = api,
            liveClock = { System.currentTimeMillis() - 90_000 },
        )
        val liveCalls = scene.environment.liveCalls
        val chat = Destination.Chat(ChatTarget.Bot("b1", "t1"))
        // The person pushed Computer over the call's chat, which left composition.
        val navigator = CompanionNavigator(listOf(Destination.Roster, chat, Destination.Computer("b1")))
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) { LiveCallBannerHost(navigator) }
            }
        }
        compose.onAllNodesWithText("Hang up").assertCountEquals(0)

        compose.runOnIdle { liveCalls.start("b1", "t1", "Ada", MicrophoneAccess { it(true) }) }
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        // The computer attaches its side; the transport opened its channel with the answer.
        compose.runOnIdle { api.serverCall.value = api.call(LiveCallStatus.LIVE) }
        compose.waitUntil(5_000) { compose.runOnIdle { liveCalls.state.value.phase } == LiveCallPhase.LIVE }
        // The clock counts from the moment the call went live, not from when this screen appeared.
        compose.onNodeWithText("Live with Ada · 1:", substring = true).assertIsDisplayed().performClick()
        assertEquals(chat, navigator.current, "tapping it opens the call's chat")
        compose.onAllNodesWithText("Hang up").assertCountEquals(0)
        assertEquals(LiveCallPhase.LIVE, liveCalls.state.value.phase, "opening the chat leaves the call up")

        compose.runOnIdle { navigator.pop() }
        val answer = CompletableDeferred<Unit>()
        api.endGate = answer
        compose.onNodeWithText("Hang up").performClick()
        // Until the computer answers, the banner says so, and has nothing left to tap but itself.
        compose.onNodeWithText("Hanging up…").assertIsDisplayed()
        compose.onAllNodesWithText("Hang up").assertCountEquals(0)
        assertEquals(LiveCallPhase.ENDING, liveCalls.state.value.phase)
        assertEquals(listOf("c1"), api.ends, "Hang up tells the computer")

        compose.runOnIdle { answer.complete(Unit) }
        compose.waitForIdle()
        assertEquals(LiveCallPhase.IDLE, liveCalls.state.value.phase)
        compose.onAllNodesWithText("Hanging up…").assertCountEquals(0)
        compose.onAllNodesWithText("Live with", substring = true).assertCountEquals(0)
        assertEquals(Destination.Computer("b1"), navigator.current, "Hang up goes nowhere")
    }

    /** The computer's side, answering at once unless [endGate] holds the hang-up; the manager test's fake, trimmed. */
    private class FakeApi : LiveCallApi {
        val ends = mutableListOf<String>()
        var endGate: CompletableDeferred<Unit>? = null
        override val serverCall = MutableStateFlow<LiveCallState?>(null)
        override val link = MutableStateFlow(LiveCallLink(computerId = "computer-1", signedIn = true))

        fun call(status: LiveCallStatus) = LiveCallState("c1", "b1", "t1", "android", "marin", 1.0, status)

        override suspend fun start(botId: String, threadId: String, sdp: String): LiveCallStart =
            LiveCallStart.Started(call(LiveCallStatus.CONNECTING), answerSdp = "v=0\r\nanswer\r\n")

        override suspend fun end(callId: String) {
            ends += callId
            endGate?.await()
        }
    }

    /** Opens its data channel as the answer goes in, as a working connection does. */
    private class FakeTransport : LiveCallTransport {
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
