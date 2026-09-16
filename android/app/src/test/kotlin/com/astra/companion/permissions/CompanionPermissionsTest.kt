package com.astra.companion.permissions

import android.Manifest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CompanionPermissionsTest {
    @Test
    fun api37RequestsOnlyWhatLocalDiscoveryNeeds() {
        val granted = mutableSetOf<String>()
        val permissions = CompanionPermissions(
            sdkInt = 37,
            granted = { it in granted },
        )
        assertEquals(
            listOf(
                Manifest.permission.NEARBY_WIFI_DEVICES,
                CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK,
            ),
            permissions.discoveryPermissions().toList(),
        )
        assertFalse(
            permissions.discoveryPermissions().contains(Manifest.permission.POST_NOTIFICATIONS),
            "opening the list of nearby computers must not ask for notifications",
        )
        assertTrue(permissions.snapshot.value.discoveryNeedsRequest)
    }

    @Test
    fun api32NeedsNoRuntimeCompanionPermissions() {
        val permissions = CompanionPermissions(
            sdkInt = 32,
            granted = { false },
        )
        assertTrue(permissions.discoveryPermissions().isEmpty())
    }

    @Test
    fun refreshUpdatesObservableDiscoveryStateFromPlatformGrants() {
        val granted = mutableSetOf<String>()
        val permissions = CompanionPermissions(
            sdkInt = 33,
            granted = { it in granted },
        )
        assertTrue(permissions.snapshot.value.discoveryNeedsRequest)
        granted += Manifest.permission.NEARBY_WIFI_DEVICES
        val snap = permissions.refresh()
        assertFalse(snap.discoveryNeedsRequest)
    }

    @Test
    fun recordAudioIsNeverPartOfTheStartupPrompt() {
        var recordAudioGranted = false
        val permissions = CompanionPermissions(
            sdkInt = 37,
            granted = { it == Manifest.permission.RECORD_AUDIO && recordAudioGranted },
        )
        assertFalse(permissions.recordAudioGranted())
        assertFalse(
            permissions.discoveryPermissions().contains(Manifest.permission.RECORD_AUDIO),
            "RECORD_AUDIO must only be asked from the mic button",
        )
        recordAudioGranted = true
        assertTrue(permissions.recordAudioGranted())
    }
}
