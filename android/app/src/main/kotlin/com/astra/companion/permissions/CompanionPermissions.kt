package com.astra.companion.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Platform permissions used by local discovery and composer dictation. */
class CompanionPermissions(
    private val sdkInt: Int = Build.VERSION.SDK_INT,
    private val granted: (String) -> Boolean,
) {
    constructor(
        context: Context,
        sdkInt: Int = Build.VERSION.SDK_INT,
    ) : this(
        sdkInt = sdkInt,
        granted = { permission ->
            ContextCompat.checkSelfPermission(context.applicationContext, permission) ==
                PackageManager.PERMISSION_GRANTED
        },
    )

    data class Snapshot(val missingDiscovery: List<String>) {
        val discoveryNeedsRequest: Boolean get() = missingDiscovery.isNotEmpty()
    }

    private val _snapshot = MutableStateFlow(read())
    val snapshot: StateFlow<Snapshot> = _snapshot.asStateFlow()

    fun refresh(): Snapshot {
        val next = read()
        _snapshot.value = next
        return next
    }

    /**
     * What a local browse needs. Called when someone opens the list of nearby
     * computers, never on the way to the QR scanner, which needs none of it.
     */
    fun discoveryPermissions(): Array<String> = refresh().missingDiscovery.toTypedArray()

    /** Composer mic — checked at the button, never at cold start. */
    fun recordAudioGranted(): Boolean = granted(Manifest.permission.RECORD_AUDIO)

    private fun read(): Snapshot {
        val missingDiscovery = buildList {
            if (sdkInt >= 33 && !granted(Manifest.permission.NEARBY_WIFI_DEVICES)) {
                add(Manifest.permission.NEARBY_WIFI_DEVICES)
            }
            if (sdkInt >= LOCAL_NETWORK_SDK && !granted(PERMISSION_ACCESS_LOCAL_NETWORK)) {
                add(PERMISSION_ACCESS_LOCAL_NETWORK)
            }
        }
        return Snapshot(missingDiscovery)
    }

    companion object {
        /** Android 17 / API 37 — local-network runtime permission. */
        const val LOCAL_NETWORK_SDK = 37

        /**
         * Literal keeps compiling against older stub jars in unit tests while
         * still matching `Manifest.permission.ACCESS_LOCAL_NETWORK` on device.
         */
        const val PERMISSION_ACCESS_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
