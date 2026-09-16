package com.astra.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.astra.companion.ui.PairingHandoff
import com.astra.companion.ui.PairingLink

/**
 * The only door `astra://pair?…&token=omb_pair_…` may come through.
 *
 * A pairing URL carries a one-time credential, and §6 forbids persisting one.
 * Keeping the deep link on [MainActivity] broke that by a path no `Saver` audit
 * would find: the system keeps a copy of an Activity's launching Intent in its
 * own `ActivityRecord`, hands it back when it restarts the Activity after a
 * process kill, and — under the default `persistRootOnly` — writes a root
 * Activity's launching Intent to task state that survives a reboot. The
 * credential would then outlive the process that was supposed to be the only
 * thing holding it, and could be replayed after `Session`'s spent-credential set
 * had been reset.
 *
 * So the URL lands here instead. This Activity starts [MainActivity] with an
 * Intent that carries no data and no extras, marks itself finishing, and only
 * then hands the invite to the in-memory `Session` — that order is the point, and
 * [PairingHandoff] holds the reasoning. Its manifest entry is `noHistory`,
 * `excludeFromRecents`, `persistableMode="persistNever"` and its own
 * `taskAffinity`, so it is never the root of the main task and its own Intent is
 * never written down.
 *
 * After it finishes, the only system-held Intents are its own — already gone from
 * the stack and never persisted — and [MainActivity]'s, which is either
 * ACTION_MAIN from the launcher or the sanitized one built below.
 */
class PairingLinkActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val data = intent?.data
        val inviteUrl = data
            ?.takeIf { PairingLink.isInvite(it.scheme, it.host) }
            ?.toString()

        // The order below is the guarantee, not a style choice — see
        // PairingHandoff. finish() must mark this record before the credential
        // reaches anything that outlives it.
        PairingHandoff.run(
            inviteUrl = inviteUrl,
            relaunch = {
                // Built from a component and flags only. Nothing copies the
                // incoming data or extras onto it, which is what keeps the
                // credential out of the Intent the system remembers for
                // MainActivity.
                startActivity(
                    Intent(this, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    },
                )
            },
            markFinishing = ::finish,
            // Session decides whether the invite may be accepted at all — an
            // already-paired phone rejects it (§6).
            deliver = { url -> (application as AstraApp).session.receivePairingURL(url) },
        )
    }
}
