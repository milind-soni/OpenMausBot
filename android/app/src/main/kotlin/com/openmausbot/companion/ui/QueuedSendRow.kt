package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.QueuedSend

/**
 * A message the computer is holding, sitting just above the chat bar.
 *
 * A mid-turn send to a bot that cannot take words into a running turn does
 * not reach the transcript: the harness holds it, because appending it now
 * would make it the active leaf and the rest of the turn would hang off a
 * line the model never saw. Correct — but with nothing on screen it reads as
 * the phone having eaten the message, which is the bug this row fixes.
 *
 * It lives above the composer rather than in the transcript because that is
 * where a thing you have not said yet belongs — still in your hands, next to
 * the field you typed it in. Both actions are words, not glyphs: Steer stops
 * the turn so these words run now (the harness deliberately keeps its queue
 * across an interrupt, which is what makes stopping a send), and the bin
 * drops them.
 */
@Composable
fun QueuedSendRow(
    send: QueuedSend,
    /**
     * Stop the turn so this runs now. Null where the phone cannot interrupt —
     * a room — so the button is not offered rather than offered and broken.
     */
    onSteer: (() -> Unit)?,
    /**
     * The interrupt is in flight. Engines take their time noticing one — codex
     * needs about six seconds — and a button that looks untouched for six
     * seconds has, as far as the person is concerned, done nothing.
     */
    steering: Boolean,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(18.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = send.text,
            fontSize = 15.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (onSteer != null) {
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                    .clickable(enabled = !steering, role = Role.Button, onClick = onSteer)
                    .padding(horizontal = 11.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (steering) {
                    CircularProgressIndicator(
                        strokeWidth = 1.5.dp,
                        modifier = Modifier.size(12.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.Send,
                        contentDescription = null,
                        modifier = Modifier.size(13.dp),
                    )
                }
                Text(
                    text = if (steering) "Steering…" else "Steer",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
        Icon(
            imageVector = Icons.Filled.Delete,
            contentDescription = "Delete this queued message",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .clickable(role = Role.Button, onClick = onCancel)
                .padding(6.dp)
                .size(16.dp),
        )
    }
}

/** What the composer promises about the message being typed. */
object ComposerPromise {
    /**
     * The name is in the header a thumb's width above; spending the field's
     * whole width repeating it truncates the part that says what pressing
     * send will actually do.
     */
    fun placeholder(
        name: String,
        busy: Boolean,
        engineCanSteer: Boolean,
        sending: Boolean,
        listening: Boolean,
    ): String = when {
        sending -> "Sending…"
        listening -> "Listening…"
        !busy -> "Ask $name"
        engineCanSteer -> "Sends into this turn"
        else -> "Sends after this turn"
    }
}
