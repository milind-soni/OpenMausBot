package org.openmausbot.android

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.openmausbot.android.data.AppForeground
import org.openmausbot.android.data.PairingInvite
import org.openmausbot.android.data.Repo
import org.openmausbot.android.ui.AppRoot
import org.openmausbot.android.ui.MausTheme

class MainActivity : ComponentActivity() {
    private var incomingLink by mutableStateOf<String?>(null)

    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        incomingLink = intent?.data?.toString()
        setContent {
            MausTheme {
                AppRoot(
                    incomingLink = incomingLink,
                    onLinkConsumed = { incomingLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A pairing link opened from the desktop while the app is already
        // running replaces the pending one; null clears a stale prompt.
        incomingLink = intent.data?.toString()
    }

    override fun onResume() {
        super.onResume()
        AppForeground.isForeground = true
    }

    override fun onPause() {
        AppForeground.isForeground = false
        // Persist the cursor immediately; the OS may kill the process after
        // a pause and the next start must not replay an unbounded gap.
        Repo.computer?.let { Repo.store.cursor(it.id, it.lastCursor) }
        super.onPause()
    }
}
