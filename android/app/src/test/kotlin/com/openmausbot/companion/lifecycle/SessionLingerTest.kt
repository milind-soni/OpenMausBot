package com.openmausbot.companion.lifecycle

import androidx.lifecycle.Lifecycle
import com.openmausbot.companion.audio.PreviewAudioEngine
import com.openmausbot.companion.audio.PreviewAudioFocus
import com.openmausbot.companion.audio.VoicePreviewController
import com.openmausbot.companion.audio.VoicePreviewPlayer
import com.openmausbot.companion.avatar.AvatarImageStore
import com.openmausbot.companion.core.APIError
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Frame
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.RuntimeEvent
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.StreamFrame
import com.openmausbot.companion.core.TokenStore
import com.openmausbot.companion.notifications.NotificationMapping
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/**
 * The measured defect: ask a bot, press Home about two seconds later, let the
 * turn finish — and no notification is posted, because `onStop` used to cancel
 * the stream that produces it.
 *
 * These tests are written to the criterion in the analysis (§5): not "was
 * `linger` called", but **a frame emitted after `ON_STOP` and before the
 * deadline still crosses the same SSE collection and reaches the notification
 * sink**. So they drive a real [androidx.lifecycle.LifecycleRegistry], hold a
 * real [Session] with a real `disconnect()`, and let the real
 * `SessionLingerController.WINDOW_MILLIS` delay run on virtual time. The single
 * fake is the process anchor — the one thing a JVM cannot have.
 *
 * `advanceTimeBy` moves the virtual clock against that same cancellable
 * `delay`; no timeout function is ever called by hand and the production
 * duration is never shortened.
 *
 * The clock cases below are the normative table in analysis §6.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionLingerTest {

    // ---------------------------------------------------------------- §5.1

    @Test
    fun `a done notify ten seconds after Home still reaches the sink`() =
        assertNotifyLandsInBackground(kind = "done", channel = NotificationMapping.CHANNEL_DONE)

    @Test
    fun `a routine-failed notify in the background still reaches the sink`() =
        assertNotifyLandsInBackground(
            kind = "routine-failed",
            channel = NotificationMapping.CHANNEL_ROUTINE_FAILED,
        )

    @Test
    fun `an approval notify in the background still reaches the sink`() =
        assertNotifyLandsInBackground(
            kind = "approval",
            channel = NotificationMapping.CHANNEL_BLOCKING,
        )

    private fun assertNotifyLandsInBackground(kind: String, channel: String) = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink, hydrate = { Fleet(listOf(bot()), emptyList()) })
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(10_000)
        runCurrent()

        stream.emit(notify(kind, seq = 7))
        runCurrent()

        assertEquals(1, sink.delivered.size)
        val (frame, seq) = sink.delivered.single()
        assertEquals(kind, frame.kind)
        assertEquals(7, seq)
        assertEquals(channel, NotificationMapping.channelId(frame))
        assertEquals(listOf(frame), session.state.value.notifications)
        assertEquals("s:7", session.state.value.cursor)
        // One SSE connection throughout — not a reconnect that happened to
        // catch the frame.
        assertEquals(1, stream.opens)
        assertEquals(1, stream.collectors)
    }

    // ---------------------------------------------------------------- §5.2

    @Test
    fun `the stream survives to 24999ms and is cancelled at 25000ms`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(24_999)
        runCurrent()
        assertEquals(1, stream.collectors)
        assertEquals(listOf(1L), currentAnchor.started)

        advanceTimeBy(1)
        runCurrent()
        assertEquals(0, stream.collectors)
        assertEquals(listOf(1L), currentAnchor.stopped)
        assertNull(currentAnchor.held)

        // Nothing is listening any more, so a later frame cannot be delivered.
        stream.emit(notify("done", seq = 9))
        runCurrent()
        assertEquals(0, sink.delivered.size)
        assertEquals(1, stream.opens)
    }

    // ---------------------------------------------------------------- §5.3

    @Test
    fun `coming back after one second keeps the same connection`() =
        assertReturnKeepsConnection(afterMillis = 1_000)

    @Test
    fun `coming back after twenty-four seconds keeps the same connection`() =
        assertReturnKeepsConnection(afterMillis = 24_000)

    private fun assertReturnKeepsConnection(afterMillis: Long) = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(afterMillis)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()

        // Well past the deadline the cancelled timer would have had.
        advanceTimeBy(60_000)
        runCurrent()
        stream.emit(notify("done", seq = 11))
        runCurrent()

        assertEquals(1, sink.delivered.size)
        assertEquals(11, sink.delivered.single().second)
        assertEquals(1, stream.opens)
        assertEquals(1, stream.collectors)
        assertEquals(listOf(1L), currentAnchor.started)
        assertEquals(listOf(1L), currentAnchor.stopped)
        assertNull(currentController.openWindow)
    }

    // ---------------------------------------------------------------- §5.4

    @Test
    fun `coming back after twenty-six seconds opens exactly one stream from the cursor`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        stream.emit(notify("done", seq = 7))
        runCurrent()
        assertEquals("s:7", session.state.value.cursor)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(25_000)
        runCurrent()
        assertEquals(0, stream.collectors)

        advanceTimeBy(1_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()

        assertEquals(2, stream.opens)
        assertEquals(listOf(null, "s:7"), stream.since)
        assertEquals(1, stream.collectors)
    }

    // ---------------------------------------------------------------- §5.5

    @Test
    fun `a second trip to the background gets its own full window`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(1_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()

        // t = 25s globally: the *first* window's deadline. It must not touch
        // the second window, which is only 23s old.
        advanceTimeBy(23_000)
        runCurrent()
        assertEquals(1, stream.collectors)
        stream.emit(notify("done", seq = 21))
        runCurrent()
        assertEquals(1, sink.delivered.size)
        assertEquals(21, sink.delivered.single().second)

        // t = 27s globally = 25s into the second window.
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(0, stream.collectors)
        assertEquals(listOf(1L, 2L), currentAnchor.started)
        assertEquals(listOf(1L, 2L), currentAnchor.stopped)
        assertEquals(1, stream.opens)
    }

    /**
     * The same two quick trips, with the adverse ordering the framework can
     * actually produce: `stopService` for the first trip returns immediately,
     * and that service's `onDestroy` only lands *after* the second window is
     * open. It carries token 1, so it must not touch window 2.
     *
     * The test above cannot show this — its anchor reports the destroy inline,
     * while `openToken` is still null.
     */
    @Test
    fun `a late onDestroy from the first trip cannot close the second window`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream, anchor = FakeAnchor(deferDestroy = true))

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(1_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(2L, currentController.openWindow)

        // t = 7s: the first trip's service finally reports its destruction.
        currentAnchor.deliverPendingDestroys()
        runCurrent()

        assertEquals(2L, currentController.openWindow)
        assertEquals(1, stream.collectors)
        stream.emit(notify("done", seq = 41))
        runCurrent()
        assertEquals(1, sink.delivered.size)
        assertEquals(41, sink.delivered.single().second)

        // The second window still ends on its own deadline, t = 27s globally.
        advanceTimeBy(19_999)
        runCurrent()
        assertEquals(1, stream.collectors)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(0, stream.collectors)
        assertEquals(listOf(1L, 2L), currentAnchor.started)
        assertEquals(listOf(1L, 2L), currentAnchor.stopped)
        assertEquals(1, stream.opens)
    }

    // ---------------------------------------------------------------- §5.6

    @Test
    fun `an anchor the system reclaims ends the window at once`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(1, stream.collectors)

        currentAnchor.destroyedBySystem()
        runCurrent()
        assertEquals(0, stream.collectors)
        assertNull(currentController.openWindow)

        // The reclaimed anchor's callback must not follow the app back to the
        // foreground and cut the stream it reopens.
        advanceTimeBy(30_000)
        runCurrent()
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        assertEquals(2, stream.opens)
        assertEquals(1, stream.collectors)
        stream.emit(notify("done", seq = 31))
        runCurrent()
        assertEquals(1, sink.delivered.size)
    }

    @Test
    fun `an anchor that refuses to start disconnects immediately`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream, anchor = FakeAnchor(refuseStart = true))

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()

        assertEquals(0, stream.collectors)
        assertEquals(1, currentAnchor.startAttempts)
        assertTrue(currentAnchor.started.isEmpty())
        assertNull(currentController.openWindow)
    }

    // ------------------------------------------------------- always-on race

    /**
     * The race CodeRabbit flagged on PR #966: the always-on toggle is turned
     * on and the app backgrounds before `AlwaysOnConnectionService.onStartCommand`
     * runs, so this controller opens its own window first. Without the
     * handoff, that window's 25s timer would call `session.disconnect()` out
     * from under the service that now depends on the same connection.
     */
    @Test
    fun `always-on starting after ON_STOP cancels the window without disconnecting`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()
        assertEquals(1, stream.collectors)
        assertEquals(listOf(1L), currentAnchor.started)

        // AlwaysOnConnectionService won the race and started after this
        // window was already open.
        currentController.onAlwaysOnStarted()
        assertEquals(listOf(1L), currentAnchor.stopped)
        assertNull(currentController.openWindow)

        // The window's own deadline must not still fire and disconnect what
        // the service now depends on staying open.
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(1, stream.collectors)
        stream.emit(notify("done", seq = 50))
        runCurrent()
        assertEquals(1, sink.delivered.size)
    }

    // ---------------------------------------------------------------- §5.7

    @Test
    fun `a turn that finishes in the background lands transcript, cursor and notify`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink, hydrate = { Fleet(listOf(bot()), emptyList()) })
        val owner = live(session, stream)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(2_000)
        runCurrent()

        stream.emit(delta("t1", "The report", seq = 4))
        stream.emit(delta("t1", " is ready.", seq = 5))
        runCurrent()
        assertEquals("The report is ready.", session.state.value.streaming["t1"])

        stream.emit(
            StreamFrame(
                Frame.Message(
                    "t1",
                    Message(
                        id = "m9",
                        role = Message.Role.BOT,
                        kind = Message.Kind.TEXT,
                        at = 1.0,
                        text = "The report is ready.",
                    ),
                ),
                seq = 6,
            ),
        )
        stream.emit(StreamFrame(Frame.Runtime(RuntimeEvent("turn.completed", "t1")), seq = 7))
        stream.emit(notify("done", seq = 8))
        runCurrent()

        assertEquals(
            listOf("The report is ready."),
            session.state.value.transcript("t1").map { it.text },
        )
        assertNull(session.state.value.streaming["t1"])
        assertEquals(1, sink.delivered.size)
        assertEquals(8, sink.delivered.single().second)
        assertEquals("s:8", session.state.value.cursor)
        assertEquals(1, stream.opens)
    }

    // ---------------------------------------------------------------- §5.8

    @Test
    fun `a stream in backoff may reopen inside the window and still deliver`() = runTest {
        val stream = FakeStream(
            onOpen = { index, _ ->
                if (index == 1) flow<StreamFrame> { throw IOException("socket dropped") } else null
            },
        )
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream, awaitHello = false)

        assertTrue(session.status.value is Session.Status.Offline)
        assertEquals(1, stream.opens)

        // Backgrounded while the reconnect backoff is still counting down.
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, stream.opens)

        stream.emit(hello("s:1", resumed = false))
        stream.emit(notify("done", seq = 12))
        runCurrent()
        assertEquals(1, sink.delivered.size)
        assertEquals(12, sink.delivered.single().second)

        // The deadline still ends it, backoff loop included.
        advanceTimeBy(24_000)
        runCurrent()
        assertEquals(0, stream.collectors)
        assertNull(currentController.openWindow)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(2, stream.opens)
    }

    @Test
    fun `an unauthorized session opens no window`() = runTest {
        val stream = FakeStream(
            onOpen = { _, _ -> flow<StreamFrame> { throw APIError.Status(401, "revoked") } },
        )
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream, awaitHello = false)
        assertEquals(Session.Status.Unauthorized, session.status.value)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(30_000)
        runCurrent()

        assertEquals(0, currentAnchor.startAttempts)
        assertNull(currentController.openWindow)
        // No restart loop, and no slide into Unpaired: the pairing survives
        // until the user chooses "Pair again".
        assertEquals(1, stream.opens)
        assertEquals(Session.Status.Unauthorized, session.status.value)
    }

    @Test
    fun `a definitively unpaired app never starts the anchor`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(
            stream,
            sink,
            connections = store(null),
            tokenStore = tokens(TokenStore.ReadResult.Missing),
        )
        val owner = live(session, stream, awaitHello = false)
        assertEquals(Session.RestoreState.Unpaired, session.restoreState.value)
        assertNull(session.connection.value)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(30_000)
        runCurrent()

        assertEquals(0, currentAnchor.startAttempts)
        assertEquals(0, stream.opens)
    }

    @Test
    fun `a restore still pending keeps the anchor without opening a second connection`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(
            stream,
            sink,
            tokenStore = tokens(TokenStore.ReadResult.Unavailable(locked = true, message = "locked")),
        )
        val owner = live(session, stream, awaitHello = false)
        assertEquals(Session.RestoreState.Pending, session.restoreState.value)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()
        assertEquals(listOf(1L), currentAnchor.started)
        assertEquals(0, stream.opens)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        runCurrent()
        assertEquals(listOf(1L), currentAnchor.stopped)
        assertEquals(0, stream.opens)
    }

    // ---------------------------------------------------------------- §5.9

    @Test
    fun `voice preview registered after the linger still stops at ON_STOP`() =
        assertVoicePreviewStopsAtOnce(registerPlayerFirst = false)

    @Test
    fun `voice preview registered before the linger still stops at ON_STOP`() =
        assertVoicePreviewStopsAtOnce(registerPlayerFirst = true)

    /**
     * The linger is only about the connection. Audio, dictation and the mic
     * keep their own immediate teardown, whichever order the process-lifecycle
     * observers happen to be registered in.
     */
    private fun assertVoicePreviewStopsAtOnce(registerPlayerFirst: Boolean) = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = TestOwner()
        val engine = SilentEngine()

        fun installPlayer() = VoicePreviewPlayer(
            controller = VoicePreviewController(
                engineFactory = { engine },
                focus = GrantingFocus(),
            ),
            processLifecycle = owner.registry,
        )

        val player = if (registerPlayerFirst) installPlayer() else null
        live(session, stream, owner = owner)
        val active = player ?: installPlayer()

        assertNull(active.play(byteArrayOf(1, 2, 3)))
        assertTrue(active.playing.value)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()

        // No clock advance: audio stops on the callback, the connection does not.
        assertFalse(active.playing.value)
        assertEquals(1, engine.stops)
        assertEquals(1, stream.collectors)
        stream.emit(notify("done", seq = 5))
        runCurrent()
        assertEquals(1, sink.delivered.size)
    }

    @Test
    fun `signing out during the window unpairs and clears avatars at once, and the stale timer is inert`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val owner = live(session, stream)

        // The real store, wired exactly as OpenMausApp.kt wires it: the cache
        // must not survive the pairing that minted its URLs, and the window
        // must not delay that either.
        val avatars = AvatarImageStore(fetch = { byteArrayOf(7, 7, 7) }, decode = { null })
        val unpairedSeen = mutableListOf<Boolean>()
        backgroundScope.launch {
            session.status
                .map { it is Session.Status.Unpaired }
                .distinctUntilChanged()
                .collect { unpaired ->
                    unpairedSeen += unpaired
                    if (unpaired) avatars.clearBlocking()
                }
        }
        runCurrent()
        assertEquals(listOf(false), unpairedSeen)

        assertContentEquals(
            byteArrayOf(7, 7, 7),
            avatars.bytesFor(bot().copy(avatarUrl = "/api/attachments/a.png")),
        )
        assertEquals(1, avatars.cachedEntryCount())

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        advanceTimeBy(3_000)
        runCurrent()
        assertEquals(1, stream.collectors)

        session.signOutAndAwait()
        runCurrent()

        // Unpair — and the cache clear that rides on it — is not delayed by the
        // window: no clock advance between the sign-out and these assertions.
        assertEquals(listOf(false, true), unpairedSeen)
        assertEquals(0, avatars.cachedEntryCount())
        assertEquals(0, avatars.cachedByteCost())
        assertEquals(Session.Status.Unpaired, session.status.value)
        assertEquals(0, stream.collectors)
        assertNull(session.connection.value)

        // The timer left over from the window may still fire; it must find
        // nothing to cut and must not reopen anything.
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(listOf(1L), currentAnchor.stopped)
        assertEquals(1, stream.opens)
        assertEquals(Session.Status.Unpaired, session.status.value)
    }

    // ------------------------------------------------------------- fixtures

    private lateinit var currentAnchor: FakeAnchor
    private lateinit var currentController: SessionLingerController

    /**
     * [installLive], plus the two handles this class asserts against across
     * most of its tests. The install/settle sequence itself lives in
     * `LingerTestSupport` so the wiring test drives exactly the same one.
     */
    private suspend fun TestScope.live(
        session: Session,
        stream: FakeStream,
        anchor: FakeAnchor = FakeAnchor(),
        awaitHello: Boolean = true,
        owner: TestOwner = TestOwner(),
    ): TestOwner {
        val scene = installLive(session, stream, anchor, awaitHello, owner)
        currentAnchor = scene.anchor
        currentController = scene.controller
        return scene.owner
    }

    private fun delta(threadId: String, text: String, seq: Int): StreamFrame = StreamFrame(
        Frame.Runtime(
            RuntimeEvent(
                type = "content.delta",
                threadId = threadId,
                delta = text,
                streamKind = "assistant_text",
            ),
        ),
        seq = seq,
    )

    private class SilentEngine : PreviewAudioEngine {
        override var onCompletion: (() -> Unit)? = null
        override var onError: (() -> Unit)? = null
        var stops = 0
            private set

        override fun start(data: ByteArray): Boolean = true

        override fun stop() {
            stops += 1
        }

        override fun release() = Unit
    }

    private class GrantingFocus : PreviewAudioFocus {
        override fun request(onInterrupted: () -> Unit): Boolean = true
        override fun abandon() = Unit
    }
}
