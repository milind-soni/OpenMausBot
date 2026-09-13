package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.CompanionJson
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.StreamFrame
import com.openmausbot.companion.core.target
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
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

/** Real Compose controls and Session requests, confined to an offline loopback fixture. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalTestApi::class)
class AndroidThreadNavigationTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        // The header mascot normally requests frames continuously. Exercise
        // its native reduce-motion path so autoAdvance can reach idle without
        // generating an unbounded Robolectric trace queue.
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )

    private lateinit var server: MockWebServer
    private lateinit var scene: WiringScene
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()
    private var answerAction: (RecordedRequest) -> MockResponse = { MockResponse().setResponseCode(503) }
    private val unavailable = "The computer answered with an error (503)."
    private val fixture = bot().copy(
        threadId = "first",
        messages = emptyList(),
        tasks = listOf(
            BotTask(threadId = "first", title = "First thread", createdAt = 0.0),
            BotTask(threadId = "second", title = "Second thread", createdAt = 0.0),
        ),
    )

    @Before
    fun startServer() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add(request)
                return when {
                    request.method != "GET" -> answerAction(request)
                    request.path == "/api/instances" -> json("""{"instances":[]}""")
                    request.path?.startsWith("/api/threads/") == true -> json("""{"messages":[],"hasMore":false}""")
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
    fun `the header switches exact threads and restores each typed draft until Back`() {
        val initial = Destination.Chat(Chat.BotChat(fixture).target)
        val navigator = CompanionNavigator(listOf(Destination.Roster, initial))
        mount {
            when (val destination = navigator.current) {
                is Destination.Conversation -> ChatScreen(
                    destination = destination,
                    onResolved = { navigator.selectTask(destination, it) },
                    onBack = navigator::pop,
                    onOpenComputer = {},
                    onOpenOverview = {},
                    retainsDraft = navigator::retainsChatDraft,
                )
                else -> Text("Fixture Home")
            }
        }

        compose.onNode(hasSetTextAction()).performTextInput("Draft for the first thread")
        compose.onNodeWithText("First thread").performClick()
        compose.onNodeWithText("Second thread").performClick()
        compose.waitUntil(5_000) { (navigator.current as? Destination.Chat)?.target?.threadId == "second" }
        compose.onNode(hasSetTextAction()).assertTextEquals("")
        compose.onNode(hasSetTextAction()).performTextInput("Draft for the second thread")
        compose.onNodeWithText("Second thread").performClick()
        compose.onNodeWithText("First thread").performClick()
        compose.waitUntil(5_000) { (navigator.current as? Destination.Chat)?.target?.threadId == "first" }
        compose.onNode(hasSetTextAction()).assertTextEquals("Draft for the first thread")
        assertEquals("Draft for the second thread", scene.environment.chatDrafts.get("second")?.text)
        assertEquals("first", scene.session.state.value.bot(fixture.id)?.threadId)
        assertTrue(requests.none { it.method == "POST" && it.path?.contains("/tasks/") == true })

        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Fixture Home").assertIsDisplayed()
        assertNull(scene.environment.chatDrafts.get("first"))
        assertNull(scene.environment.chatDrafts.get("second"))
    }

    @Test
    fun `a busy bot can select another thread locally from the picker`() {
        val busy = fixture.copy(busy = true, tasks = fixture.tasks!!.map {
            if (it.threadId == "first") it.copy(busy = true, activity = "working") else it
        })
        var selected: ChatTarget? = null
        var dismissed = 0
        mount(busy) {
            TaskSheet(Chat.BotChat(busy), onDismiss = { dismissed++ }, onSelectTask = { selected = it })
        }
        compose.onNodeWithText("Second thread").performClick()
        compose.waitUntil(5_000) { selected != null }
        assertEquals(ChatTarget.Bot(fixture.id, "second"), selected)
        assertEquals(1, dismissed)
        assertEquals("first", scene.session.state.value.bot(fixture.id)?.threadId)
        assertTrue(requests.none { it.method == "POST" })
    }

    @Test
    fun `failed thread creation leaves the picker open with a retryable error`() {
        var dismissed = 0
        var selected: ChatTarget? = null
        mount {
            TaskSheet(Chat.BotChat(fixture), onDismiss = { dismissed++ }, onSelectTask = { selected = it })
        }
        compose.onNodeWithContentDescription("New thread").performClick()
        waitForError()
        compose.onNodeWithText("${fixture.name}'s threads").assertIsDisplayed()
        compose.onNodeWithText(unavailable).assertIsDisplayed()
        assertEquals(0, dismissed)
        assertNull(selected)
        assertEquals(1, requests.count { it.method == "POST" && it.path == "/api/bots/${fixture.id}/tasks" })
    }

    @Test
    fun `a failed rename preserves the edited title in the dialog`() {
        mount { TaskSheet(Chat.BotChat(fixture), onDismiss = {}, onSelectTask = {}) }
        compose.onNodeWithContentDescription("Rename Second thread").performClick()
        compose.onNode(hasSetTextAction()).performTextReplacement("Keep these release notes")
        compose.onNodeWithText("Save").performClick()
        waitForError()
        compose.onNodeWithText("Rename thread").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).assertTextContains("Keep these release notes")
        val request = requests.single { it.method == "PATCH" }
        assertEquals("/api/bots/${fixture.id}/tasks/second", request.path)
        assertEquals("""{"title":"Keep these release notes"}""", request.body.readUtf8())
        assertEquals("Second thread", scene.session.state.value.bot(fixture.id)?.tasks?.get(1)?.title)
    }

    @Test
    fun `delete requires confirmation and a failed current deletion can be retried`() {
        val attempts = AtomicInteger()
        answerAction = { request ->
            if (request.method == "DELETE" && attempts.incrementAndGet() > 1) {
                val surviving = fixture.copy(threadId = "second", tasks = fixture.tasks!!.drop(1))
                json("""{"bot":${CompanionJson.encodeToString(Bot.serializer(), surviving)}}""")
            } else MockResponse().setResponseCode(503)
        }
        var dismissed = 0
        var deletedCurrent = 0
        var selected: ChatTarget? = null
        mount {
            TaskSheet(
                Chat.BotChat(fixture), onDismiss = { dismissed++ },
                onSelectTask = { selected = it }, onDeletedCurrent = { deletedCurrent++ },
            )
        }

        compose.onNodeWithContentDescription("Delete First thread").performClick()
        compose.onNodeWithText("Delete First thread?").assertIsDisplayed()
        assertTrue(requests.none { it.method == "DELETE" })
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(requests.none { it.method == "DELETE" })
        compose.onNodeWithContentDescription("Delete First thread").performClick()
        compose.onNodeWithText("Delete", substring = false).performClick()
        waitForError()
        assertEquals(0, deletedCurrent)
        assertEquals(0, dismissed)
        compose.onNodeWithText("Delete First thread?").assertIsDisplayed()
        compose.onNodeWithText("Delete", substring = false).performClick()
        compose.waitUntil(5_000) { deletedCurrent == 1 }
        assertEquals(1, dismissed)
        assertNull(selected, "deleting the open bot conversation should leave it, not select a sibling")
        assertEquals(listOf("second"), scene.session.state.value.bot(fixture.id)?.tasks?.map { it.threadId })
        assertEquals(2, requests.count { it.method == "DELETE" && it.path == "/api/bots/${fixture.id}/tasks/first" })
    }

    private fun mount(bot: Bot = fixture, content: @Composable () -> Unit) {
        scene = WiringScene(
            connection = Connection(id = "thread-fixture", name = "Offline fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(bot), emptyList()),
        ) {
            flow {
                emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1))
                awaitCancellation()
            }
        }
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    val state by scene.session.state.collectAsState()
                    if (state.bot(bot.id) != null) content()
                }
            }
        }
        compose.runOnIdle { scene.session.connect() }
        compose.waitUntil(5_000) { scene.session.state.value.bot(bot.id) != null }
        compose.waitForIdle()
    }

    private fun waitForError() {
        compose.waitUntil(5_000) { compose.onAllNodesWithText(unavailable).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
