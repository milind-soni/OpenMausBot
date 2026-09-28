package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.StreamFrame
import com.openmausbot.companion.core.target
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The swipe-right-to-roster affordance: what counts as a deliberate back
 * swipe, what must never count, and that the conversation screen routes one
 * through the same exit the back pill and system back take.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(ExperimentalTestApi::class)
class BackSwipeTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        // The header mascot normally requests frames continuously; the same
        // native reduce-motion path the other chat screen tests take, so the
        // rule can reach idle between the injected steps of a swipe.
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )

    private lateinit var server: MockWebServer
    private lateinit var scene: WiringScene

    @Before fun startServer() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse()
                .setHeader("Content-Type", "application/json")
                .setBody(if (request.path == "/api/instances") """{"instances":[]}""" else """{"messages":[],"hasMore":false}""")
        }
        server.start()
    }

    @After fun stopServer() {
        if (::scene.isInitialized) scene.session.disconnect()
        server.shutdown()
    }

    @Test
    fun `a deliberate rightward drag asks for back once`() {
        val backs = mutableListOf<Unit>()
        compose.setContent {
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) })
        }

        dragRight()

        assertEquals(1, backs.size)
    }

    @Test
    fun `a recomposition mid-drag does not cancel the swipe`() {
        val backs = mutableListOf<Unit>()
        val ticks = mutableStateOf(0)
        compose.setContent {
            val tick by ticks
            // The lambda is rebuilt every recomposition on purpose: a detector
            // keyed on its identity would restart under it mid-gesture and
            // lose the drag in progress.
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) }) {
                Text("tick " + tick)
            }
        }

        compose.onRoot().performTouchInput {
            val far = 120.dp.toPx()
            down(center)
            moveTo(center + Offset(far / 2, 0f))
        }
        compose.runOnIdle { ticks.value += 1 }
        compose.onNodeWithText("tick 1").assertIsDisplayed()
        compose.onRoot().performTouchInput {
            val far = 120.dp.toPx()
            moveTo(center + Offset(far, 0f))
            up()
        }

        assertEquals(1, backs.size)
    }

    @Test
    fun `a leftward swipe is not a back`() {
        val backs = mutableListOf<Unit>()
        compose.setContent {
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) })
        }

        compose.onRoot().performTouchInput { swipeLeft() }

        assertEquals(0, backs.size)
    }

    @Test
    fun `a drag shorter than a deliberate swipe stays on the screen`() {
        val backs = mutableListOf<Unit>()
        compose.setContent {
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) })
        }

        compose.onRoot().performTouchInput {
            val short = 24.dp.toPx()
            down(center)
            moveTo(center + Offset(short, 0f))
            up()
        }

        assertEquals(0, backs.size)
    }

    @Test
    fun `a drag out and back is a change of mind, not a back`() {
        val backs = mutableListOf<Unit>()
        compose.setContent {
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) })
        }

        compose.onRoot().performTouchInput {
            val far = 120.dp.toPx()
            down(center)
            moveTo(center + Offset(far, 0f))
            moveTo(center)
            up()
        }

        assertEquals(0, backs.size)
    }

    @Test
    fun `vertical drags belong to the scrolling list`() {
        val backs = mutableListOf<Unit>()
        var listState: LazyListState? = null
        compose.setContent {
            val state = rememberLazyListState()
            listState = state
            Box(Modifier.fillMaxSize().horizontalBackSwipe { backs.add(Unit) }) {
                LazyColumn(state = state, modifier = Modifier.fillMaxSize()) {
                    items(100) { index ->
                        Text("row " + index, modifier = Modifier.height(48.dp))
                    }
                }
            }
        }

        compose.onRoot().performTouchInput { swipeUp() }

        // The list must have scrolled, which is the swipe belonging to the
        // list rather than the screen, and the back affordance staying quiet.
        assertTrue(compose.runOnIdle { listState!!.firstVisibleItemIndex } > 0)
        assertEquals(0, backs.size)
    }

    @Test
    fun `swiping right on a conversation pops the stack home and drops the draft`() {
        val fixture = bot(id = "swipe").copy(
            threadId = "thread-swipe",
            messages = listOf(
                Message("m1", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "are you there"),
                Message("m2", Message.Role.BOT, Message.Kind.TEXT, 2.0, text = "always"),
            ),
        )
        val navigator = CompanionNavigator(
            listOf(Destination.Roster, Destination.Chat(Chat.BotChat(fixture).target)),
        )
        mount(fixture) {
            when (val destination = navigator.current) {
                is Destination.Conversation -> ChatScreen(
                    destination = destination,
                    onResolved = {},
                    onBack = navigator::pop,
                    onOpenComputer = {},
                    onOpenOverview = {},
                    retainsDraft = navigator::retainsChatDraft,
                )
                else -> Text("Fixture Home")
            }
        }

        // The loaded conversation, not its loading stand-in, takes the swipe,
        // with a draft in flight so the exit has to clear what back clears.
        compose.onNodeWithText("always").assertIsDisplayed()
        compose.onNode(hasSetTextAction()).performTextInput("draft in flight")
        assertTrue(scene.environment.chatDrafts.get("thread-swipe")?.text?.isNotEmpty() == true)

        dragRight()

        compose.waitUntil(5_000) { navigator.current == Destination.Roster }
        compose.onNodeWithText("Fixture Home").assertIsDisplayed()
        assertNull(scene.environment.chatDrafts.get("thread-swipe"))
    }

    @Test
    fun `the back pill closes an open command hud before it leaves`() {
        val fixture = bot(id = "pill").copy(
            threadId = "thread-pill",
            messages = listOf(
                Message("m1", Message.Role.USER, Message.Kind.TEXT, 1.0, text = "are you there"),
                Message("m2", Message.Role.BOT, Message.Kind.TEXT, 2.0, text = "always"),
            ),
        )
        val chat = Chat.BotChat(fixture).target
        val navigator = CompanionNavigator(
            listOf(Destination.Roster, Destination.Chat(chat)),
        )
        mount(fixture) {
            when (val destination = navigator.current) {
                is Destination.Conversation -> ChatScreen(
                    destination = destination,
                    onResolved = {},
                    onBack = navigator::pop,
                    onOpenComputer = {},
                    onOpenOverview = {},
                    retainsDraft = navigator::retainsChatDraft,
                )
                else -> Text("Fixture Home")
            }
        }

        compose.onNodeWithText("always").assertIsDisplayed()
        val hud = compose.onNodeWithContentDescription("Slash commands")
        hud.performClick()
        compose.waitForIdle()
        assertEquals("Expanded", hud.fetchSemanticsNode().config[SemanticsProperties.StateDescription])

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()

        // The hud closed and the conversation is still here: the pill answers
        // the panel-first decision, not a beeline for the roster.
        assertEquals("Collapsed", hud.fetchSemanticsNode().config[SemanticsProperties.StateDescription])
        compose.onNodeWithText("always").assertIsDisplayed()
        assertEquals(Destination.Chat(chat), navigator.current)

        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(5_000) { navigator.current == Destination.Roster }
        compose.onNodeWithText("Fixture Home").assertIsDisplayed()
    }

    /** A hand crosses in steps, not one jump; inject the gesture the same way. */
    private fun dragRight() {
        compose.onRoot().performTouchInput {
            val far = 120.dp.toPx()
            down(center)
            repeat(8) { step ->
                moveTo(center + Offset(far * (step + 1) / 8f, 0f))
            }
            up()
        }
    }

    private fun mount(
        bot: Bot,
        content: @Composable () -> Unit,
    ) {
        val events: (Int) -> Flow<StreamFrame> = {
            flow {
                emit(StreamFrame(Frame.Hello(cursor = "fixture:1", resumed = false), seq = 1))
                awaitCancellation()
            }
        }
        scene = WiringScene(
            connection = Connection(id = "swipe-fixture", name = "Fixture", host = "127.0.0.1", port = server.port),
            fleet = Fleet(listOf(bot), emptyList()),
            events = events,
        )
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
}
