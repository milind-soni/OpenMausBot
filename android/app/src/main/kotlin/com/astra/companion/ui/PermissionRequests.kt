package com.astra.companion.ui

/** Where the "we have asked" flag lives. Not a secret; not backed up either. */
internal object PermissionPreferences {
    const val NAME = "astra.permissions"

    /** The on-disk file, named here so the backup rules can be asserted against it. */
    const val FILE = "$NAME.xml"

    const val ASKED_NOTIFICATIONS = "askedNotifications"

    /**
     * Literal rather than `Manifest.permission.POST_NOTIFICATIONS` for the same
     * reason `CompanionPermissions` spells out its own: it keeps this readable
     * from a plain JVM test with no android.jar behaviour behind it.
     */
    const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

    /** Composer dictation mic — asked only from the mic button's flow. */
    const val RECORD_AUDIO = "android.permission.RECORD_AUDIO"
}

/**
 * Every path that can put a runtime permission prompt on screen, and the flag
 * that records it happened, in one place.
 *
 * Two things launch the notification prompt: the root asks for whatever is
 * missing on first entry (notifications, nearby devices), and the Settings row
 * asks for notifications alone. Only the second used to record that it had asked,
 * so a permanent denial through the *first* — the common path, since it fires
 * before a person ever reaches Settings — was read as "never asked" after a
 * recreation, and the Settings button then performed a request the OS silently
 * drops.
 *
 * So the launch and the flag are the same call. Nothing else in the app holds a
 * launcher, which is what makes the invariant checkable rather than a convention:
 * **if a prompt was shown, the flag is set.**
 */
internal class PermissionRequests(
    private val markAsked: (String) -> Unit,
    private val launchMultiple: (Array<String>) -> Unit,
    private val launchSingle: (String) -> Unit,
    private val onNotificationResult: (Boolean) -> Unit,
    private val onRecordAudioResult: (Boolean) -> Unit = {},
    /**
     * Permissions whose "already asked" state has to outlive the process.
     * RECORD_AUDIO joins notifications so a permanent denial through the mic
     * button cannot be misread as "never asked" after a recreation.
     */
    private val tracked: Set<String> = setOf(
        PermissionPreferences.POST_NOTIFICATIONS,
        PermissionPreferences.RECORD_AUDIO,
    ),
) {
    /** The root's first-entry request for everything still missing. */
    fun request(permissions: Array<String>) {
        if (permissions.isEmpty()) return
        permissions.filter { it in tracked }.forEach(markAsked)
        launchMultiple(permissions)
    }

    /** The Settings row's request for one permission, or the composer mic. */
    fun request(permission: String) {
        if (permission in tracked) markAsked(permission)
        launchSingle(permission)
    }

    /** Results from either launcher, routed to whoever is showing that state. */
    fun onResults(results: Map<String, Boolean>) {
        results[PermissionPreferences.POST_NOTIFICATIONS]?.let(onNotificationResult)
        results[PermissionPreferences.RECORD_AUDIO]?.let(onRecordAudioResult)
    }
}
