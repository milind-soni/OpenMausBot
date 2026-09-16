package com.astra.companion.sharing

import com.astra.companion.ui.SharePolicy

/**
 * Process-memory UI for one inbound share generation.
 *
 * The payload already lives in [ShareInbox]; this holds the sheet fields that
 * would otherwise die with an Activity recreation (instruction, phase, the
 * prepared sendId).
 */
class ShareSheetSession(
    val generation: Long,
) {
    var bootstrapped: Boolean = false
    var phase: ShareSheetPhase = ShareSheetPhase.LOADING
    var instruction: String = ""
    var errorMessage: String? = null
    var preview: SharePolicy.SharePreview = SharePolicy.SharePreview()
    var items: LoadedShareItems? = null
    var pendingDelivery: SharePreparedDelivery? = null
    var computers: List<SharePolicy.ShareComputer> = emptyList()
    var destinations: List<SharePolicy.ShareDestination> = emptyList()
    var selectedComputerId: String? = null
    var selectedDestinationId: String? = null
    var rememberedDestinationId: String? = null
}

enum class ShareSheetPhase { LOADING, READY, SENDING, SENT, FAILED }

data class SharePreparedDelivery(
    val text: String,
    val destination: SharePolicy.ShareDestination,
    val sendId: String,
)
