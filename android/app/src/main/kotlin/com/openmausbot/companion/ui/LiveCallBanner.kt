package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.core.ChatTarget
import kotlinx.coroutines.delay

object LiveCallBannerRules {
    /** The call's own chat shows the bar instead; every other screen — Computer over it included — shows the banner. */
    fun onCallsChat(destination: Destination, threadId: String): Boolean = when (destination) {
        is Destination.Chat -> destination.target.threadId == threadId
        is Destination.Thread -> destination.threadId == threadId
        else -> false
    }
}

/** A thin green strip: the call, its clock, and a way back to it. [onHangUp] is null while the hang-up is on its way. */
@Composable
fun LiveCallBanner(title: String, onOpen: () -> Unit, onHangUp: (() -> Unit)?, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(LIVE_GREEN.copy(alpha = 0.16f))
            .statusBarsPadding()
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = Icons.Filled.Call, contentDescription = null, tint = LIVE_GREEN, modifier = Modifier.size(16.dp))
        Text(
            text = title,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 8.dp),
        )
        if (onHangUp != null) {
            TextButton(onClick = onHangUp) { Text("Hang up", color = MaterialTheme.colorScheme.error) }
        } else {
            // The button's height, so the strip keeps its size while it says "Hanging up…".
            Spacer(Modifier.height(40.dp))
        }
    }
}

/**
 * Over every screen but the call's own chat while this phone is on a call,
 * or hanging one up (a call another device holds shows only in its chat —
 * Ruling 10). Tapping it pushes the call's chat, task and all.
 */
@Composable
fun LiveCallBannerHost(navigator: CompanionNavigator) {
    val liveCalls = LocalCompanion.current.liveCalls
    val local by liveCalls.state.collectAsState()
    if (!local.active) return
    val botId = local.botId ?: return
    val threadId = local.threadId ?: return
    if (LiveCallBannerRules.onCallsChat(navigator.current, threadId)) return
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(local.phase) {
        while (local.phase == LiveCallPhase.LIVE) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val title = when (local.phase) {
        LiveCallPhase.LIVE -> LiveCallRules.title(local.botName, LiveCallRules.elapsed(local.liveSince ?: now, now))
        LiveCallPhase.ENDING -> LiveCallRules.HANGING_UP
        else -> LiveCallRules.CONNECTING
    }
    LiveCallBanner(
        title = title,
        onOpen = { navigator.push(Destination.Chat(ChatTarget.Bot(botId, threadId))) },
        onHangUp = if (local.holdsMedia) liveCalls::hangUp else null,
    )
}
