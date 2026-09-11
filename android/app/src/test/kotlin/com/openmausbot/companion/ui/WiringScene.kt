package com.openmausbot.companion.ui

import android.app.Application
import android.content.Context
import com.openmausbot.companion.audio.VoicePreviewPlayer
import com.openmausbot.companion.avatar.AvatarImageStore
import com.openmausbot.companion.core.APIError
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.ConnectionStore
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.StreamFrame
import com.openmausbot.companion.core.TokenStore
import com.openmausbot.companion.dictation.SpeechDictation
import com.openmausbot.companion.discovery.CompanionDiscovery
import com.openmausbot.companion.discovery.DiscoveryState
import com.openmausbot.companion.permissions.CompanionPermissions
import com.openmausbot.companion.sharing.ShareInbox
import com.openmausbot.companion.storage.ChatPreferences
import com.openmausbot.companion.storage.OnboardingPreferences
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import org.robolectric.RuntimeEnvironment

/**
 * A whole [CompanionEnvironment] around a real [Session], for the screens whose
 * behaviour is a *call* rather than a value.
 *
 * `OnboardingScene` does this for the first-run router; this is the same idea
 * one screen down, where what has to be measured is whether a button or a
 * lifecycle event reaches the session at all. The session is real because that
 * is the point: a fake that records `refresh()` would agree with a screen that
 * calls it in the wrong place, or twice.
 *
 * Two seams answer the two questions:
 *
 * - [streamStarts] counts *collections* of the event stream, and only
 *   `connect()` and `refresh()` start one. It is incremented inside the flow
 *   builder, so building the flow costs nothing and only collecting it counts.
 * - [events] hands each stream its own body, so a test can hold one open —
 *   which is what keeps `refresh()` in flight long enough to observe.
 *
 * A connection makes the session build a real client against whatever address
 * it was given, so a test that needs traffic can point it at a socket.
 */
internal class WiringScene(
    connection: Connection? = null,
    token: String? = "device-token",
    /** The body of the nth stream (1-based). Hangs by default, like a live SSE. */
    private val events: (Int) -> Flow<StreamFrame> = { flow { awaitCancellation() } },
) {
    private val context: Context = RuntimeEnvironment.getApplication() as Application
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** How many times something opened the event stream. */
    val streamStarts = AtomicInteger(0)

    private val onboarding = OnboardingPreferences(
        prefs = context.getSharedPreferences(
            "wiring-scene-${SCENES.incrementAndGet()}",
            Context.MODE_PRIVATE,
        ),
        // Inline rather than Dispatchers.IO: a Compose test's clock does not wait
        // for a real background thread.
        io = EmptyCoroutineContext,
    )

    val session = Session(
        scope = scope,
        connectionStore = FakeConnectionStore(connection),
        tokenStore = FakeTokenStore(connection?.id, token),
        onboardingStore = onboarding,
        deviceNameProvider = { "Pixel" },
        eventsFn = { _, _, _ -> flow { emitAll(events(streamStarts.incrementAndGet())) } },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        metadataFn = { throw APIError.Status(404) },
    )

    val environment = CompanionEnvironment(
        session = session,
        permissions = CompanionPermissions(sdkInt = 34, granted = { true }),
        discovery = SilentDiscovery,
        onboarding = onboarding,
        chatPreferences = ChatPreferences(context),
        camera = CameraPermissionController(isGranted = { true }, request = {}),
        mic = MicPermissionController(isGranted = { true }, request = {}),
        notifications = NotificationPermissionController(
            isGranted = { true },
            canRequest = { false },
            shouldShowRationale = { false },
            hasAskedBefore = { true },
            request = {},
            openSettings = {},
        ),
        avatars = AvatarImageStore(fetch = { null }),
        voicePreview = VoicePreviewPlayer(context),
        dictation = SpeechDictation(
            context = context,
            hasRecordAudio = { false },
            requestRecordAudio = { it(false) },
            preferredLanguages = { listOf("en-US") },
        ),
        chatDrafts = ChatDraftHolder(),
        requestPermissions = {},
        openAppSettings = {},
        shareTranscript = { _, _ -> null },
        openCloudDesktop = { null },
        shareInbox = ShareInbox(),
        alwaysOnEnabled = MutableStateFlow(false),
        onToggleAlwaysOn = {},
    )

    private object SilentDiscovery : CompanionDiscovery {
        override fun discover(): Flow<DiscoveryState> = emptyFlow()
    }

    private class FakeConnectionStore(private var saved: Connection?) : ConnectionStore {
        override suspend fun load(): Connection? = saved
        override suspend fun save(connection: Connection) {
            saved = connection
        }
        override suspend fun clear() {
            saved = null
        }
    }

    private class FakeTokenStore(id: String?, token: String?) : TokenStore {
        private val tokens = linkedMapOf<String, String>().apply {
            if (id != null && token != null) put(id, token)
        }
        override suspend fun save(connectionId: String, token: String) {
            tokens[connectionId] = token
        }
        override suspend fun read(connectionId: String): TokenStore.ReadResult =
            tokens[connectionId]?.let(TokenStore.ReadResult::Found) ?: TokenStore.ReadResult.Missing
        override suspend fun remove(connectionId: String) {
            tokens.remove(connectionId)
        }
    }

    private companion object {
        /** One preferences file per scene, so scenes cannot read each other. */
        val SCENES = AtomicInteger(0)
    }
}
