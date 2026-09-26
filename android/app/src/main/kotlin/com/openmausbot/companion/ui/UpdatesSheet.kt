package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Chat
import kotlinx.coroutines.launch

/**
 * The Updates pill and what it opens — the port of `UpdatesPill`/`MascotStack` in
 * `ios/App/ChatListView.swift:474-550` and of `ios/App/UpdatesSheet.swift`.
 *
 * Needs you first, with the answer right there — the phone exists so that a
 * stopped bot on the laptop can be un-stopped from wherever you are. Then what is
 * working, then what finished while you were not looking.
 */

/** The floating pill: who is doing what right now, at a glance. */
@Composable
internal fun UpdatesBar(updates: List<ChatUpdate>, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val first = updates.firstOrNull()
    val stack = remember(updates) { updates.take(UpdatesSummary.MASCOTS).map { it.chat.color } }
    Row(
        modifier = modifier
            .chromeCapsule()
            .clip(CircleShape)
            .clickable(onClickLabel = stringResource(R.string.mobile_open_updates_2c80d633), role = Role.Button, onClick = onOpen)
            .heightIn(min = 52.dp)
            .padding(start = if (first == null) 16.dp else 7.dp, end = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (first != null) {
            MascotStack(colors = stack)
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(1.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (first?.kind == UpdateKind.NEEDS_YOU) {
                    Icon(
                        imageVector = Icons.Filled.Notifications,
                        contentDescription = null,
                        tint = Color(MausPalette.argb(first.chat.color)),
                        modifier = Modifier.size(13.dp),
                    )
                }
                Text(
                    text = localizedUpdatesHeadline(updates),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (first == null) secondaryTint else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = localizedUpdatesSubline(updates),
                fontSize = 12.sp,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Icon(
            imageVector = Icons.Filled.KeyboardArrowUp,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun localizedUpdatesHeadline(updates: List<ChatUpdate>): String {
    val first = updates.firstOrNull() ?: return localizedMobileCopy(UpdatesSummary.headline(updates))
    return when (first.kind) {
        UpdateKind.NEEDS_YOU -> stringResource(R.string.mobile_updates_headline_needs_you, first.chat.name)
        UpdateKind.WORKING -> stringResource(R.string.mobile_updates_headline_working, first.chat.name)
        UpdateKind.TO_REVIEW -> stringResource(R.string.mobile_updates_headline_review, first.chat.name)
    }
}

@Composable
private fun localizedUpdatesSubline(updates: List<ChatUpdate>): String {
    val first = updates.firstOrNull() ?: return localizedMobileCopy(UpdatesSummary.subline(updates))
    val remaining = updates.size - 1
    if (remaining == 1) return stringResource(R.string.mobile_updates_one_more)
    if (remaining > 1) return stringResource(R.string.mobile_updates_more_count, remaining)
    return localizedUpdateLine(first.line.ifEmpty { " " })
}

@Composable
private fun localizedUpdatesCount(updates: List<ChatUpdate>): String =
    if (updates.isEmpty()) localizedMobileCopy(UpdatesSummary.count(updates))
    else stringResource(R.string.mobile_updates_active_count, updates.size)

@Composable
private fun localizedUpdateLine(line: String): String {
    if (line == "Queued — waiting for an available slot") {
        return stringResource(R.string.mobile_updates_queued_waiting)
    }
    val queued = QUEUED_MESSAGES.matchEntire(line)?.groupValues?.getOrNull(1)?.toIntOrNull()
    if (queued != null) return stringResource(R.string.mobile_updates_queued_count, queued)
    return localizedMobileCopy(line)
}

private val QUEUED_MESSAGES = Regex("^(\\d+) messages queued$")

/** Up to three mascots overlapping, the way a group of faces reads at a glance. */
@Composable
internal fun MascotStack(colors: List<String>, size: Dp = 28.dp, overlap: Dp = 12.dp) {
    Row(horizontalArrangement = Arrangement.spacedBy(-overlap)) {
        colors.forEach { color ->
            Box(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp),
            ) {
                MausAvatar(color = color, size = size, state = MausState.IDLE, animated = false)
            }
        }
    }
}

/** What the pill opens: the active chats, grouped by what they need. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UpdatesSheet(onOpen: (Chat) -> Unit, onDismiss: () -> Unit) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()

    val updates = remember(state) { state.updates }
    val sections = remember(updates) {
        UpdateKind.entries.mapNotNull { kind ->
            val items = updates.filter { it.kind == kind }
            if (items.isEmpty()) null else kind to items
        }
    }
    // One pass over the fleet rather than one per row: resolving a face walks the
    // chat's visible transcript.
    val faces = remember(state, updates) {
        updates.associate { it.id to MausState.forChat(it.chat, state) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "header") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 20.dp, end = 20.dp, top = 2.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(stringResource(R.string.mobile_updates_c76d1807), fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    Text(localizedUpdatesCount(updates), fontSize = 13.sp, color = secondaryTint)
                }
            }

            if (sections.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        title = UpdatesSummary.EMPTY_TITLE,
                        description = UpdatesSummary.EMPTY_DESCRIPTION,
                        modifier = Modifier.padding(top = 24.dp),
                    )
                }
            }

            sections.forEach { (kind, items) ->
                item(key = "section-$kind") {
                    Text(
                        text = localizedMobileCopy(UpdatesSummary.section(kind)).uppercase(),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.5.sp,
                        // Needs you wears the colour of the chat that heads it;
                        // the other two stay quiet.
                        color = if (kind == UpdateKind.NEEDS_YOU) {
                            Color(MausPalette.argb(items.first().chat.color))
                        } else {
                            secondaryTint
                        },
                        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 2.dp),
                    )
                }
                items(items, key = { it.id }) { update ->
                    UpdateRow(
                        update = update,
                        face = faces[update.id] ?: MausState.IDLE,
                        onOpen = { onOpen(update.chat) },
                    )
                }
            }
        }
    }
}

@Composable
private fun UpdateRow(update: ChatUpdate, face: MausState, onOpen: () -> Unit) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var answering by remember(update.id) { mutableStateOf(false) }
    val card = update.card

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onOpen)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        ChatAvatar(chat = update.chat, size = 40.dp, state = face)

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(update.chat.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            Text(
                text = update.chat.threadTitle,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = localizedUpdateLine(update.line),
                fontSize = 14.sp,
                color = secondaryTint,
                maxLines = if (update.kind == UpdateKind.NEEDS_YOU) 3 else 1,
                overflow = TextOverflow.Ellipsis,
            )

            if (update.kind == UpdateKind.NEEDS_YOU && card != null && card.isPending) {
                if (card.skillRequest != null) {
                    Text(
                        stringResource(R.string.mobile_open_the_chat_to_review_skill_md_6225775b),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = secondaryTint,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                } else {
                    // The answers are the card's own options, exactly as the chat
                    // screen draws them — never a choice invented here.
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(top = 6.dp),
                    ) {
                        card.options.forEach { option ->
                            val refusal = ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY
                            Button(
                                onClick = {
                                    haptics.play(TactileAction.CHOOSE_APPROVAL)
                                    answering = true
                                    scope.launch {
                                        ApprovalAnswers.choose(session, update.chat, card, option)
                                        answering = false
                                    }
                                },
                                enabled = !answering,
                                colors = if (refusal) {
                                    ButtonDefaults.filledTonalButtonColors()
                                } else {
                                    ButtonDefaults.buttonColors()
                                },
                            ) {
                                Text(option, fontSize = 13.sp)
                            }
                        }
                    }
                }
            }
        }

        when (update.kind) {
            UpdateKind.NEEDS_YOU -> Unit
            UpdateKind.WORKING -> CircularProgressIndicator(
                modifier = Modifier
                    .padding(top = 10.dp)
                    .size(16.dp),
                strokeWidth = 2.dp,
            )
            UpdateKind.TO_REVIEW -> Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 10.dp),
            ) {
                Box(
                    Modifier
                        .size(10.dp)
                        .background(Color(MausPalette.argb(update.chat.color)), CircleShape),
                )
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = secondaryTint.copy(alpha = 0.5f),
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}
