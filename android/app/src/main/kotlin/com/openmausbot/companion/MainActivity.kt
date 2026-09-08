package com.openmausbot.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.LocaleList
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.openmausbot.companion.dictation.SpeechDictation
import com.openmausbot.companion.lifecycle.AlwaysOnConnectionService
import com.openmausbot.companion.notifications.notificationTarget
import com.openmausbot.companion.browser.CloudDesktopBrowser
import com.openmausbot.companion.sharing.TranscriptSharing
import com.openmausbot.companion.storage.ChatPreferences
import android.os.PowerManager
import com.openmausbot.companion.ui.CameraPermissionController
import com.openmausbot.companion.ui.ChatDraftHolder
import com.openmausbot.companion.ui.CompanionEnvironment
import com.openmausbot.companion.ui.CompanionRoot
import com.openmausbot.companion.ui.LocalCompanion
import com.openmausbot.companion.ui.MicPermissionController
import com.openmausbot.companion.ui.NotificationAccess
import com.openmausbot.companion.ui.NotificationPermissionController
import com.openmausbot.companion.ui.PermissionPreferences
import com.openmausbot.companion.ui.PermissionRequests
import com.openmausbot.companion.ui.PendingThreadNavigation

/**
 * The single Activity. It owns the permission launchers and the one thing that
 * arrives as an Intent here — a notification tap — and hands the rest to Compose.
 * Pairing deep links and inbound shares each have their own trampoline, so this
 * root Activity never receives a credential or another app's content URI.
 *
 * Connect/disconnect is not here: `OpenMausApp` drives it from
 * `ProcessLifecycleOwner`, which is the Android shape of iOS's `scenePhase`.
 */
class MainActivity : ComponentActivity() {
    private val app: OpenMausApp
        get() = application as OpenMausApp

    /** Notification tap → `(botId, threadId)`; delivered to the UI once. */
    private lateinit var notificationNavigation: PendingThreadNavigation

    private lateinit var camera: CameraPermissionController
    private lateinit var mic: MicPermissionController
    private lateinit var dictation: SpeechDictation
    private lateinit var chatDrafts: ChatDraftHolder
    private lateinit var notifications: NotificationPermissionController
    private lateinit var permissionRequests: PermissionRequests

    /** Tracks which single-permission launch is in flight for [singlePermissionLauncher]. */
    private var pendingSinglePermission: String? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        // Re-read platform state instead of treating the launcher result map as
        // a second source of truth.
        app.permissions.refresh()
        permissionRequests.onResults(results)
    }

    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        camera.onResult(granted)
    }

    private val singlePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val permission = pendingSinglePermission
        pendingSinglePermission = null
        app.permissions.refresh()
        if (permission != null) {
            permissionRequests.onResults(mapOf(permission to granted))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        notificationNavigation = PendingThreadNavigation(
            savedInstanceState?.getString(STATE_CONSUMED_NOTIFICATION),
        )

        camera = CameraPermissionController(
            isGranted = {
                ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
            },
            request = { cameraLauncher.launch(Manifest.permission.CAMERA) },
        )

        mic = MicPermissionController(
            isGranted = { app.permissions.recordAudioGranted() },
            request = {
                permissionRequests.request(PermissionPreferences.RECORD_AUDIO)
            },
        )

        val permissionPrefs = getSharedPreferences(PermissionPreferences.NAME, MODE_PRIVATE)
        // The only thing in the app that launches a permission prompt, so the
        // "we have asked" flag cannot be missed by a path that forgot to write it.
        permissionRequests = PermissionRequests(
            markAsked = { permission ->
                permissionPrefs.edit().putBoolean(askedKey(permission), true).apply()
            },
            launchMultiple = { permissions -> permissionLauncher.launch(permissions) },
            launchSingle = { permission ->
                pendingSinglePermission = permission
                singlePermissionLauncher.launch(permission)
            },
            onNotificationResult = { granted -> notifications.onResult(granted) },
            onRecordAudioResult = { granted -> mic.onResult(granted) },
        )

        notifications = NotificationPermissionController(
            // The runtime grant is not the question: notifications can be off in
            // system settings on any version, including below API 33 where no
            // runtime permission exists at all.
            isGranted = { NotificationManagerCompat.from(this).areNotificationsEnabled() },
            canRequest = { Build.VERSION.SDK_INT >= 33 },
            shouldShowRationale = {
                Build.VERSION.SDK_INT >= 33 &&
                    shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
            },
            // Outlives the Activity and the process, so a recreation cannot turn a
            // spent prompt back into a live-looking button. Not a secret.
            hasAskedBefore = {
                permissionPrefs.getBoolean(
                    askedKey(PermissionPreferences.POST_NOTIFICATIONS),
                    false,
                )
            },
            request = {
                if (Build.VERSION.SDK_INT >= 33) {
                    permissionRequests.request(PermissionPreferences.POST_NOTIFICATIONS)
                }
            },
            openSettings = ::openNotificationSettings,
        )

        dictation = SpeechDictation(
            context = this,
            hasRecordAudio = { app.permissions.recordAudioGranted() },
            requestRecordAudio = { onResult -> mic.ensure(onResult) },
            preferredLanguages = ::preferredLanguageTags,
        )
        // Process memory only — outlives ChatScreen when Computer is on top,
        // dies with the Activity so rotation never restores spoken text.
        // Built once here and handed into CompanionEnvironment for the
        // Activity lifetime; LoadedChat still keys its saver on this instance
        // so a future environment swap cannot restore into a stale holder.
        chatDrafts = ChatDraftHolder()

        val sharing = TranscriptSharing(this)
        val browser = CloudDesktopBrowser(this)

        val environment = CompanionEnvironment(
            session = app.session,
            permissions = app.permissions,
            discovery = app.discovery,
            onboarding = app.onboarding,
            chatPreferences = ChatPreferences(this),
            camera = camera,
            mic = mic,
            notifications = notifications,
            avatars = app.avatars,
            voicePreview = app.voicePreview,
            dictation = dictation,
            chatDrafts = chatDrafts,
            requestPermissions = { permissions -> permissionRequests.request(permissions) },
            openAppSettings = ::openAppSettings,
            shareTranscript = sharing::share,
            openCloudDesktop = browser::open,
            shareInbox = app.shareInbox,
            alwaysOnEnabled = app.alwaysOn.enabled,
            onToggleAlwaysOn = ::toggleAlwaysOn,
        )

        handleIntent(intent)

        setContent {
            val pendingTarget by notificationNavigation.pending.collectAsState()
            CompositionLocalProvider(LocalCompanion provides environment) {
                CompanionRoot(
                    pendingNotification = pendingTarget,
                    onPendingTargetConsumed = notificationNavigation::consume,
                )
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_CONSUMED_NOTIFICATION, notificationNavigation.consumedToken())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A tap that arrives while the app is already up is always a new request,
        // even for a target that was opened from a notification before.
        handleIntent(intent, fresh = true)
    }

    override fun onResume() {
        super.onResume()
        // Permissions can change while the app is in the background — a grant
        // made in Settings should take effect on return, not on next launch.
        app.permissions.refresh()
        camera.refresh()
        mic.refresh()
        notifications.refresh()
    }

    override fun onDestroy() {
        // Activity teardown releases the recognizer; process-background stop is
        // already handled inside SpeechDictation via ProcessLifecycleOwner.
        if (isFinishing && ::dictation.isInitialized) dictation.stop()
        super.onDestroy()
    }

    /**
     * Deliberately reads only the notification extras.
     *
     * Pairing deep links belong to [PairingLinkActivity] and never reach here:
     * this Activity is the root of the main task, so the system keeps and may
     * persist its launching Intent, and a one-time credential must not live
     * anywhere the process does not. Ignoring `intent.data` outright also means
     * another app cannot hand this exported Activity a crafted pairing URL.
     */
    private fun handleIntent(intent: Intent?, fresh: Boolean = false) {
        if (intent == null) return

        // The extras deliberately stay on the Intent: PendingThreadNavigation
        // remembers what has already been opened, so a rotation before the
        // composition consumed it still navigates, and one after it does not.
        notificationNavigation.offer(intent.notificationTarget(), fresh = fresh)
    }

    /**
     * The app's own notification page, which is where notifications are turned
     * back on — the generic app-details page is a level further away and, below
     * API 33, the only place the switch exists at all.
     */
    private fun openNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        if (intent.resolveActivity(packageManager) != null) {
            startActivity(intent)
        } else {
            openAppSettings()
        }
    }

    private fun openAppSettings() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", packageName, null)
            },
        )
    }

    /**
     * Flip the setting, start/stop the service to match, and — only when
     * turning it on — ask once to be exempted from battery optimizations.
     * Without that exemption Android's Doze/App Standby can still suspend a
     * foreground service's network access on some OEM skins, which would make
     * the persistent notification a lie. This is a plain `startActivity`, not a
     * permission launcher: the system dialog's own Allow/Deny is the answer,
     * and `onResume`'s refresh (via `NotificationPermissionController` et al.)
     * already covers "state changed while backgrounded" for the rest of the
     * screen, so nothing here needs to await a result.
     */
    private fun toggleAlwaysOn() {
        val enabling = !app.alwaysOn.enabled.value
        if (enabling && notifications.access.value != NotificationAccess.GRANTED) {
            // A background connection whose notifications can't post is a
            // foreground service and battery cost for nothing — send the user
            // to fix that first instead of turning this on silently broken.
            notifications.act()
            return
        }
        if (!app.alwaysOn.setEnabled(enabling)) return
        if (enabling) {
            AlwaysOnConnectionService.start(this)
            requestIgnoreBatteryOptimizations()
        } else {
            AlwaysOnConnectionService.stop(this)
        }
    }

    private fun requestIgnoreBatteryOptimizations() {
        val powerManager = getSystemService(PowerManager::class.java) ?: return
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:$packageName"))
        if (intent.resolveActivity(packageManager) != null) {
            startActivity(intent)
        }
    }

    private fun preferredLanguageTags(): List<String> {
        val list = LocaleList.getDefault()
        return buildList(list.size()) {
            for (i in 0 until list.size()) {
                add(list[i].toLanguageTag())
            }
        }
    }

    private companion object {
        const val STATE_CONSUMED_NOTIFICATION = "openmaus.consumedNotification"

        /** One key per tracked permission, so a second one needs no new plumbing. */
        fun askedKey(permission: String): String =
            "${PermissionPreferences.ASKED_NOTIFICATIONS}:$permission"
    }
}
