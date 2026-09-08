package com.openmausbot.companion.onboarding

import android.Manifest
import android.app.Application
import android.content.Context
import com.openmausbot.companion.avatar.AvatarImageStore
import com.openmausbot.companion.core.APIError
import com.openmausbot.companion.core.CompanionClient
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.ConnectionStore
import com.openmausbot.companion.core.Fleet
import com.openmausbot.companion.core.PairResponse
import com.openmausbot.companion.core.PairedDevice
import com.openmausbot.companion.core.PairingOutcome
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
import com.openmausbot.companion.ui.CameraPermissionController
import com.openmausbot.companion.ui.ChatDraftHolder
import com.openmausbot.companion.ui.CompanionEnvironment
import com.openmausbot.companion.ui.MicPermissionController
import com.openmausbot.companion.ui.NotificationPermissionController
import com.openmausbot.companion.ui.PermissionPreferences
import com.openmausbot.companion.audio.VoicePreviewPlayer
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.awaitCancellation
import org.robolectric.RuntimeEnvironment

/**
 * A whole [CompanionEnvironment] made of fakes that answer questions no boolean
 * can.
 *
 * The rules this pass installs are about *when* the app does something to the
 * outside world — asks the system for a permission, starts browsing the network
 * — and neither is visible in any value a screen exposes. So the seams that
 * reach outside are recorders: [permissionRequests] keeps every launch in order,
 * and [FakeDiscovery] counts the collections a browse would have been. A test
 * mounts the real composition against these and reads what it did.
 */
class OnboardingScene(
    /** Answers `granted(permission)`; add to it to simulate a grant. */
    val granted: MutableSet<String> = mutableSetOf(),
    sdkInt: Int = 34,
    notificationsEnabled: Boolean = false,
    canRequestNotifications: Boolean = true,
    shouldShowNotificationRationale: Boolean = true,
    hasAskedNotificationsBefore: Boolean = false,
    savedConnection: Connection? = null,
    savedToken: String? = null,
    /** The computer answers 401: the token was revoked on the other side. */
    private val revoked: Boolean = false,
    /** When set, a redemption suspends here — an attempt held in flight. */
    private val pairSuspendsUntil: kotlinx.coroutines.CompletableDeferred<Unit>? = null,
    notificationOnboardingPending: Boolean = false,
    welcomeSeen: Boolean = false,
    notificationPromptSeen: Boolean = false,
) {
    private val context: Context = RuntimeEnvironment.getApplication() as Application
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Every permission launch, in order, flattened to the names asked for. */
    val permissionRequests = mutableListOf<List<String>>()

    /** How many times something started a browse. */
    val discovery = FakeDiscovery()

    var notificationsAreEnabled = notificationsEnabled

    private val prefsName = "onboarding-scene-${SCENES.incrementAndGet()}"

    val onboarding = OnboardingPreferences(
        prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE),
        // Inline rather than Dispatchers.IO: a Compose test's idling clock does
        // not wait for a real background thread, and what is under test here is
        // the ordering of the app's own calls, not the dispatcher.
        io = EmptyCoroutineContext,
    )

    val permissions = CompanionPermissions(sdkInt = sdkInt, granted = { it in granted })

    val notifications = NotificationPermissionController(
        isGranted = { notificationsAreEnabled },
        canRequest = { canRequestNotifications },
        shouldShowRationale = { shouldShowNotificationRationale },
        hasAskedBefore = { hasAskedNotificationsBefore },
        request = { record(listOf(PermissionPreferences.POST_NOTIFICATIONS)) },
        openSettings = { record(listOf("settings:notifications")) },
    )

    val session = Session(
        scope = scope,
        connectionStore = FakeConnectionStore(savedConnection),
        tokenStore = FakeTokenStore(savedConnection?.id, savedToken),
        onboardingStore = onboarding,
        deviceNameProvider = { "Pixel" },
        clientFactory = { c, token -> CompanionClient(c, token) },
        pairFn = { c, _, _, _ ->
            pairSuspendsUntil?.await()
            PairingOutcome(
                PairResponse(
                    token = "device-token",
                    device = PairedDevice("d1", "Pixel", 1.0, 1.0),
                    serverName = "Mac",
                ),
                c,
            )
        },
        // A 401 straight out of the stream is the shortest deterministic path
        // to Unauthorized: `runStream` catches it and stops, with no reconnect
        // delay for a test to wait out.
        eventsFn = { _, _, _ ->
            if (revoked) flow<StreamFrame> { throw APIError.Status(401, "revoked") } else emptyFlow()
        },
        hydrateFn = { _, _ -> Fleet(emptyList(), emptyList()) },
        metadataFn = { throw APIError.Status(404) },
    )

    val environment = CompanionEnvironment(
        session = session,
        permissions = permissions,
        discovery = discovery,
        onboarding = onboarding,
        chatPreferences = ChatPreferences(context),
        camera = CameraPermissionController(
            isGranted = { "android.permission.CAMERA" in granted },
            request = { record(listOf("android.permission.CAMERA")) },
        ),
        mic = MicPermissionController(
            isGranted = { Manifest.permission.RECORD_AUDIO in granted },
            request = { record(listOf(Manifest.permission.RECORD_AUDIO)) },
        ),
        notifications = notifications,
        avatars = AvatarImageStore(fetch = { null }),
        voicePreview = VoicePreviewPlayer(context),
        dictation = SpeechDictation(
            context = context,
            hasRecordAudio = { false },
            requestRecordAudio = { it(false) },
            preferredLanguages = { listOf("en-US") },
        ),
        chatDrafts = ChatDraftHolder(),
        requestPermissions = { permissions -> record(permissions.toList()) },
        openAppSettings = { record(listOf("settings:app")) },
        shareTranscript = { _, _ -> null },
        openCloudDesktop = { null },
        shareInbox = ShareInbox(),
        alwaysOnEnabled = MutableStateFlow(false),
        onToggleAlwaysOn = {},
    )

    init {
        runBlockingWrite {
            if (welcomeSeen) onboarding.setWelcomeSeen(true)
            if (notificationPromptSeen) onboarding.setNotificationPromptSeen(true)
            if (notificationOnboardingPending) {
                onboarding.setNotificationOnboardingPending(true)
            }
        }
    }

    private fun record(permissions: List<String>) {
        permissionRequests += permissions
    }

    /** Everything asked for so far, flattened. */
    fun asked(): List<String> = permissionRequests.flatten()

    /**
     * The same durable file, read by a store that has never seen this process —
     * the shape a relaunch has. Anything this reports is on disk, not in a
     * StateFlow the composition happened to leave behind.
     */
    fun relaunchedOnboarding() = OnboardingPreferences(
        prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE),
        io = EmptyCoroutineContext,
    )

    private fun runBlockingWrite(block: suspend () -> Unit) =
        kotlinx.coroutines.runBlocking { block() }

    /**
     * A discovery that never finds anything, and remembers being asked.
     *
     * [starts] counts collections, not calls to [discover]: the production flow
     * is cold, so building it costs nothing and only collecting it browses.
     * [active] says whether a browse is running right now, which is how a test
     * can see a panel being closed tear one down.
     */
    class FakeDiscovery : CompanionDiscovery {
        val starts = MutableStateFlow(0)
        val active = MutableStateFlow(0)

        override fun discover(): Flow<DiscoveryState> = flow {
            starts.value += 1
            active.value += 1
            try {
                emit(DiscoveryState.Active(browsing = true, found = emptyList()))
                awaitCancellation()
            } finally {
                active.value -= 1
            }
        }
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
            tokens[connectionId]?.let(TokenStore.ReadResult::Found)
                ?: TokenStore.ReadResult.Missing
        override suspend fun remove(connectionId: String) {
            tokens.remove(connectionId)
        }
    }

    companion object {
        /** One preferences file per scene, so scenes cannot read each other. */
        private val SCENES = AtomicInteger(0)

        val MAC = Connection(id = "c1", name = "Mac", host = "127.0.0.1", port = 8810)
    }
}
