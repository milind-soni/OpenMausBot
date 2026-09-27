package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.audio.LiveCallPhase
import com.openmausbot.companion.audio.MicrophoneAccess
import com.openmausbot.companion.core.Chat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the bar's buttons do. A remote bar uses only [onHangUp]. */
data class LiveCallBarActions(
    val onMute: (Boolean) -> Unit,
    val onSettings: () -> Unit,
    val onHangUp: () -> Unit,
    val onRetry: () -> Unit,
    val onDismiss: () -> Unit,
)

/** The green a running call wears, in the bar and the banner. */
internal val LIVE_GREEN = Color(0xFF34C759)

/**
 * The compact call bar above the composer: the bot and the clock, one caption
 * line, gear, mute, hang up. After Hang up it says "Hanging up…", with nothing
 * left to press, until the computer confirms. An ending or an error keeps the
 * bar with the reason, Try again where trying again can help, and a cross; a
 * reason too long for one line wraps (see [EndedRow]). The call never covers
 * the chat — that is the whole point of the bar.
 */
@Composable
fun LiveCallBar(model: LiveCallBarModel, actions: LiveCallBarActions, modifier: Modifier = Modifier) {
    when (model) {
        LiveCallBarModel.Hidden -> Unit
        is LiveCallBarModel.Local -> LocalBar(model, actions, modifier)
        is LiveCallBarModel.Remote -> RemoteBar(model, actions.onHangUp, modifier)
    }
}

/**
 * Lines a reason may take before it is cut. Three hold every message the bar
 * knows on a 360 dp phone at 130 % font; a bigger font or a narrower phone cuts
 * the longest ones short rather than grow the bar any further over the chat.
 */
private const val NOTICE_MAX_LINES = 3

/** One line of the bar's title or reason; the icon beside it is centred on this height. */
private val TITLE_LINE_HEIGHT = 20.sp

/** With the bar's 4 dp end padding, the 12 dp its start has. */
private val NOTICE_END_INSET = 8.dp

@Composable
private fun LocalBar(model: LiveCallBarModel.Local, actions: LiveCallBarActions, modifier: Modifier) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
            .semantics { contentDescription = "Live call" },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (model.phase == LiveCallPhase.ENDED) {
            EndedRow(notice = model.title, canRetry = model.canRetry, actions = actions)
        } else if (model.phase == LiveCallPhase.ENDING) {
            // As tall as the row with its buttons, so the bar does not jump.
            Row(modifier = Modifier.heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                BarTitle(text = model.title, tint = secondaryTint, maxLines = 1, modifier = Modifier.weight(1f))
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                BarTitle(text = model.title, tint = LIVE_GREEN, maxLines = 1, modifier = Modifier.weight(1f))
                BarIcon(contentDescription = "Live call settings", onClick = actions.onSettings, icon = Icons.Filled.Settings)
                BarIcon(
                    contentDescription = if (model.muted) "Unmute" else "Mute",
                    onClick = { actions.onMute(!model.muted) },
                    painter = painterResource(if (model.muted) R.drawable.ic_live_mic_off else R.drawable.ic_mic),
                    tint = if (model.muted) MaterialTheme.colorScheme.error else Color.Unspecified,
                )
                BarIcon(
                    contentDescription = "Hang up",
                    onClick = actions.onHangUp,
                    painter = painterResource(R.drawable.ic_live_hang_up),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
        if (model.phase == LiveCallPhase.LIVE) {
            // The person's own words, in grey, while they speak; the voice's words otherwise.
            val speaking = model.heard.isNotEmpty()
            Text(
                // A line break would end the line early and hide the words after it.
                text = (if (speaking) model.heard else model.caption).replace('\n', ' ').ifEmpty { " " },
                fontSize = 13.sp,
                color = if (speaking) secondaryTint.copy(alpha = 0.6f) else secondaryTint,
                maxLines = 1,
                // One line that shows the newest words: a long caption drops its
                // oldest words, with the ellipsis at the start — as on the desktop.
                overflow = TextOverflow.StartEllipsis,
                // A tag, not a description: TalkBack reads the caption itself.
                modifier = Modifier
                    .padding(start = 24.dp, bottom = 2.dp)
                    .testTag("Captions"),
            )
        }
    }
}

/**
 * The phone icon and the title — or, once the call is over, the reason. The
 * icon keeps to the first line however many lines follow it.
 */
@Composable
private fun BarTitle(text: String, tint: Color, maxLines: Int, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier.height(with(LocalDensity.current) { TITLE_LINE_HEIGHT.toDp() }),
            contentAlignment = Alignment.Center,
        ) {
            Icon(imageVector = Icons.Filled.Call, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Text(
            text = text,
            fontSize = 15.sp,
            lineHeight = TITLE_LINE_HEIGHT,
            fontWeight = FontWeight.SemiBold,
            maxLines = maxLines,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/**
 * Why the call ended, with Try again (only where trying again can help: not
 * for a missing key, a busy line, a denied microphone or a lost pairing) and
 * the cross. The reason sits beside the buttons while it fits there on one
 * line. A longer one — "A Live call is already running from your computer.
 * Hang up there first." — gets the bar's whole width, up to
 * [NOTICE_MAX_LINES] lines, and the buttons move under it, at the end: cut to
 * one line, it never said what to do.
 *
 * Beside or under is decided from the reason's one-line width in the same
 * measure pass, so a long reason is never drawn cut first. Its first line stays
 * where the one-line bar puts it, so the lines below it are all that is added.
 */
@Composable
private fun EndedRow(notice: String, canRetry: Boolean, actions: LiveCallBarActions) {
    Layout(
        content = {
            BarTitle(text = notice, tint = MaterialTheme.colorScheme.error, maxLines = NOTICE_MAX_LINES)
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (canRetry) TextButton(onClick = actions.onRetry) { Text("Try again") }
                BarIcon(contentDescription = "Dismiss", onClick = actions.onDismiss, icon = Icons.Filled.Close)
            }
        },
    ) { (title, buttons), constraints ->
        val buttonsPlaceable = buttons.measure(constraints.copy(minWidth = 0, minHeight = 0))
        val oneLine = title.maxIntrinsicWidth(Constraints.Infinity)
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else oneLine + buttonsPlaceable.width
        val besideWidth = (width - buttonsPlaceable.width).coerceAtLeast(0)
        if (oneLine <= besideWidth) {
            val titlePlaceable = title.measure(Constraints(maxWidth = besideWidth))
            val height = maxOf(titlePlaceable.height, buttonsPlaceable.height)
            layout(width, height) {
                titlePlaceable.placeRelative(0, (height - titlePlaceable.height) / 2)
                buttonsPlaceable.placeRelative(besideWidth, (height - buttonsPlaceable.height) / 2)
            }
        } else {
            // The bar's end padding is sized for icon buttons, which bring their
            // own; text that runs to the end keeps the start's margin instead.
            val titlePlaceable = title.measure(Constraints(maxWidth = (width - NOTICE_END_INSET.roundToPx()).coerceAtLeast(0)))
            // Where the one-line bar centres its line against the buttons.
            val top = ((buttonsPlaceable.height - TITLE_LINE_HEIGHT.roundToPx()) / 2).coerceAtLeast(0)
            layout(width, top + titlePlaceable.height + buttonsPlaceable.height) {
                titlePlaceable.placeRelative(0, top)
                buttonsPlaceable.placeRelative(besideWidth, top + titlePlaceable.height)
            }
        }
    }
}

@Composable
private fun RemoteBar(model: LiveCallBarModel.Remote, onHangUp: () -> Unit, modifier: Modifier) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            .padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 2.dp)
            .semantics { contentDescription = "Live call on another device" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(imageVector = Icons.Filled.Call, contentDescription = null, tint = LIVE_GREEN, modifier = Modifier.size(16.dp))
        Text(
            text = model.title,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(start = 8.dp),
        )
        TextButton(onClick = onHangUp) { Text("Hang up", color = MaterialTheme.colorScheme.error) }
    }
}

/** A 40 dp icon button; Material keeps the touch target at 48 dp. */
@Composable
private fun BarIcon(
    contentDescription: String,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    painter: Painter? = null,
    tint: Color = Color.Unspecified,
) {
    val resolved = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint
    IconButton(onClick = onClick, modifier = Modifier.size(40.dp)) {
        when {
            painter != null -> Icon(painter = painter, contentDescription = contentDescription, tint = resolved, modifier = Modifier.size(20.dp))
            icon != null -> Icon(imageVector = icon, contentDescription = contentDescription, tint = resolved, modifier = Modifier.size(20.dp))
        }
    }
}

/**
 * The bar for one chat: this phone's call, or a call another device holds on
 * this chat. Ticks once a second while a call runs so the clock moves. Reads
 * the manager and the session itself, so `ChatScreen` only has to place it.
 */
@Composable
fun LiveCallBarHost(chat: Chat, onSettings: () -> Unit, modifier: Modifier = Modifier) {
    val environment = LocalCompanion.current
    val liveCalls = environment.liveCalls
    val session = environment.session
    val scope = rememberCoroutineScope()
    val local by liveCalls.state.collectAsState()
    val state by session.state.collectAsState()
    val server = state.liveCall
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    val ticking = local.phase == LiveCallPhase.LIVE || server?.isRunning == true
    LaunchedEffect(ticking) {
        while (ticking) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val model = LiveCallRules.barModel(local, server, chat.threadId, chat.name, now)
    if (model == LiveCallBarModel.Hidden) return
    LiveCallBar(
        model = model,
        actions = LiveCallBarActions(
            onMute = liveCalls::setMuted,
            onSettings = onSettings,
            onHangUp = {
                when (model) {
                    // Someone else's microphone: only the computer can end it.
                    // A 404 there reads the line again (Session.endLiveCall).
                    is LiveCallBarModel.Remote -> scope.launch { session.endLiveCall(model.callId) }
                    else -> liveCalls.hangUp()
                }
            },
            onRetry = { liveCalls.retry(MicrophoneAccess { environment.mic.ensure(it) }) },
            onDismiss = liveCalls::dismiss,
        ),
        modifier = modifier,
    )
}
