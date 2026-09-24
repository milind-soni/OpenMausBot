package com.openmausbot.companion.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.lifecycleScope
import com.openmausbot.companion.core.ActivityDetail
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Compaction
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.RuntimeEvent
import com.openmausbot.companion.core.SearchHit
import com.openmausbot.companion.core.StreamFrame
import com.openmausbot.companion.core.target
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
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

/** Real chat UI and session, confined to a synthetic fleet and loopback server. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class TranscriptPresentationTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )
    private lateinit var server: MockWebServer
    private lateinit var scene: WiringScene
    private val rawWebhook = "[AUTHENTICATED WEBHOOK TASK]\nTriage the build failure.\n[/AUTHENTICATED WEBHOOK TASK]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nReceived: now\nDelivery ID: build-418\nEvent: build.failed\n\n{\"service\":\"checkout\"}\n[/UNTRUSTED WEBHOOK EVENT DATA]"
    private val messages = listOf(Message("webhook", Message.Role.USER, Message.Kind.TEXT, 1000.0, text = rawWebhook)) +
        CompanionJson.decodeFromString<List<Message>>("""
            [
              {"id":"progress","role":"bot","kind":"text","at":2000,"text":"Let me inspect the build logs.","turnId":"turn"},
              {"id":"progress2","role":"bot","kind":"text","at":3000,"text":"I found the failing check.","turnId":"turn"},
              {"id":"answer","role":"bot","kind":"text","at":5000,"text":"A dependency is missing.","turnId":"turn","turnTerminal":true}
            ]
        """)

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody(if (request.path == "/api/instances") "{\"instances\":[]}" else "{\"messages\":[],\"hasMore\":false}")
        }
        server.start()
    }

    @After
    fun stop() {
        if (::scene.isInitialized) scene.session.disconnect()
        server.shutdown()
    }

    @Test
    fun completedNarrationAndWebhookPayloadStartCollapsedAndExpandOnDemand() {
        mount(ActivityDetail.HIDDEN)
        screenshot("transcript-collapsed")
        compose.onNodeWithText("Worked for 4s").assertIsDisplayed()
        compose.onNodeWithText("Let me inspect the build logs.").assertDoesNotExist()
        compose.onNodeWithText("I found the failing check.").assertDoesNotExist()
        compose.onNodeWithText("A dependency is missing.").assertIsDisplayed()
        compose.onNodeWithText("Webhook task").assertIsDisplayed()
        compose.onNodeWithText("Triage the build failure.").assertIsDisplayed()
        compose.onNodeWithText("Delivery ID", substring = true).assertDoesNotExist()
        compose.onNodeWithText("AUTHENTICATED WEBHOOK", substring = true).assertDoesNotExist()
        compose.onNodeWithText("checkout", substring = true).assertDoesNotExist()

        compose.onNodeWithText("Worked for 4s").performClick()
        compose.onNodeWithText("Let me inspect the build logs.").assertIsDisplayed()
        compose.onNodeWithText("I found the failing check.").assertIsDisplayed()
        compose.onNodeWithText("Worked for 4s").performClick()
        compose.onNodeWithText("Let me inspect the build logs.").assertDoesNotExist()

        compose.onNodeWithText("Event payload").performClick()
        compose.onNodeWithText("{\"service\":\"checkout\"}").assertIsDisplayed()
        screenshot("transcript-payload-expanded")
        compose.onNodeWithText("Event payload").performClick()
        compose.onNodeWithText("checkout", substring = true).assertDoesNotExist()
    }

    @Test
    fun compactionExpandsItsSummaryAndDigestRemainsHidden() {
        val summary = "Earlier context preserved for the next turn."
        val compact = Message("compact", Message.Role.BOT, Message.Kind.COMPACTION, 6000.0,
            compaction = Compaction(summary, 12345))
        val digest = Message("digest", Message.Role.BOT, Message.Kind.DIGEST, 7000.0,
            text = "Digest must stay hidden")
        mount(ActivityDetail.FULL, transcript = messages + compact + digest)
        compose.onNodeWithText("Digest must stay hidden").assertDoesNotExist()
        compose.onNodeWithText(summary).assertDoesNotExist()
        compose.onNodeWithText(compact.compaction!!.chipText).performClick()
        compose.onNodeWithText(summary).assertIsDisplayed()
        assertEquals(summary, MessageActions.copyableText(compact))
        compose.runOnIdle { scene.environment.chatPreferences.setActivityDetail(ActivityDetail.HIDDEN) }
        compose.onNodeWithText(compact.compaction!!.chipText).assertDoesNotExist()
        compose.onNodeWithText(summary).assertDoesNotExist()
    }

    @Test
    fun changingActivityToHiddenSuppressesLiveReasoningButKeepsWorkingIndicator() {
        mount(ActivityDetail.FULL, reasoning = true)
        compose.onNodeWithText("Thinking…").assertIsDisplayed()
        compose.runOnIdle { scene.environment.chatPreferences.setActivityDetail(ActivityDetail.HIDDEN) }
        compose.onNodeWithText("Thinking…").assertDoesNotExist()
        compose.onNodeWithContentDescription("Scout is working").assertIsDisplayed()
        compose.runOnIdle { scene.environment.chatPreferences.setActivityDetail(ActivityDetail.REDUCED) }
        compose.onNodeWithText("Thinking…").assertIsDisplayed()
    }

    @Test
    fun webhookActionsCopyOnlyTheTaskAndDoNotOfferTextOnlyRetry() {
        assertEquals("Triage the build failure.", MessageActions.copyableText(messages.first()))
        assertNull(MessageActions.editableText(messages.first()))
    }

    @Test
    fun aSearchHitRevealsItsIntermediateReplyInsideTheFold() {
        val narration = (0..11).map { index ->
            messages[1].copy(id = "progress-$index", at = 2000.0 + index,
                text = ("Intermediate reply $index. " + "Checking another part of the build. ".repeat(8)).trim())
        }
        mount(ActivityDetail.HIDDEN, transcript = listOf(messages.first()) + narration + messages.last())
        val targetText = narration.last().text!!
        compose.onNodeWithText(targetText).assertDoesNotExist()
        compose.runOnIdle {
            compose.activity.lifecycleScope.launch {
                scene.session.open(SearchHit(
                    threadId = "thread-bot-1", messageId = "progress-11", at = 2011.0,
                    role = Message.Role.BOT, kind = Message.Kind.TEXT, snippet = targetText,
                    matchStart = 0, matchLength = 7, botId = "bot-1", name = "Scout", onActivePath = true,
                ))
            }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText(targetText).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(targetText).assertIsDisplayed()
    }

    private fun mount(detail: ActivityDetail, reasoning: Boolean = false, transcript: List<Message> = messages) {
        val fixture = bot(name = "Scout", busy = reasoning).copy(messages = if (reasoning) emptyList() else transcript)
        scene = WiringScene(
            connection = Connection(id = "transcript-fixture", name = "Offline fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(fixture), emptyList()),
        ) {
            flow {
                emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1))
                if (reasoning) emit(StreamFrame(Frame.Runtime(RuntimeEvent("content.delta", fixture.threadId, "Reviewing the build", "reasoning_text")), seq = 2))
                awaitCancellation()
            }
        }
        scene.environment.chatPreferences.setActivityDetail(detail)
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    val state by scene.session.state.collectAsState()
                    if (state.bot(fixture.id) != null) ChatScreen(
                        Destination.Chat(Chat.BotChat(fixture).target),
                        onResolved = {}, onBack = {}, onOpenComputer = {}, onOpenOverview = {},
                    )
                }
            }
        }
        compose.runOnIdle { scene.session.connect() }
        compose.waitUntil(5_000) { scene.session.state.value.bot(fixture.id) != null }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        compose.runOnIdle {
            val view = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bitmap))
            val file = File("build/outputs/transcript-screenshots/$name.png")
            file.parentFile?.mkdirs()
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
