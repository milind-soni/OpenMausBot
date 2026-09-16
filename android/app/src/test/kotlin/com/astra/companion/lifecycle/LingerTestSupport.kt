package com.astra.companion.lifecycle

import com.astra.companion.core.Bot
import com.astra.companion.core.Connection
import com.astra.companion.core.ConnectionStore
import com.astra.companion.core.Fleet
import com.astra.companion.core.InMemoryOnboardingStore
import com.astra.companion.core.ModelSelection
import com.astra.companion.core.NotificationFrame
import com.astra.companion.core.NotificationSink
import com.astra.companion.core.Session
import com.astra.companion.core.StreamFrame
import com.astra.companion.core.TokenStore
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlin.test.assertEquals
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent

/**
 * Shared fixtures for the linger tests.
 *
 * The rule these follow (analysis §5): the only thing faked is the *process
 * anchor*. The [Session], its `disconnect()`, the twenty-five second `delay`
 * and the SSE collection are all real, so a frame emitted after `ON_STOP` has
 * to cross the same collector a real one would.
 */

internal val TEST_CONNECTION = Connection(
    id = "c1",
    name = "Ada's Mac",
    host = "127.0.0.1",
    port = 8810,
)

/** Records every SSE open, the `since` it carried, and hands out one hot flow. */
internal class FakeStream(
    /** `(1-based open index, since) -> flow`, or null for the shared hot flow. */
    private val onOpen: (Int, String?) -> Flow<StreamFrame>? = { _, _ -> null },
) {
    val frames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 32)
    val since = mutableListOf<String?>()
    val screens = mutableListOf<Boolean>()

    val opens: Int get() = since.size

    /** How many coroutines are currently collecting the stream. */
    val collectors: Int get() = frames.subscriptionCount.value

    fun open(cursor: String?, wantsScreens: Boolean): Flow<StreamFrame> {
        since += cursor
        screens += wantsScreens
        return onOpen(since.size, cursor) ?: frames
    }

    fun emit(frame: StreamFrame) {
        check(frames.tryEmit(frame)) { "stream buffer full" }
    }
}

internal class RecordingSink : NotificationSink {
    val delivered = mutableListOf<Pair<NotificationFrame, Int?>>()
    val badges = mutableListOf<Int>()

    override fun deliver(notification: NotificationFrame, sequence: Int?) {
        delivered += notification to sequence
    }

    override fun setBadge(count: Int) {
        badges += count
    }
}

/**
 * Stands in for the started [SessionLingerService]. Everything it reports —
 * a refused start, a service the system destroyed early — is something the real
 * anchor can report on a real device.
 */
internal class FakeAnchor(
    var refuseStart: Boolean = false,
    /**
     * Deliver `onDestroy` late, the way the framework does.
     *
     * `Context.stopService()` returns at once; the service's `onDestroy` — and
     * with it [SessionLingerController.onAnchorLost] — arrives afterwards on the
     * main looper. With this on, those callbacks queue up so a test can hand a
     * previous trip's destroy to the controller *after* a newer window is
     * already open. Off (the default) they are delivered inline, which is the
     * simpler ordering the other tests need.
     */
    private val deferDestroy: Boolean = false,
) : SessionLingerController.ProcessAnchor {
    private var controller: SessionLingerController? = null
    private val pendingDestroys = mutableListOf<Long>()

    val started = mutableListOf<Long>()
    val stopped = mutableListOf<Long>()
    var startAttempts = 0
        private set

    /** The token the "service" is currently alive for, or null. */
    var held: Long? = null
        private set

    override fun attach(controller: SessionLingerController) {
        this.controller = controller
    }

    override fun start(token: Long): Boolean {
        startAttempts += 1
        if (refuseStart) return false
        started += token
        held = token
        return true
    }

    override fun stop(token: Long) {
        stopped += token
        if (held == token) held = null
        if (deferDestroy) pendingDestroys += token else controller?.onAnchorLost(token)
    }

    /** The system reclaimed the service before the deadline. */
    fun destroyedBySystem() {
        val token = checkNotNull(held) { "no anchor is held" }
        held = null
        controller?.onAnchorLost(token)
    }

    /** Hand the controller every `onDestroy` that [deferDestroy] held back. */
    fun deliverPendingDestroys() {
        check(deferDestroy) { "this anchor delivers onDestroy inline" }
        val queued = pendingDestroys.toList()
        check(queued.isNotEmpty()) { "no onDestroy is pending" }
        pendingDestroys.clear()
        queued.forEach { controller?.onAnchorLost(it) }
    }
}

internal class TestOwner : LifecycleOwner {
    val registry = LifecycleRegistry.createUnsafe(this)
    override val lifecycle: Lifecycle get() = registry
}

internal fun store(connection: Connection?): ConnectionStore = object : ConnectionStore {
    override suspend fun load(): Connection? = connection
    override suspend fun save(connection: Connection) = Unit
    override suspend fun clear() = Unit
}

internal fun tokens(result: TokenStore.ReadResult): TokenStore = object : TokenStore {
    override suspend fun save(connectionId: String, token: String) = Unit
    override suspend fun read(connectionId: String): TokenStore.ReadResult = result
    override suspend fun remove(connectionId: String) = Unit
}

/**
 * The session every linger test drives, rooted at `backgroundScope`.
 *
 * That root is load-bearing for how these tests must be pumped.
 * `advanceUntilIdle()` never runs background work in
 * kotlinx-coroutines-test — not a freshly launched task, not a coroutine
 * already suspended in `delay`, not one waiting on a `Mutex`. So every
 * fire-and-forget call on this session (`connect`, `signOut`, `watchScreen`,
 * `stopWatchingScreen`, and the `restore()` its constructor launches) needs
 * `runCurrent()`, `yield()`, `advanceTimeBy(...)` or an `awaitRestored()` that
 * actually suspends between the call and any assertion that reads its result.
 *
 * An `advanceUntilIdle()` in that gap is a no-op, and a frame emitted across it
 * lands on a [FakeStream] with no collector yet and is dropped silently —
 * which leaves the test green while proving nothing. Use [installLive].
 */
internal fun TestScope.session(
    stream: FakeStream,
    sink: NotificationSink,
    connections: ConnectionStore = store(TEST_CONNECTION),
    tokenStore: TokenStore = tokens(TokenStore.ReadResult.Found("device-token")),
    hydrate: suspend () -> Fleet = { Fleet(emptyList(), emptyList()) },
): Session = Session(
    scope = backgroundScope,
    connectionStore = connections,
    tokenStore = tokenStore,
    onboardingStore = InMemoryOnboardingStore(),
    deviceNameProvider = { "Pixel" },
    notificationSink = sink,
    eventsFn = { _, since, screens -> stream.open(since, screens) },
    hydrateFn = { _, _ -> hydrate() },
)

/** The installed coordinator plus the handles the linger tests assert against. */
internal class LingerScene(
    val owner: TestOwner,
    val anchor: FakeAnchor,
    val controller: SessionLingerController,
)

/**
 * Install the real coordinator on a real lifecycle, take the app to the
 * foreground and (unless told otherwise) settle a live stream.
 *
 * `awaitRestored()` + `runCurrent()` rather than `advanceUntilIdle()`: the
 * session runs on `backgroundScope`, and `advanceUntilIdle` never runs
 * background work at all. The two assertions below are what make the
 * difference observable — without them a test can reach `ON_STOP` on a session
 * that is merely `Connecting`, having silently dropped the hello it thought it
 * had delivered.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal suspend fun TestScope.installLive(
    session: Session,
    stream: FakeStream,
    anchor: FakeAnchor = FakeAnchor(),
    awaitHello: Boolean = true,
    owner: TestOwner = TestOwner(),
): LingerScene {
    val controller = installSessionLinger(owner.registry, session, backgroundScope, anchor)
    owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
    owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    session.awaitRestored()
    runCurrent()
    if (awaitHello) {
        stream.emit(hello("s:1", resumed = false))
        runCurrent()
        assertEquals(Session.Status.Live, session.status.value)
        assertEquals(1, stream.opens)
    }
    return LingerScene(owner, anchor, controller)
}

internal fun hello(cursor: String, resumed: Boolean = true, seq: Int? = null): StreamFrame =
    StreamFrame(com.astra.companion.core.Frame.Hello(cursor, resumed), seq)

internal fun notify(
    kind: String,
    seq: Int,
    threadId: String = "t1",
    title: String = "Done",
    body: String = "The report is ready.",
): StreamFrame = StreamFrame(
    com.astra.companion.core.Frame.Notify(
        NotificationFrame(
            kind = kind,
            botId = "b1",
            botName = "Scout",
            threadId = threadId,
            title = title,
            body = body,
        ),
    ),
    seq = seq,
)

internal fun bot(id: String = "b1", threadId: String = "t1", unread: Boolean = false): Bot = Bot(
    id = id,
    threadId = threadId,
    name = id,
    title = "",
    description = "",
    notifications = true,
    color = "green",
    unread = unread,
    modelSelection = ModelSelection("instance-1", "model-1"),
    createdAt = 0.0,
)
