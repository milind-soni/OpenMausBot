package com.openmausbot.companion.ui

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import com.openmausbot.companion.audio.VoicePreviewPlayer
import com.openmausbot.companion.avatar.AvatarImageStore
import com.openmausbot.companion.core.ExportedTranscript
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.dictation.SpeechDictation
import java.net.URI
import com.openmausbot.companion.discovery.CompanionDiscovery
import com.openmausbot.companion.permissions.CompanionPermissions
import com.openmausbot.companion.sharing.ShareInbox
import com.openmausbot.companion.storage.OnboardingPreferences
import com.openmausbot.companion.storage.ChatPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Camera access, as the scanner needs to reason about it. */
enum class CameraAccess { UNKNOWN, GRANTED, DENIED }

/**
 * Camera permission is asked for at the moment the user opens the scanner and
 * never before — the app is usable without a camera (Bonjour list, typed
 * address), so a launch-time prompt would be asking for something most sessions
 * never use.
 */
class CameraPermissionController(
    private val isGranted: () -> Boolean,
    private val request: () -> Unit,
) {
    private val _access = MutableStateFlow(if (isGranted()) CameraAccess.GRANTED else CameraAccess.UNKNOWN)
    val access: StateFlow<CameraAccess> = _access.asStateFlow()

    /** Ask once; the OS shows the sheet only while the answer is still unknown. */
    fun ensure() {
        if (isGranted()) {
            _access.value = CameraAccess.GRANTED
            return
        }
        request()
    }

    fun onResult(granted: Boolean) {
        _access.value = if (granted) CameraAccess.GRANTED else CameraAccess.DENIED
    }

    /** Recover immediately when the user returns from Settings having granted it. */
    fun refresh() {
        if (isGranted()) _access.value = CameraAccess.GRANTED
    }
}

/**
 * Microphone permission for composer dictation. Asked only from the mic button,
 * through [PermissionRequests] so the asked-flag has a single owner. Callers
 * pass a result callback; a stop that races the system sheet is discarded by
 * [SpeechDictation]'s generation guard, not by dropping this callback.
 */
class MicPermissionController(
    private val isGranted: () -> Boolean,
    private val request: () -> Unit,
) {
    private var pending: ((Boolean) -> Unit)? = null

    fun ensure(onResult: (Boolean) -> Unit) {
        if (isGranted()) {
            onResult(true)
            return
        }
        pending = onResult
        request()
    }

    fun onResult(granted: Boolean) {
        val callback = pending
        pending = null
        callback?.invoke(granted)
    }

    fun refresh() {
        // No published state — SpeechDictation re-checks grant on each start.
        if (isGranted()) {
            val callback = pending
            pending = null
            callback?.invoke(true)
        }
    }
}

/**
 * The SwiftUI `@EnvironmentObject` analogue: the long-lived objects every screen
 * reaches for, provided once at the top of the composition.
 */
@Immutable
class CompanionEnvironment(
    val session: Session,
    val permissions: CompanionPermissions,
    val discovery: CompanionDiscovery,
    /**
     * The three durable first-run markers. The same instance [Session] writes
     * the pending marker into when a pairing commits, so the root router reads
     * what the commit wrote without a second copy of the truth.
     */
    val onboarding: OnboardingPreferences,
    /** Phone-local transcript and composer presentation choices. */
    val chatPreferences: ChatPreferences,
    val camera: CameraPermissionController,
    val mic: MicPermissionController,
    val notifications: NotificationPermissionController,
    /** Bounded in-memory avatar bytes/bitmaps; cleared on sign-out. */
    val avatars: AvatarImageStore,
    /** One-at-a-time TTS preview; bind to the profile screen lifecycle. */
    val voicePreview: VoicePreviewPlayer,
    /** Composer dictation; bind to the chat screen lifecycle. */
    val dictation: SpeechDictation,
    /**
     * Volatile composer drafts keyed by [com.openmausbot.companion.core.Chat.id].
     * Survives Computer navigation without entering saved state.
     */
    val chatDrafts: ChatDraftHolder,
    /** Fires the activity's `RequestMultiplePermissions` launcher. */
    val requestPermissions: (Array<String>) -> Unit,
    /** Opens the OS app-settings page, for a permission the user denied. */
    val openAppSettings: () -> Unit,
    /** Hands an exported transcript to the share sheet; null on success. */
    val shareTranscript: (ExportedTranscript, ShareFormat) -> String?,
    /** Opens a freshly minted cloud-desktop URL in Custom Tabs; null on success. */
    val openCloudDesktop: (URI) -> String?,
    /** Inbound share copied off the sending app's Intent. */
    val shareInbox: ShareInbox,
    /** Whether [com.openmausbot.companion.lifecycle.AlwaysOnConnectionService] is enabled. */
    val alwaysOnEnabled: StateFlow<Boolean>,
    /** Flips the always-on setting and starts/stops the service to match. */
    val onToggleAlwaysOn: () -> Unit,
)

val LocalCompanion = staticCompositionLocalOf<CompanionEnvironment> {
    error("CompanionEnvironment was not provided")
}
