package org.openmausbot.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import org.openmausbot.android.data.Repo
import org.openmausbot.android.notify.Notifier
import org.openmausbot.android.service.LiveService
import org.openmausbot.android.speech.Speaker

@Composable
fun AppRoot(incomingLink: String?, onLinkConsumed: () -> Unit) {
    val context = LocalContext.current
    val speaker = Speaker(context)

    LaunchedEffect(Unit) {
        Repo.onNotification = { payload ->
            if (Repo.store.notifyWhileClosed) Notifier.message(context, payload)
        }
        Repo.onSpeak = { text -> if (Repo.store.speakReplies) speaker.speak(text) }
        if (Repo.computer == null && Repo.computers.isNotEmpty()) Repo.connect()
    }

    // The live service follows the connection: a linked app should still
    // raise a notification when it is not on screen.
    LaunchedEffect(Repo.connection.phase, Repo.store.notifyWhileClosed) {
        if (Repo.store.notifyWhileClosed &&
            Repo.connection.phase == org.openmausbot.android.data.ConnectionState.Phase.ONLINE
        ) {
            LiveService.start(context)
        } else {
            LiveService.stop(context)
        }
    }

    when {
        incomingLink != null -> PairScreen(invite = incomingLink, onDismiss = onLinkConsumed)
        Repo.computers.isEmpty() && Repo.computer == null -> PairScreen(invite = null, onDismiss = {})
        else -> HomeScreen()
    }
}
