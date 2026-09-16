package com.astra.companion.sharing

import com.astra.companion.ui.ShareLoadException
import com.astra.companion.ui.SharePolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The order in which the inbound-share trampoline does its jobs, extracted so
 * the order itself can be tested.
 *
 * Incoming `ACTION_SEND` Intents carry content URIs whose read grant belongs to
 * the receiving Activity. Copying those bytes has to happen while this record
 * is still the one that holds the grant. After the copy, the original extras
 * must never reach [com.astra.companion.MainActivity]: that Activity is
 * the root of the main task, so the system keeps and may persist its launching
 * Intent.
 *
 * The pairing trampoline can deliver a string after `finish()`. Share cannot:
 * the URI grant dies with this record. So: copy, relaunch, mark finishing,
 * then hand the already-local payload to process memory. The Activity stays
 * alive (no `finish()`) until the IO copy returns.
 */
internal object ShareHandoff {
    suspend fun run(
        copy: () -> SharePayload,
        relaunch: () -> Unit,
        markFinishing: () -> Unit,
        deliver: (SharePayload) -> Unit,
    ) {
        val payload = withContext(Dispatchers.IO) {
            runCatching(copy).getOrElse { error ->
                SharePayload.Failed(
                    message = (error as? ShareLoadException)?.message
                        ?: SharePolicy.generic(),
                )
            }
        }
        relaunch()
        markFinishing()
        deliver(payload)
    }
}
