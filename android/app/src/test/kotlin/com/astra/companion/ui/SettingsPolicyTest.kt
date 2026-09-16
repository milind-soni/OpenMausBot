package com.astra.companion.ui

import com.astra.companion.core.Connection
import com.astra.companion.core.ExportedTranscript
import com.astra.companion.core.Session
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class SettingsPolicyTest {

    @Test
    fun `every connection state has words for it`() {
        assertEquals("Connected", SettingsPolicy.statusText(Session.Status.Live))
        assertEquals("Connecting…", SettingsPolicy.statusText(Session.Status.Connecting))
        assertEquals("Not paired", SettingsPolicy.statusText(Session.Status.Unpaired))
        assertEquals(
            "Unpaired on the computer",
            SettingsPolicy.statusText(Session.Status.Unauthorized),
        )
        // Offline carries the advice string Session built; it is not restated.
        assertEquals(
            "You're offline.",
            SettingsPolicy.statusText(Session.Status.Offline("You're offline.")),
        )
    }

    @Test
    fun `the address uses the route display authority and says so when there is none`() {
        assertEquals(
            "192.168.1.42",
            SettingsPolicy.addressText(Connection(name = "n", host = "192.168.1.42", port = 8810)),
        )
        assertEquals(
            "https://mac.example:9443",
            SettingsPolicy.addressText(requireNotNull(Connection.parse("https://mac.example:9443"))),
        )
        assertEquals("—", SettingsPolicy.addressText(null))
    }

    /**
     * Both of these send the person to a named area of the desktop app, and that
     * area is called Phone (`ios/App/SettingsView.swift:289,302`). Pinned whole
     * rather than by keyword: a footer that still said "Companion" would satisfy
     * any assertion loose enough to survive the rename.
     */
    @Test
    fun `the footers name the desktop section that exists`() {
        assertEquals(
            "Removes the pairing from this phone only. To stop it reaching the computer at all, " +
                "remove the device in Astra → Settings → Phone.",
            SettingsPolicy.UNPAIR_FOOTER,
        )
        assertEquals(
            "Enter whatever Phone settings on your computer shows. The pairing itself is kept.",
            SettingsPolicy.EDIT_ADDRESS_MESSAGE,
        )
    }

    @Test
    fun `an IPv6 address keeps its brackets`() {
        assertEquals(
            "[fe80::1%eth0]",
            SettingsPolicy.addressText(
                Connection(name = "n", host = "[fe80::1%eth0]", port = 8810),
            ),
        )
    }
}

class AddressEditTest {

    @Test
    fun `the form accepts what Connection parse accepts`() {
        assertTrue(AddressEdit.isValid("192.168.1.42:8810"))
        assertTrue(AddressEdit.isValid("macbook.tail1234.ts.net:8810"))
        // A bare host is fine — Connection supplies the default companion port.
        assertTrue(AddressEdit.isValid("macbook.local"))
        assertTrue(AddressEdit.isValid("http://192.168.1.42:8810"))
        assertTrue(AddressEdit.isValid("[fe80::1]:8810"))
    }

    @Test
    fun `it refuses what would never dial`() {
        assertFalse(AddressEdit.isValid(""))
        assertFalse(AddressEdit.isValid("   "))
        assertFalse(AddressEdit.isValid("192.168.1.42:not-a-port"))
        assertFalse(AddressEdit.isValid("192.168.1.42:99999"))
        assertFalse(AddressEdit.isValid("has space:8810"))
    }
}

/**
 * The notification row, wired the way the app wires it: the controller never
 * writes the asked-flag itself — [PermissionRequests] does, as part of launching
 * any prompt. Testing the controller with a hand-written `request` lambda would
 * prove nothing about the path that actually broke.
 */
class NotificationPermissionControllerTest {

    /**
     * A whole app's worth of permission plumbing, minus Android: one prefs map
     * that outlives "recreation", one chokepoint, one controller.
     */
    private class Phone(
        var enabled: Boolean = false,
        var canRequest: Boolean = true,
        var rationale: Boolean = false,
    ) {
        /** Survives recreation; wiped by [freshInstall], as uninstall would. */
        private val prefs = mutableMapOf<String, Boolean>()

        var prompts = 0
            private set
        var settingsOpens = 0
            private set

        lateinit var controller: NotificationPermissionController
            private set
        lateinit var requests: PermissionRequests
            private set

        init {
            recreate()
        }

        /** Rebuilds both objects over the same prefs, as an Activity restart does. */
        fun recreate() {
            requests = PermissionRequests(
                markAsked = { prefs[it] = true },
                launchMultiple = { prompts += 1 },
                launchSingle = { prompts += 1 },
                onNotificationResult = { granted -> controller.onResult(granted) },
            )
            controller = NotificationPermissionController(
                isGranted = { enabled },
                canRequest = { canRequest },
                shouldShowRationale = { rationale },
                hasAskedBefore = {
                    prefs[PermissionPreferences.POST_NOTIFICATIONS] == true
                },
                request = { requests.request(PermissionPreferences.POST_NOTIFICATIONS) },
                openSettings = { settingsOpens += 1 },
            )
        }

        fun freshInstall() = prefs.clear()

        /** What CompanionRoot does on first entry: ask for everything missing. */
        fun rootRequestsMissingPermissions(vararg permissions: String) {
            requests.request(arrayOf(*permissions))
        }

        fun systemAnswers(vararg results: Pair<String, Boolean>) {
            requests.onResults(results.toMap())
        }

        fun asked(permission: String): Boolean = prefs[permission] == true
    }

    private val nearby = "android.permission.NEARBY_WIFI_DEVICES"
    private val notifications = PermissionPreferences.POST_NOTIFICATIONS

    @Test
    fun `notifications that are on need no button`() {
        val phone = Phone(enabled = true)
        assertEquals(NotificationAccess.GRANTED, phone.controller.access.value)
        assertFalse(NotificationPermissionController.buttonEnabled(NotificationAccess.GRANTED))
        assertEquals("Allowed", NotificationPermissionController.statusText(NotificationAccess.GRANTED))
    }

    @Test
    fun `the first tap asks the system and records the asking`() {
        val phone = Phone()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
        phone.controller.act()
        assertEquals(1, phone.prompts)
        assertEquals(0, phone.settingsOpens)
        assertTrue(phone.asked(notifications), "launching a prompt must record it")
    }

    // The finding: the root's multi-permission request is the common path, and it
    // used to launch the prompt without recording that it had.

    @Test
    fun `a permanent denial through the root's request survives recreation`() {
        val phone = Phone(rationale = false)
        // First entry: the root asks for everything still missing, notifications
        // among them. The Settings row is not involved.
        phone.rootRequestsMissingPermissions(notifications, nearby)
        assertTrue(phone.asked(notifications), "the root's request must record the asking")
        phone.systemAnswers(notifications to false, nearby to true)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)

        phone.recreate()
        assertEquals(
            NotificationAccess.BLOCKED,
            phone.controller.access.value,
            "a prompt spent through the root must not read as askable after recreation",
        )

        val before = phone.prompts
        phone.controller.act()
        assertEquals(before, phone.prompts, "recreation must not perform a dead request")
        assertEquals(1, phone.settingsOpens)
    }

    @Test
    fun `a request that does not include notifications records nothing`() {
        val phone = Phone()
        phone.rootRequestsMissingPermissions(nearby)
        assertFalse(phone.asked(notifications))
        phone.recreate()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
    }

    @Test
    fun `an empty request launches nothing`() {
        val phone = Phone()
        phone.rootRequestsMissingPermissions()
        assertEquals(0, phone.prompts)
    }

    @Test
    fun `a refusal the system will prompt again for stays askable`() {
        val phone = Phone(rationale = true)
        phone.controller.act()
        phone.systemAnswers(notifications to false)
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
        phone.controller.act()
        assertEquals(2, phone.prompts)
        assertEquals(0, phone.settingsOpens)
    }

    @Test
    fun `a refusal the system will not prompt again for routes to settings`() {
        val phone = Phone(rationale = false)
        phone.controller.act()
        phone.systemAnswers(notifications to false)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)

        phone.controller.act()
        assertEquals(1, phone.prompts, "a blocked permission must not re-request silently")
        assertEquals(1, phone.settingsOpens)
    }

    @Test
    fun `a permanent denial survives Activity and process recreation`() {
        val phone = Phone(rationale = false)
        phone.controller.act()
        phone.systemAnswers(notifications to false)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)

        phone.recreate()
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)
    }

    @Test
    fun `a fresh install can ask again`() {
        // The uninstall-resets premise: the flag must not outlive the install,
        // which is why the prefs file is excluded from backup and transfer.
        val phone = Phone(rationale = false)
        phone.controller.act()
        phone.systemAnswers(notifications to false)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)

        phone.freshInstall()
        phone.recreate()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
    }

    @Test
    fun `a phone that never asked still offers to ask after recreation`() {
        val phone = Phone()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
        phone.recreate()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
    }

    @Test
    fun `below API 33 blocked notifications route straight to settings`() {
        val phone = Phone(enabled = false, canRequest = false)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)
        phone.controller.act()
        assertEquals(0, phone.prompts)
        assertEquals(1, phone.settingsOpens)
    }

    @Test
    fun `below API 33 notifications that are on read as allowed`() {
        assertEquals(
            NotificationAccess.GRANTED,
            Phone(enabled = true, canRequest = false).controller.access.value,
        )
    }

    @Test
    fun `notifications switched off in settings stop reading as allowed`() {
        // The pre-33 and 33+ case alike: the grant is not the question,
        // areNotificationsEnabled is.
        val phone = Phone(enabled = true)
        assertEquals(NotificationAccess.GRANTED, phone.controller.access.value)
        phone.enabled = false
        phone.controller.refresh()
        assertNotEquals(NotificationAccess.GRANTED, phone.controller.access.value)
    }

    @Test
    fun `switching notifications off after the prompt was spent routes to settings`() {
        val phone = Phone(rationale = false)
        phone.controller.act()
        phone.enabled = true
        phone.systemAnswers(notifications to true)
        assertEquals(NotificationAccess.GRANTED, phone.controller.access.value)

        // Turned off in system settings afterwards. The prompt is already spent,
        // so the only thing that can help is the page they just came from.
        phone.enabled = false
        phone.controller.refresh()
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)
    }

    @Test
    fun `an install that never asked may still ask after notifications are off`() {
        val phone = Phone(enabled = true)
        phone.enabled = false
        phone.controller.refresh()
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
    }

    @Test
    fun `granting through the dialog is remembered`() {
        val phone = Phone()
        phone.controller.act()
        phone.enabled = true
        phone.systemAnswers(notifications to true)
        assertEquals(NotificationAccess.GRANTED, phone.controller.access.value)
    }

    @Test
    fun `a grant made in system settings takes effect on return`() {
        val phone = Phone()
        phone.controller.act()
        phone.systemAnswers(notifications to false)
        assertEquals(NotificationAccess.BLOCKED, phone.controller.access.value)

        phone.enabled = true
        phone.controller.refresh()
        assertEquals(NotificationAccess.GRANTED, phone.controller.access.value)
    }

    @Test
    fun `acting while granted never asks for anything`() {
        val phone = Phone(enabled = true)
        phone.controller.act()
        assertEquals(0, phone.prompts)
        assertEquals(0, phone.settingsOpens)
    }

    @Test
    fun `a result that claims a grant the system denies is not believed`() {
        val phone = Phone(enabled = false, rationale = true)
        phone.systemAnswers(notifications to true)
        assertEquals(NotificationAccess.ASKABLE, phone.controller.access.value)
    }

    @Test
    fun `the blocked button names the settings page it opens`() {
        assertEquals(
            "Open notification settings",
            NotificationPermissionController.buttonText(NotificationAccess.BLOCKED),
        )
        assertEquals(
            "Turned off in system settings",
            NotificationPermissionController.statusText(NotificationAccess.BLOCKED),
        )
    }
}

class SharePayloadTest {

    private fun export(filename: String, contentType: String = "text/markdown") =
        ExportedTranscript(
            data = "# hello".toByteArray(),
            filename = filename,
            contentType = contentType,
        )

    @Test
    fun `the server's filename is used when it is safe`() {
        assertEquals(
            "scout-2026-08-19.md",
            SharePayload.fileName(export("scout-2026-08-19.md"), ShareFormat.MARKDOWN),
        )
    }

    @Test
    fun `a filename cannot escape the cache directory`() {
        // This names a file the app is about to write, so a directory part in it
        // is a path traversal, not a preference.
        for (hostile in listOf(
            "../../../../data/data/com.astra.companion/databases/tokens.db",
            "/etc/passwd",
            "..\\..\\windows\\system32\\evil.md",
            "sub/dir/transcript.md",
        )) {
            val name = SharePayload.fileName(export(hostile), ShareFormat.MARKDOWN)
            assertFalse(name.contains('/'), hostile)
            assertFalse(name.contains('\\'), hostile)
            assertFalse(name.contains(".."), hostile)
        }
    }

    @Test
    fun `a hostile or empty filename falls back to the format's own`() {
        assertEquals("transcript.md", SharePayload.fileName(export(""), ShareFormat.MARKDOWN))
        assertEquals("transcript.md", SharePayload.fileName(export("   "), ShareFormat.MARKDOWN))
        assertEquals("transcript.json", SharePayload.fileName(export("/"), ShareFormat.JSON))
        assertEquals("transcript.md", SharePayload.fileName(export("..."), ShareFormat.MARKDOWN))
    }

    @Test
    fun `the extension matches the format that was asked for`() {
        assertEquals("notes.json", SharePayload.fileName(export("notes"), ShareFormat.JSON))
        assertEquals("notes.md", SharePayload.fileName(export("notes"), ShareFormat.MARKDOWN))
        // Already correct, so not doubled.
        assertEquals("notes.md", SharePayload.fileName(export("notes.md"), ShareFormat.MARKDOWN))
    }

    @Test
    fun `a very long filename is trimmed`() {
        val name = SharePayload.fileName(export("a".repeat(500)), ShareFormat.MARKDOWN)
        assertTrue(name.length <= 100, name.length.toString())
        assertTrue(name.endsWith(".md"))
    }

    @Test
    fun `the wire's content type is used when it is one`() {
        assertEquals(
            "application/json",
            SharePayload.mimeType(export("t.json", "application/json"), ShareFormat.JSON),
        )
        // A charset parameter is dropped: Intent types are bare.
        assertEquals(
            "text/markdown",
            SharePayload.mimeType(export("t.md", "text/markdown; charset=utf-8"), ShareFormat.MARKDOWN),
        )
    }

    @Test
    fun `a nonsense content type falls back to the format's own`() {
        for (hostile in listOf("", "   ", "not a mime", "text/", "/json", "text/plain\nX: y")) {
            assertEquals(
                ShareFormat.JSON.mime,
                SharePayload.mimeType(export("t.json", hostile), ShareFormat.JSON),
                hostile,
            )
        }
    }

    @Test
    fun `the two formats carry the wire names the harness expects`() {
        assertEquals("markdown", ShareFormat.MARKDOWN.wire)
        assertEquals("json", ShareFormat.JSON.wire)
        assertEquals(2, ShareFormat.entries.size)
    }
}
