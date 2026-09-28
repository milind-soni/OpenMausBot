package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.openmausbot.companion.audio.PreviewAudioFocus
import com.openmausbot.companion.audio.VoiceNoteController
import com.openmausbot.companion.audio.VoiceNoteEngine
import com.openmausbot.companion.audio.VoiceNotePlayer
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.MessageImageAttachment
import com.openmausbot.companion.core.StreamFrame
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.awaitCancellation
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

/**
 * The wiring half of the voice-note bubble: a bot reply with a parked audio
 * attachment renders the play button, fetches the clip through the
 * authenticated file route on first play only, and pauses/resumes without a
 * second request.
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

    private class GrantingFocus : PreviewAudioFocus {
        override fun request(onInterrupted: () -> Unit): Boolean = true
        override fun abandon() = Unit
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
