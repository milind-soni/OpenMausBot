package com.astra.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.astra.companion.sharing.ShareHandoff
import com.astra.companion.sharing.ShareInbox
import com.astra.companion.sharing.ShareItemLoader
import com.astra.companion.sharing.SharePayload
import com.astra.companion.ui.ShareLoadException
import com.astra.companion.ui.SharePolicy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The only door `ACTION_SEND` may come through.
 *
 * The sending app's content URIs are granted to this Activity. Copying them
 * into the app cache has to happen here, while that grant is still alive.
 * [MainActivity] then receives an Intent with no extras, the same shape the
 * pairing trampoline uses, so shared files never become the launching Intent
 * the system keeps for the root of the main task.
 */
class ShareReceiveActivity : Activity() {

    // Cancelled in onDestroy so a destroyed trampoline cannot keep copying
    // (or offer()) against a newer ShareReceiveActivity that wiped the inbox.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as AstraApp
        // Stay alive until the inbox copy finishes; URI grants die with this record.
        scope.launch {
            ShareHandoff.run(
                copy = {
                    try {
                        SharePayload.Ready(
                            ShareItemLoader.load(intent, contentResolver, ShareInbox.root(cacheDir)),
                        )
                    } catch (error: Exception) {
                        SharePayload.Failed(
                            (error as? ShareLoadException)?.message ?: SharePolicy.generic(),
                        )
                    }
                },
                relaunch = {
                    startActivity(
                        Intent(this@ShareReceiveActivity, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        },
                    )
                },
                markFinishing = ::finish,
                deliver = app.shareInbox::offer,
            )
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
