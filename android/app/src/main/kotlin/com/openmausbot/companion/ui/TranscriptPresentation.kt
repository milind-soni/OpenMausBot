package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.DisplayedMessageAttachment
import com.openmausbot.companion.core.DownloadedFile
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.ThreadRef
import com.openmausbot.companion.core.TranscriptRow
import com.openmausbot.companion.core.WebhookMessageContent

/** Reversible completed narration; tools still follow the activity preference. */
@Composable
fun AssistantTurnChip(
    turn: TranscriptRow.AssistantTurn,
    chat: Chat,
    expanded: Boolean,
    revealMessageId: String?,
    onRevealed: (String) -> Unit,
    onToggle: () -> Unit,
    openLink: (String, Message) -> Unit,
    openAttachment: (DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit,
    openThread: (ThreadRef) -> Unit,
) {
    val haptics = rememberHaptics()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            modifier = Modifier.heightIn(min = MIN_TOUCH_TARGET)
                .clickable(role = Role.Button) {
                    onToggle()
                    haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                }
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            contentAlignment = Alignment.CenterStart,
        ) {
            Row(
                modifier = Modifier.background(secondaryTint.copy(alpha = 0.10f), RoundedCornerShape(18.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = secondaryTint, modifier = Modifier.size(14.dp))
                Text(turn.label, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Text(if (expanded) "Hide" else "Show", fontSize = 12.sp, color = secondaryTint)
            }
        }
        if (expanded) turn.items.forEach { message ->
            key(message.id) {
                val requester = remember { BringIntoViewRequester() }
                LaunchedEffect(revealMessageId) {
                    if (revealMessageId == message.id) {
                        // Let the expanded child receive layout coordinates.
                        withFrameNanos { }
                        requester.bringIntoView()
                        onRevealed(message.id)
                    }
                }
                Box(Modifier.bringIntoViewRequester(requester)) {
                    MessageRow(chat, message, openLink = openLink, openAttachment = openAttachment, openThread = openThread)
                }
            }
        }
    }
}

@Composable
fun WebhookMessageBody(content: WebhookMessageContent) {
    var expanded by remember(content) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Webhook task", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = BubbleColor.mineText)
        SelectionContainer {
            Text(content.task, fontSize = 17.sp, color = BubbleColor.mineText)
        }
        content.payload?.let { payload ->
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET)
                    .clickable(role = Role.Button) { expanded = !expanded }
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Event payload", fontSize = 13.sp, color = BubbleColor.mineText, modifier = Modifier.weight(1f))
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = null, tint = BubbleColor.mineText,
                )
            }
            if (expanded) {
                SelectionContainer {
                    Text(
                        payload, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = BubbleColor.mineText,
                        modifier = Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
    }
}
