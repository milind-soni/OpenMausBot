package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import com.openmausbot.companion.audio.LiveCallApi
import com.openmausbot.companion.audio.LiveCallLink
import com.openmausbot.companion.audio.LiveCallManager
import com.openmausbot.companion.audio.LiveCallTransport
import com.openmausbot.companion.audio.MicrophoneAccess
import com.openmausbot.companion.audio.PreviewAudioFocus
import com.openmausbot.companion.audio.VoiceNoteController
import com.openmausbot.companion.audio.VoiceNoteEngine
import com.openmausbot.companion.audio.VoiceNotePlayer
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.LiveCallStart
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.MessageImageAttachment
import com.openmausbot.companion.core.StreamFrame
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The wiring half of the voice-note bubble: a bot reply with a parked audio
 * attachment renders the play button, fetches the clip through the
 * authenticated file route on first play only, and pauses/resumes without a
 * second request. While this phone is on a Live call the play button is off,
 * with the reason under it: a note would take the call's audio focus, and
 * losing it ends the call.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VoiceNoteWiringTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val server = MockWebServer()
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private var scene: WiringScene? = null

    @After fun cleanup() {
        compose.runOnIdle { scene?.session?.disconnect() }
        server.shutdown()
    }

    @Test fun voiceNoteReplyFetchesOnFirstPlayAndPausesInPlace() {
        val audio = ByteArray(64) { it.toByte() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path != "/api/threads/first/messages/reply/file") return MockResponse().setResponseCode(404)
                requests.add(request)
                return MockResponse().setHeader("Content-Type", "audio/mpeg")
                    .setBody(Buffer().write(audio))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val player = VoiceNotePlayer(
            controller = VoiceNoteController(
                engineFactory = { StubEngine() },
                focus = GrantingFocus(),
            ),
        )
        val wiring = WiringScene(
            connection = Connection(id = "voice-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
            voiceNotes = player,
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        val message = Message(
            "reply",
            Message.Role.BOT,
            Message.Kind.TEXT,
            1.0,
            text = "Heard you",
            attachments = listOf(
                MessageImageAttachment(
                    "audio",
                    "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3",
                    "audio/mpeg",
                    4200.0,
                ),
            ),
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme {
                    MessageRow(Chat.BotChat(fixture), message)
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(5_000) { wiring.session.state.value.bot(fixture.id) != null }

        val playNode = compose.onNodeWithContentDescription("Play voice note")
        playNode.assertIsDisplayed()
        // The scrub bar stays dead until playback supplies a real length.
        compose.onNodeWithContentDescription("Seek voice note").assertIsNotEnabled()
        compose.waitUntil(10_000) {
            // The label flips to "Pause" the moment playback starts, so the
            // node must be re-resolved on every poll or the handle goes stale.
            // The queries run on every poll: they re-resolve the flipped
            // label and drive the frame sync that lets the download
            // coroutine resume. Clicking stops the moment the fetch is
            // recorded, and a click that parks the bubble early recovers
            // through its Retry row instead of dead-ending the poll.
            val plays = compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes()
            val retries = compose.onAllNodesWithText("Retry").fetchSemanticsNodes()
            if (requests.isEmpty()) {
                when {
                    plays.isNotEmpty() -> compose.onAllNodesWithContentDescription("Play voice note")[0].performClick()
                    retries.isNotEmpty() -> compose.onAllNodesWithText("Retry")[0].performClick()
                }
            }
            requests.size == 1 && player.playback.value?.playing == true
        }

        compose.onNodeWithContentDescription("Pause voice note").assertIsDisplayed()
        compose.onNodeWithContentDescription("Seek voice note").assertIsDisplayed()
        // The slider is seconds-based: its range must span the measured duration,
        // not the 0f..1f default that pins every scrub inside the first second.
        val seek = compose.onNodeWithContentDescription("Seek voice note")
        seek.assertIsEnabled()
        val seekRange = seek.fetchSemanticsNode().config.getOrNull(SemanticsProperties.ProgressBarRangeInfo)?.range
        assertEquals(0f, seekRange?.start)
        assertEquals(4f, seekRange?.endInclusive)
        // The wire said 4200ms; the engine measured 4000ms, which wins once known.
        compose.onNodeWithText("0:00 / 0:04").assertIsDisplayed()

        compose.waitUntil(5_000) {
            if (compose.onAllNodesWithContentDescription("Pause voice note").fetchSemanticsNodes().isNotEmpty()) {
                compose.onNodeWithContentDescription("Pause voice note").performClick()
            }
            player.playback.value?.playing == false
        }
        compose.onNodeWithContentDescription("Play voice note").assertIsDisplayed()

        // Resume replays the bubble's own bytes; the file route is hit exactly once.
        compose.waitUntil(5_000) {
            // Same discipline as the first-play poll: query every poll for
            // the frame sync, click only while the row still wants it, and
            // recover a parked retry row the same way.
            val plays = compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes()
            val retries = compose.onAllNodesWithText("Retry").fetchSemanticsNodes()
            if (player.playback.value?.playing != true) {
                when {
                    plays.isNotEmpty() -> compose.onAllNodesWithContentDescription("Play voice note")[0].performClick()
                    retries.isNotEmpty() -> compose.onAllNodesWithText("Retry")[0].performClick()
                }
            }
            player.playback.value?.playing == true
        }
        assertEquals(1, requests.size)

        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("Bearer device-token", request.getHeader("Authorization"))
        assertEquals(
            "/attachments/123e4567-e89b-12d3-a456-426614174000.mp3",
            CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject["path"]?.jsonPrimitive?.content,
        )
    }

    @Test fun lateFailureParksOnlyTheClipThatFailed() {
        val audio = ByteArray(64) { it.toByte() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: return MockResponse().setResponseCode(404)
                if (path != "/api/threads/first/messages/a/file" &&
                    path != "/api/threads/first/messages/b/file"
                ) return MockResponse().setResponseCode(404)
                requests.add(request)
                return MockResponse().setHeader("Content-Type", "audio/mpeg")
                    .setBody(Buffer().write(audio))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        var engine: StubEngine? = null
        val player = VoiceNotePlayer(
            controller = VoiceNoteController(
                engineFactory = { StubEngine().also { engine = it } },
                focus = GrantingFocus(),
            ),
        )
        val wiring = WiringScene(
            connection = Connection(id = "voice-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
            voiceNotes = player,
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        fun note(id: String) = Message(
            id,
            Message.Role.BOT,
            Message.Kind.TEXT,
            1.0,
            text = "Heard you",
            attachments = listOf(
                MessageImageAttachment(
                    "audio",
                    "/attachments/note-$id.mp3",
                    "audio/mpeg",
                    4200.0,
                ),
            ),
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme {
                    Column {
                        MessageRow(Chat.BotChat(fixture), note("a"))
                        MessageRow(Chat.BotChat(fixture), note("b"))
                    }
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(5_000) { wiring.session.state.value.bot(fixture.id) != null }

        // Play only the first bubble; the guard keeps the poll from ever
        // starting the second one once the first label flips to Pause.
        compose.waitUntil(10_000) {
            // Query every poll so the download coroutine gets its frame sync;
            // click only while no fetch has been recorded so a late poll can
            // never start the sibling row. The first bubble's Retry control
            // wins over any Play node: after a failed download its sibling
            // still shows Play, and clicking that would start the wrong note.
            val plays = compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes()
            val pauses = compose.onAllNodesWithContentDescription("Pause voice note").fetchSemanticsNodes()
            val retries = compose.onAllNodesWithText("Retry").fetchSemanticsNodes()
            if (requests.isEmpty() &&
                pauses.isEmpty() &&
                (plays.isNotEmpty() || retries.isNotEmpty())
            ) {
                when {
                    retries.isNotEmpty() -> compose.onAllNodesWithText("Retry")[0].performClick()
                    plays.isNotEmpty() -> compose.onAllNodesWithContentDescription("Play voice note")[0].performClick()
                }
            }
            player.playback.value?.playing == true
        }
        // The fetch that started playback belongs to the first bubble's message.
        assertEquals("/api/threads/first/messages/a/file", requests.single().path)

        // A late decode failure parks only the clip that actually failed.
        compose.runOnIdle { engine?.onError?.invoke() }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("Voice note unavailable").fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(1, requests.size)
        assertEquals(1, compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithContentDescription("Pause voice note").fetchSemanticsNodes().size)
    }

    @Test fun aLiveCallKeepsVoiceNotesFromPlayingAndSaysWhy() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                // Only the clip's fetch counts; the session reads other routes on connect.
                if (request.path?.endsWith("/file") != true) return MockResponse().setResponseCode(404)
                requests.add(request)
                return MockResponse().setHeader("Content-Type", "audio/mpeg").setBody(Buffer().write(ByteArray(64)))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        val player = VoiceNotePlayer(
            controller = VoiceNoteController(
                engineFactory = { StubEngine() },
                focus = GrantingFocus(),
            ),
        )
        val wiring = WiringScene(
            connection = Connection(id = "voice-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
            voiceNotes = player,
            liveTransports = { SilentTransport() },
            liveApi = CallingComputer(),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        val message = Message(
            "reply",
            Message.Role.BOT,
            Message.Kind.TEXT,
            1.0,
            text = "Heard you",
            attachments = listOf(MessageImageAttachment("audio", "/attachments/note-call.mp3", "audio/mpeg", 4200.0)),
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme {
                    MessageRow(Chat.BotChat(fixture), message)
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(5_000) { wiring.session.state.value.bot(fixture.id) != null }
        compose.onNodeWithContentDescription("Play voice note").assertIsEnabled()
        compose.onAllNodesWithText(LiveCallRules.VOICE_NOTE_DURING_CALL).assertCountEquals(0)

        val liveCalls = wiring.environment.liveCalls
        compose.runOnIdle { liveCalls.start(fixture.id, fixture.threadId, fixture.name, MicrophoneAccess { it(true) }) }
        compose.waitUntil(5_000) { compose.runOnIdle { liveCalls.state.value.holdsMedia } }
        compose.onNodeWithContentDescription("Play voice note").assertIsNotEnabled()
        compose.onNodeWithText(LiveCallRules.VOICE_NOTE_DURING_CALL).assertIsDisplayed()

        // A tap that reaches the click action anyway: the bubble refuses it itself.
        compose.onNodeWithContentDescription("Play voice note").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        assertTrue(requests.isEmpty(), "nothing is fetched, so nothing can take the call's audio")
        assertNull(player.playback.value)

        compose.runOnIdle { liveCalls.hangUp() }
        compose.waitUntil(5_000) { compose.runOnIdle { !liveCalls.state.value.holdsMedia } }
        compose.onNodeWithContentDescription("Play voice note").assertIsEnabled()
        compose.onAllNodesWithText(LiveCallRules.VOICE_NOTE_DURING_CALL).assertCountEquals(0)
    }

    /**
     * The race the play button alone cannot stop: a note tapped before the
     * call, whose download finishes after the call took the audio. The player
     * refuses it (it would take the call's audio focus, which ends the call),
     * the clip waits, ready, with the reason under it, and plays once the call
     * is over, from the bytes it already has.
     */
    @Test fun aNoteWhoseDownloadFinishesAfterACallStartedWaitsForTheCallToEnd() {
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.endsWith("/file") != true) return MockResponse().setResponseCode(404)
                requests.add(request)
                // Slow network: the clip arrives only once the call has begun.
                release.await(10, TimeUnit.SECONDS)
                return MockResponse().setHeader("Content-Type", "audio/mpeg").setBody(Buffer().write(ByteArray(64)))
            }
        }
        server.start()
        val fixture = bot().copy(threadId = "first", messages = emptyList())
        var calls: LiveCallManager? = null
        val focus = CallAwareFocus { calls?.state?.value?.holdsMedia == true }
        val player = VoiceNotePlayer(controller = VoiceNoteController(engineFactory = { StubEngine() }, focus = focus))
        val wiring = WiringScene(
            connection = Connection(id = "voice-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
            voiceNotes = player,
            liveTransports = { SilentTransport() },
            liveApi = CallingComputer(),
        ) { flow { emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1)); awaitCancellation() } }
        scene = wiring
        val liveCalls = wiring.environment.liveCalls
        calls = liveCalls
        val message = Message(
            "reply",
            Message.Role.BOT,
            Message.Kind.TEXT,
            1.0,
            text = "Heard you",
            attachments = listOf(MessageImageAttachment("audio", "/attachments/note-slow.mp3", "audio/mpeg", 4200.0)),
        )
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides wiring.environment) {
                CompanionTheme {
                    MessageRow(Chat.BotChat(fixture), message)
                }
            }
        }
        compose.runOnIdle { wiring.session.connect() }
        compose.waitUntil(5_000) { wiring.session.state.value.bot(fixture.id) != null }

        // Tapped before the call: the clip starts to download.
        compose.waitUntil(10_000) {
            if (requests.isEmpty() && compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes().isNotEmpty()) {
                compose.onAllNodesWithContentDescription("Play voice note")[0].performClick()
            }
            requests.isNotEmpty()
        }

        // The call takes the audio while the clip is still on its way.
        compose.runOnIdle { liveCalls.start(fixture.id, fixture.threadId, fixture.name, MicrophoneAccess { it(true) }) }
        compose.waitUntil(5_000) { compose.runOnIdle { liveCalls.state.value.holdsMedia } }
        release.countDown()

        // The clip lands: the player refuses it; nothing plays and nothing failed.
        compose.waitUntil(10_000) {
            // Queried on every poll: that drives the frame sync the download's
            // coroutine resumes on (see the first test).
            val failed = compose.onAllNodesWithText("Voice note unavailable").fetchSemanticsNodes().isNotEmpty()
            focus.checks > 0 || player.playback.value != null || failed
        }
        compose.waitForIdle()
        assertNull(player.playback.value, "the note did not take the call's audio")
        assertEquals(0, focus.requests, "nothing asked for the audio focus")
        compose.onAllNodesWithText("Voice note unavailable").assertCountEquals(0)
        compose.onNodeWithText(LiveCallRules.VOICE_NOTE_DURING_CALL).assertIsDisplayed()
        compose.onNodeWithContentDescription("Play voice note").assertIsNotEnabled()

        // Once the call is over the clip plays, without a second fetch.
        compose.runOnIdle { liveCalls.hangUp() }
        compose.waitUntil(5_000) { compose.runOnIdle { !liveCalls.state.value.holdsMedia } }
        compose.waitUntil(5_000) {
            if (player.playback.value?.playing != true && compose.onAllNodesWithContentDescription("Play voice note").fetchSemanticsNodes().isNotEmpty()) {
                compose.onAllNodesWithContentDescription("Play voice note")[0].performClick()
            }
            player.playback.value?.playing == true
        }
        assertEquals(1, requests.size, "played from the clip it already had")
    }

    /** The computer's side of a call: it answers at once, and nothing about it is under test here. */
    private class CallingComputer : LiveCallApi {
        override val serverCall = MutableStateFlow<LiveCallState?>(null)
        override val link = MutableStateFlow(LiveCallLink(computerId = "voice-fixture", signedIn = true))

        override suspend fun start(botId: String, threadId: String, sdp: String): LiveCallStart = LiveCallStart.Started(
            LiveCallState("c1", botId, threadId, "android", "marin", 1.0, LiveCallStatus.CONNECTING),
            answerSdp = "v=0\r\nanswer\r\n",
        )

        override suspend fun end(callId: String) = Unit
    }

    private class SilentTransport : LiveCallTransport {
        override suspend fun offer(listener: LiveCallTransport.Listener): String = "v=0\r\noffer\r\n"
        override suspend fun accept(answerSdp: String) = Unit
        override fun setMuted(muted: Boolean) = Unit
        override fun sendClose() = Unit
        override fun close() = Unit
    }

    private class GrantingFocus : PreviewAudioFocus {
        override fun request(onInterrupted: () -> Unit): Boolean = true
        override fun abandon() = Unit
    }

    /** Grants the focus, and knows, as the app's focus gate does, whether this phone's Live call holds the audio. */
    private class CallAwareFocus(private val callHolds: () -> Boolean) : PreviewAudioFocus {
        @Volatile var requests = 0
        @Volatile var checks = 0
        override fun request(onInterrupted: () -> Unit): Boolean {
            requests += 1
            return true
        }
        override fun abandon() = Unit
        override val heldByLiveCall: Boolean
            get() {
                checks += 1
                return callHolds()
            }
    }

    private class StubEngine : VoiceNoteEngine {
        override var onCompletion: (() -> Unit)? = null
        override var onError: (() -> Unit)? = null
        override fun start(data: ByteArray, startPositionMs: Long): Boolean = true
        override fun pause() = Unit
        override fun resume() = Unit
        override fun seekTo(positionMs: Long) = Unit
        override fun positionMs(): Long = 0L
        override fun durationMs(): Long = 4000L
        override fun stop() = Unit
        override fun release() = Unit
    }
}
