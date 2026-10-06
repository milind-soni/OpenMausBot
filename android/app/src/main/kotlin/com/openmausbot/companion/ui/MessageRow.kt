package com.openmausbot.companion.ui

import com.openmausbot.companion.R

import androidx.compose.ui.res.stringResource

import android.content.ClipData
import android.util.Base64
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.Close
import androidx.compose.ui.draw.rotate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.audio.VoiceNoteController
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.AttachedMessageContent
import com.openmausbot.companion.core.attachedFiles
import com.openmausbot.companion.core.generatedImages
import com.openmausbot.companion.core.voiceNotes
import com.openmausbot.companion.core.DisplayedMessageAttachment
import com.openmausbot.companion.core.DownloadedFile
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.OptionCard
import com.openmausbot.companion.core.ThreadRef
import com.openmausbot.companion.core.ToolActivity
import com.openmausbot.companion.core.forTask
import com.openmausbot.companion.core.label
import com.openmausbot.companion.core.routineExecutionRef
import com.openmausbot.companion.core.TranscriptCard
import com.openmausbot.companion.core.TranscriptCards
import com.openmausbot.companion.core.webhookContent
import com.openmausbot.companion.core.CardOutcome
import com.openmausbot.companion.core.CardPresentation
import com.openmausbot.companion.core.hasDetails
import com.openmausbot.companion.core.outboundApp
import com.openmausbot.companion.core.outcome
import com.openmausbot.companion.core.presentation
import com.openmausbot.companion.core.showsHeldNote
import com.openmausbot.companion.core.summaryLine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the clipboard shows this came from. */
private const val MESSAGE_CLIP_LABEL = "OpenMausMobile message"

/**
 * One row of the transcript — the port of `MessageRow` in `ios/App/ChatView.swift`.
 *
 * [endsRun] is the last bubble of a run from the same side: the one that gets the
 * tail. [TranscriptLayout.endsRun] decides it, over the whole transcript, so a row
 * never has to look at its neighbours.
 */
@Composable
fun MessageRow(
    chat: Chat,
    message: Message,
    endsRun: Boolean = true,
    /** Where a tapped link in a bot reply goes; null leaves it to the system. */
    openLink: ((String, Message) -> Unit)? = null,
    /** Open one exact user attachment through the authenticated computer route. */
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)? = null,
    /** Where an "Opened thread" chip goes; null leaves the chip a receipt. */
    openThread: ((ThreadRef) -> Unit)? = null,
) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val state by session.state.collectAsState()
    val clipboard = LocalClipboard.current
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var editText by remember { mutableStateOf("") }
    var selectingText by remember { mutableStateOf<String?>(null) }

    val bot = (chat as? Chat.BotChat)?.bot
    val versions = remember(state, message.id) { state.versions(message, chat.threadId) }
    val versionIndex = versions.indexOfFirst { it.id == message.id }
    // The stand-in for an edit the computer has not answered yet. It has no
    // server identity, so nothing may react to it or edit it again.
    val editPending = state.pendingEdits[chat.threadId]
    val isPendingEdit = editPending?.placeholderId == message.id
    val mine = message.role == Message.Role.USER

    Box(
        modifier = Modifier
            .fillMaxWidth()
            // Long-press is the context menu; a plain tap must stay inert, so no
            // ripple is drawn for it.
            .combinedClickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onLongClick = { menuOpen = true },
                onClick = {},
            ),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // Only a thread the phone knows gets an "Open run" button.
            val runRef = remember(state, message.routineRun?.executionThreadId) {
                message.routineRun?.let { state.routineExecutionRef(it) }
            }
            MessageContent(
                chat = chat,
                message = message,
                endsRun = endsRun,
                haptics = haptics,
                openLink = openLink,
                openAttachment = openAttachment,
                openThread = openThread,
                runRef = runRef,
            )

            message.comm?.let {
                Text(
                    text = stringResource(R.string.mobile_messaged_it_withname_bd9371e7, it.withName),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }

            // A request the person spoke on a Live call; the harness labels it.
            if (mine && message.via == "call") {
                Text(text = "via call", fontSize = 12.sp, color = secondaryTint)
            }

            message.reactions?.takeIf { it.isNotEmpty() }?.let { reactions ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Reactions.group(reactions).forEach { group ->
                        val tint = if (group.mine) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            secondaryTint
                        }
                        Text(
                            text = "${group.emoji} ${group.count}",
                            fontSize = 13.sp,
                            color = tint,
                            modifier = Modifier
                                .border(1.dp, tint.copy(alpha = 0.5f), CircleShape)
                                .clickable {
                                    haptics.play(TactileAction.TOGGLE_REACTION)
                                    scope.launch {
                                        session.react(message, chat.threadId, group.emoji)
                                    }
                                }
                                .padding(horizontal = 10.dp, vertical = 3.dp),
                        )
                    }
                }
            }

            // Versions are a bot idea: a room has no branch to switch (§12).
            if (versions.size > 1 && versionIndex >= 0 && bot != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val busy = bot.busy == true
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        contentDescription = stringResource(R.string.mobile_previous_version_989537a3),
                        tint = if (versionIndex == 0 || busy) {
                            secondaryTint.copy(alpha = 0.4f)
                        } else {
                            secondaryTint
                        },
                        modifier = Modifier
                            .size(20.dp)
                            .clickable(enabled = versionIndex > 0 && !busy) {
                                scope.launch {
                                    session.switchVersion(versions[versionIndex - 1], bot)
                                }
                            },
                    )
                    Text(
                        text = stringResource(R.string.mobile_versionindex_1_of_versions_size_91d50e4a, versionIndex + 1, versions.size),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = secondaryTint,
                    )
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                        contentDescription = stringResource(R.string.mobile_next_version_514439d0),
                        tint = if (versionIndex + 1 >= versions.size || busy) {
                            secondaryTint.copy(alpha = 0.4f)
                        } else {
                            secondaryTint
                        },
                        modifier = Modifier
                            .size(20.dp)
                            .clickable(enabled = versionIndex + 1 < versions.size && !busy) {
                                scope.launch {
                                    session.switchVersion(versions[versionIndex + 1], bot)
                                }
                            },
                    )
                }
            }
        }

        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (!isPendingEdit) Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                Reactions.CHOICES.forEach { emoji ->
                    Text(
                        text = emoji,
                        fontSize = 22.sp,
                        modifier = Modifier
                            .clickable {
                                menuOpen = false
                                haptics.play(TactileAction.TOGGLE_REACTION)
                                scope.launch { session.react(message, chat.threadId, emoji) }
                            }
                            .padding(8.dp),
                    )
                }
            }
            MessageActions.copyableText(message)?.let { text ->
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.mobile_copy_af74f7c5)) },
                    onClick = {
                        menuOpen = false
                        scope.launch {
                            clipboard.setClipEntry(
                                ClipEntry(ClipData.newPlainText(MESSAGE_CLIP_LABEL, text)),
                            )
                        }
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.mobile_select_text_9d49219e)) },
                    onClick = {
                        menuOpen = false
                        selectingText = text
                    },
                )
            }
            // Attachment messages cannot be reconstructed by a text-only edit.
            // The policy also keeps their private transport paths out of the UI.
            val editableText = MessageActions.editableText(message)
            if (editableText != null && bot != null && !isPendingEdit) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.mobile_edit_and_retry_f683a3c2)) },
                    enabled = bot.busy != true && editPending == null,
                    onClick = {
                        menuOpen = false
                        editText = editableText
                        editing = true
                    },
                )
            }
        }
    }

    if (editing && bot != null) {
        AlertDialog(
            onDismissRequest = { editing = false },
            title = { Text(stringResource(R.string.mobile_edit_and_retry_f683a3c2)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.mobile_this_creates_a_new_version_and_con_9a5d779d), fontSize = 14.sp)
                    OutlinedTextField(
                        value = editText,
                        onValueChange = { editText = it },
                        label = { Text(stringResource(R.string.mobile_message_68f4145f)) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    // `bot` is re-read from the collected state on every frame,
                    // so a bot that starts running while this dialog is open
                    // disables Send rather than sending an edit the harness will
                    // refuse with 409.
                    enabled = bot.busy != true && editText.isNotBlank(),
                    onClick = {
                        val text = editText.trim()
                        editing = false
                        if (text.isEmpty()) return@TextButton
                        scope.launch { session.edit(message, bot, text) }
                    },
                ) { Text(stringResource(R.string.mobile_send_9bc2575c)) }
            },
            dismissButton = {
                TextButton(onClick = { editing = false }) { Text(stringResource(R.string.mobile_cancel_77dfd213)) }
            },
        )
    }

    selectingText?.let { text ->
        SelectableTextDialog(text = text, onDismiss = { selectingText = null })
    }
}

/**
 * Raw message text in a separate surface where Android can own the long-press
 * selection gesture. The bubble's long press is intentionally reserved for
 * reactions and message actions.
 */
@Composable
private fun SelectableTextDialog(text: String, onDismiss: () -> Unit) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copied by remember(text) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.mobile_select_text_9d49219e)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SelectionContainer {
                    Text(
                        text = text,
                        fontSize = 16.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 360.dp)
                            .verticalScroll(rememberScrollState()),
                    )
                }
                Text(
                    stringResource(R.string.mobile_touch_and_hold_the_text_to_select__efc64a9c),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    scope.launch {
                        // "Copied" after the clipboard has it, not before: the
                        // label is a report, and `setClipEntry` suspends.
                        clipboard.setClipEntry(
                            ClipEntry(ClipData.newPlainText(MESSAGE_CLIP_LABEL, text)),
                        )
                        copied = true
                    }
                },
            ) { Text(if (copied) stringResource(R.string.mobile_copied_8e3df45a) else stringResource(R.string.mobile_copy_all_9da9f044)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.mobile_done_e9b450d1)) } },
    )
}

@Composable
private fun MessageContent(
    chat: Chat,
    message: Message,
    endsRun: Boolean,
    haptics: Haptics,
    openLink: ((String, Message) -> Unit)?,
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
    openThread: ((ThreadRef) -> Unit)?,
    runRef: ThreadRef?,
) {
    when (message.kind) {
        Message.Kind.TEXT -> TextBubble(chat.threadId, message, endsRun, openLink, openAttachment)
        // A structured ask draws its own card: its answers are the model's
        // questions, not an allow/deny a tap could stand for.
        Message.Kind.OPTIONS -> if (QuestionCardRules.drawsQuestionCard(message)) {
            QuestionCardView(chat, message, haptics)
        } else {
            CardView(chat, message, haptics)
        }
        Message.Kind.ACTIVITY -> {
            ActivityChip(message.tool, message.threadRef, openThread, teammateReport = message.threadRef != null || message.comm != null)
            // Claude Code too old for the model: offer the update on the
            // engine this bot's thread runs on. Rooms have no single engine.
            val claudeInstance = (chat as? Chat.BotChat)?.bot
                ?.let { it.forTask(chat.threadId) ?: it }
                ?.modelSelection?.instanceId
            if (message.tool?.claudeUpdate == true && claudeInstance != null) {
                ClaudeUpdateCard(messageId = message.id, instanceId = claudeInstance)
            }
        }
        Message.Kind.COMPACTION -> ReceiptChip(
            label = message.compaction?.chipText ?: message.text.orEmpty(),
            detail = message.compaction?.summary ?: message.text.orEmpty(),
        )
        Message.Kind.SCREEN -> ScreenShot(chat.threadId, message)
        // The turn's audit, as a chip that opens its sections. The activity
        // setting already dropped it when tool calls are hidden.
        Message.Kind.DIGEST -> TurnDigestChip(message)
        Message.Kind.ROUTINE_RUN -> RoutineRunCardView(
            message = message,
            openRun = if (runRef != null && openThread != null) {
                { openThread(runRef) }
            } else {
                null
            },
        )
        // A message kind from a newer computer. Almost everything the harness
        // sends carries `text`, so showing it is usually the whole message and
        // always better than a gap in the transcript. When there is nothing to
        // show, show nothing — a placeholder saying "unsupported" is a worse gap
        // than the gap.
        Message.Kind.UNKNOWN -> if (!message.text.isNullOrEmpty()) {
            TextBubble(chat.threadId, message, endsRun, openLink, openAttachment)
        }
    }
}

@Composable
private fun TextBubble(
    threadId: String,
    message: Message,
    endsRun: Boolean,
    openLink: ((String, Message) -> Unit)?,
    openAttachment: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
) {
    val mine = message.role == Message.Role.USER
    val tail = TranscriptLayout.tail(message, endsRun)
    // A reply that is *entirely* a patch or a table is drawn as one. The gate is
    // in `:core` and it is strict: anything with a sentence in it stays a
    // paragraph, because a card around a paragraph hides the paragraph.
    val card = remember(message.id, message.role, message.text) { TranscriptCards.of(message) }
    // Shared attachments are protocol tags in stored user text. They are not
    // prose, and a server-controlled path must never be presented as a link.
    val attached = remember(message.id, message.text) { AttachedMessageContent.parse(message.text.orEmpty()) }
    val webhook = remember(message) { message.webhookContent }
    // A card brings its own surface, so it drops the bubble — and with it the
    // tail, which is a bubble's chin and not a card's.
    val bubble = card == null
    // No face beside the bubble: the bot's face is in the header, and in a room
    // the name line says who spoke. The bubble sits at the edge.
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // iOS spaces the far side with `Spacer(minLength:)`; a non-filling weight
        // lets the bubble shrink to its text while never crossing that gutter.
        if (mine) Spacer(Modifier.width(56.dp))
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .widthIn(max = 640.dp)
                // Room for the tail below, so the next row does not sit on it.
                .padding(bottom = if (bubble && endsRun) SpeechBubble.tailDrop() else 0.dp)
                .then(
                    if (bubble) {
                        Modifier
                            .background(
                                if (mine) BubbleColor.mine else BubbleColor.theirs,
                                SpeechBubbleShape.of(tail),
                            )
                            .padding(horizontal = 15.dp, vertical = 11.dp)
                    } else {
                        Modifier
                    },
                ),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // Rooms attribute each line to the member who said it. Only theirs:
            // your own bubble is already on your side.
            if (!mine) {
                message.from?.let {
                    Text(
                        text = it.name,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(MausPalette.argb(it.color)),
                    )
                }
            }
            // Voice notes sit above the attachment gallery, as they do on the
            // desktop transcript: the note is the message, not an appendix to it.
            message.voiceNotes.forEach { note ->
                VoiceNoteAttachmentView(threadId, message, note)
            }
            message.generatedImages.forEach { attachment ->
                SharedAttachmentView(threadId, message, attachment, openAttachment)
            }
            // Documents, audio and video a bot sent with attach_file (MOCA-155).
            // The card opens the file sheet; Open hands video to the player.
            message.attachedFiles.forEach { attachment ->
                SharedAttachmentView(
                    threadId, message, attachment, openAttachment,
                    foreground = if (mine) BubbleColor.mineText else MaterialTheme.colorScheme.onSurface,
                )
            }
            // Bots get markdown, you do not — the same split the desktop makes.
            // Markdown you did not intend is worse than markdown you did: a
            // message about `**` should show the asterisks.
            // Settled text is selectable, so a command, a URL or a paragraph can
            // be copied — as it can on iOS. The live bubble below is deliberately
            // left out: selecting text that is still growing fights the reader.
            when (card) {
                is TranscriptCard.Diff -> DiffCard(card)
                is TranscriptCard.Table -> DataTableCard(card)
                null -> if (webhook != null) {
                    WebhookMessageBody(webhook)
                } else if (mine) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        attached.attachments.forEach { attachment ->
                            SharedAttachmentView(
                                threadId = threadId,
                                message = message,
                                attachment = attachment,
                                onOpen = openAttachment,
                            )
                        }
                        if (attached.text.isNotEmpty()) {
                            SelectionContainer {
                                Text(
                                    text = attached.text,
                                    fontSize = 17.sp,
                                    color = BubbleColor.mineText,
                                )
                            }
                        }
                    }
                } else {
                    SelectionContainer {
                        MarkdownText(
                            source = message.text.orEmpty(),
                            openLink = openLink?.let { open -> { url -> open(url, message) } },
                        )
                    }
                }
            }
        }
        if (!mine) Spacer(Modifier.width(44.dp))
    }
}

@Composable
private fun SharedAttachmentView(
    threadId: String,
    message: Message,
    attachment: DisplayedMessageAttachment,
    onOpen: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
    /** Your own bubble is blue with white text; a bot's file sits on the theme surface. */
    foreground: Color = BubbleColor.mineText,
) {
    if (attachment.kind == DisplayedMessageAttachment.Kind.IMAGE) {
        SharedImageAttachment(threadId, message, attachment, onOpen)
        return
    }
    val family = attachment.fileFamily
    Row(
        modifier = Modifier
            .widthIn(max = 360.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(foreground.copy(alpha = 0.10f))
            .clickable(enabled = onOpen != null, role = Role.Button) {
                onOpen?.invoke(attachment, message, null)
            }
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .localizedSemantics(contentDescription = {
                stringResource(R.string.mobile_a11y_file_attachment, attachment.name)
            }),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val label = when (family) {
            DisplayedMessageAttachment.FileFamily.VIDEO -> R.string.mobile_file_video
            DisplayedMessageAttachment.FileFamily.AUDIO -> R.string.mobile_file_audio
            DisplayedMessageAttachment.FileFamily.DOCUMENT -> R.string.mobile_file_b4915d3a
        }
        val hint = if (family == DisplayedMessageAttachment.FileFamily.DOCUMENT) {
            R.string.mobile_tap_to_preview_fa5ce0ea
        } else {
            R.string.mobile_tap_to_play
        }
        Text(stringResource(label), fontSize = 11.sp, fontWeight = FontWeight.Bold, color = foreground.copy(alpha = 0.68f))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                attachment.name,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = foreground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(stringResource(hint), fontSize = 12.sp, color = foreground.copy(alpha = 0.68f))
        }
    }
}

private sealed interface AttachmentThumbnailState {
    data object Loading : AttachmentThumbnailState
    data class Ready(val file: DownloadedFile, val image: ImageBitmap) : AttachmentThumbnailState
    data object Failed : AttachmentThumbnailState
}

/**
 * Card shapes seen this run. The transcript is a lazy list, so a card that
 * scrolls away and back is composed afresh; without this it would come back
 * at the placeholder height and jump when its thumbnail decodes again.
 */
private object InlineImageShapes {
    private const val LIMIT = 256
    private val shapes = object : LinkedHashMap<String, Float>(LIMIT, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Float>?): Boolean = size > LIMIT
    }

    @Synchronized fun aspect(key: String): Float? = shapes[key]

    @Synchronized fun remember(key: String, aspect: Float) {
        shapes[key] = aspect
    }
}

@Composable
private fun SharedImageAttachment(
    threadId: String,
    message: Message,
    attachment: DisplayedMessageAttachment,
    onOpen: ((DisplayedMessageAttachment, Message, DownloadedFile?) -> Unit)?,
) {
    val foreground = if (message.role == Message.Role.USER) BubbleColor.mineText else MaterialTheme.colorScheme.onSurface
    val session = LocalCompanion.current.session
    val shapeKey = "$threadId\u001F${message.id}\u001F${attachment.path}"
    var attempt by remember(message.id, attachment.path) { mutableStateOf(0) }
    var state by remember(message.id, attachment.path) {
        mutableStateOf<AttachmentThumbnailState>(AttachmentThumbnailState.Loading)
    }
    LaunchedEffect(threadId, message.id, attachment.path, attempt) {
        state = AttachmentThumbnailState.Loading
        // A failed inline preview owns its own retry UI; it must not replace an
        // unrelated composer or account alert while this row scrolls on screen.
        val downloaded = session.downloadFile(
            threadId,
            message.id,
            attachment.path,
            reportError = false,
            cacheResult = true,
        )
        if (downloaded == null) {
            state = AttachmentThumbnailState.Failed
            return@LaunchedEffect
        }
        val bitmap = withContext(Dispatchers.Default) {
            decodeAttachmentImage(downloaded.data, AttachmentImageRules.THUMBNAIL_EDGE)
        }
        bitmap?.let { image ->
            AttachmentImageRules.inlineAspect(image.width, image.height)?.let { InlineImageShapes.remember(shapeKey, it) }
        }
        state = bitmap?.let { AttachmentThumbnailState.Ready(downloaded, it) }
            ?: AttachmentThumbnailState.Failed
    }

    val ready = state as? AttachmentThumbnailState.Ready
    // The whole image at its own shape, fitted to the bubble: the frame's size
    // comes from the bubble's width and the clamped shape, and the picture is
    // fitted inside it — a wide screenshot is no longer cropped and zoomed into
    // a 4:3 window, and a tall one stops at the height cap on the card's tint.
    val aspect = ready?.let { AttachmentImageRules.inlineAspect(it.image.width, it.image.height) }
        ?: InlineImageShapes.aspect(shapeKey)
    val maxWidth = aspect?.let(AttachmentImageRules::inlineMaxWidthDp) ?: AttachmentImageRules.INLINE_MAX_WIDTH_DP
    Column(
        modifier = Modifier
            .widthIn(max = maxWidth.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(foreground.copy(alpha = 0.10f))
            .clickable(enabled = ready != null && onOpen != null, role = Role.Button) {
                ready?.let { onOpen?.invoke(attachment, message, it.file) }
            }
            .localizedSemantics(contentDescription = {
                stringResource(R.string.mobile_a11y_image_attachment, attachment.name)
            }),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (aspect != null) {
                        Modifier.aspectRatio(aspect)
                    } else {
                        Modifier.height(AttachmentImageRules.INLINE_PLACEHOLDER_HEIGHT_DP.dp)
                    },
                )
                .testTag(SHARED_IMAGE_FRAME_TAG),
            contentAlignment = Alignment.Center,
        ) {
            when (val current = state) {
                AttachmentThumbnailState.Loading ->
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                AttachmentThumbnailState.Failed -> AttachmentLoadFailure(
                    label = stringResource(R.string.mobile_image_unavailable),
                    foreground = foreground,
                    onRetry = { attempt += 1 },
                )
                is AttachmentThumbnailState.Ready -> Image(
                    bitmap = current.image,
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        Text(
            attachment.name,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = foreground,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
        )
    }
}

/** The fitted frame an inline image is drawn in; tests measure it. */
internal const val SHARED_IMAGE_FRAME_TAG = "shared-image-frame"

@Composable
private fun AttachmentLoadFailure(label: String, foreground: Color = BubbleColor.mineText, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = foreground.copy(alpha = 0.70f),
            modifier = Modifier.size(20.dp),
        )
        Text(label, fontSize = 13.sp, color = foreground.copy(alpha = 0.80f))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.mobile_retry_9f5cd8a2)) }
    }
}

/** Where the bubble's clip bytes are: fetched on first play, then kept for replay. */
private sealed interface VoiceNoteClipState {
    data object NotLoaded : VoiceNoteClipState
    data object Loading : VoiceNoteClipState
    data class Ready(val data: ByteArray) : VoiceNoteClipState
    data object Failed : VoiceNoteClipState
}

/** The desktop bubble's clock: m:ss, and 0:00 for anything not yet audible. */
private fun voiceNoteClock(ms: Long): String {
    if (ms <= 0) return "0:00"
    val wholeSeconds = ms / 1000
    return (wholeSeconds / 60).toString() + ":" + (wholeSeconds % 60).toString().padStart(2, '0')
}

/**
 * One voice note in the transcript, matching the desktop VoiceNoteBubble:
 * a play button, a scrub bar, and the clip's length. Playback is app-scoped
 * (CompanionEnvironment.voiceNotes), so a note keeps playing while its row
 * scrolls away, and the one-voice rule rides the same audio-focus gate the
 * TTS preview uses: starting a note (or a preview) pauses any other voice
 * rather than talking over it. The clip's bytes are fetched through the same
 * authenticated file route as image thumbnails, but only on first play — a
 * note nobody opens costs no request, and a replay never refetches.
 *
 * While this phone is on a Live call the play button is off, with the reason
 * under the bubble: a note asks for the audio focus the call holds, and the
 * call ends when it loses it (as the profile sheet keeps its voice preview off).
 */
@Composable
private fun VoiceNoteAttachmentView(
    threadId: String,
    message: Message,
    note: DisplayedMessageAttachment,
) {
    val foreground = if (message.role == Message.Role.USER) BubbleColor.mineText else MaterialTheme.colorScheme.onSurface
    val session = LocalCompanion.current.session
    val player = LocalCompanion.current.voiceNotes
    val liveCall by LocalCompanion.current.liveCalls.state.collectAsState()
    val callHoldsAudio = liveCall.holdsMedia
    val scope = rememberCoroutineScope()
    val key = remember(message.id, note.path) { message.id + ":" + note.path }
    var clip by remember(message.id, note.path) { mutableStateOf<VoiceNoteClipState>(VoiceNoteClipState.NotLoaded) }
    // The scrub position while the slider is held; null when it tracks playback.
    var scrub by remember(key) { mutableStateOf<Float?>(null) }

    fun startPlayback(data: ByteArray) {
        val failure = player.play(key, data) ?: return
        // A Live call took the audio while the clip downloaded: the player
        // refused it, and the clip waits, ready, for the call to end.
        if (failure != VoiceNoteController.DURING_LIVE_CALL) clip = VoiceNoteClipState.Failed
    }

    fun loadAndPlay() {
        clip = VoiceNoteClipState.Loading
        scope.launch {
            val downloaded = session.downloadFile(
                threadId,
                message.id,
                note.path,
                reportError = false,
                cacheResult = true,
            )
            if (downloaded == null) {
                clip = VoiceNoteClipState.Failed
            } else {
                clip = VoiceNoteClipState.Ready(downloaded.data)
                startPlayback(downloaded.data)
            }
        }
    }

    val active = player.playback.collectAsState().value?.takeIf { it.key == key }
    val playing = active?.playing == true

    // Late engine failures park the clip; the bubble's retry row is its UI.
    LaunchedEffect(key) {
        player.playbackErrors.collectLatest {
            if (it.key == key) clip = VoiceNoteClipState.Failed
        }
    }
    // Pull the engine's position while it plays; the clock reads it back.
    LaunchedEffect(key, playing) {
        while (playing) {
            player.refresh()
            delay(200)
        }
    }

    if (clip is VoiceNoteClipState.Failed) {
        AttachmentLoadFailure(
            label = "Voice note unavailable",
            foreground = foreground,
            onRetry = { clip = VoiceNoteClipState.NotLoaded },
        )
        return
    }

    // The wire's estimate until the engine loads metadata, then the real length.
    val durationMs = active?.durationMs ?: note.durationMs?.toLong()?.takeIf { it > 0 }
    val durationSeconds = durationMs?.let { it / 1000f } ?: 0f
    val positionMs = scrub?.toLong() ?: (active?.positionMs ?: 0L)

    // Pausing never takes the audio; starting or resuming would.
    val playable = playing || !callHoldsAudio
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier
                .widthIn(max = 360.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(foreground.copy(alpha = 0.10f))
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = if (playable) 1f else 0.38f))
                    .clickable(role = Role.Button, enabled = playable) {
                        when {
                            playing -> player.pause()
                            // Disabled is how it looks; this is what stops a tap
                            // that reaches the click action anyway.
                            callHoldsAudio -> Unit
                            clip is VoiceNoteClipState.Loading -> Unit
                            active != null && player.resumable(key) ->
                                player.resume()?.let { if (it != VoiceNoteController.DURING_LIVE_CALL) clip = VoiceNoteClipState.Failed }
                            clip is VoiceNoteClipState.Ready ->
                                startPlayback((clip as VoiceNoteClipState.Ready).data)
                            else -> loadAndPlay()
                        }
                    }
                    .semantics {
                        contentDescription = if (playing) "Pause voice note" else "Play voice note"
                    },
                contentAlignment = Alignment.Center,
            ) {
                when {
                    clip is VoiceNoteClipState.Loading && active == null ->
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                    playing -> VoiceNotePauseGlyph(Color.White)
                    else -> Icon(
                        imageVector = Icons.Filled.PlayArrow,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            Slider(
                // The slider works in seconds; without an explicit range Compose clamps
                // it to 0f..1f and scrubs can only land inside the first second.
                value = if (durationSeconds > 0f) (positionMs / 1000f).coerceIn(0f, durationSeconds) else 0f,
                valueRange = if (durationSeconds > 0f) 0f..durationSeconds else 0f..1f,
                onValueChange = { scrub = it * 1000f },
                onValueChangeFinished = {
                    val target = scrub
                    scrub = null
                    if (target != null && active != null) player.seek(key, target.toLong())
                },
                // Like the desktop range input: no scrubbing until the length is known.
                enabled = active != null && durationMs != null,
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = "Seek voice note" },
            )
            Text(
                voiceNoteClock(positionMs) + " / " + (durationMs?.let(::voiceNoteClock) ?: "--:--"),
                fontSize = 11.sp,
                color = foreground.copy(alpha = 0.80f),
            )
        }
        if (!playable) {
            Text(
                LiveCallRules.VOICE_NOTE_DURING_CALL,
                fontSize = 11.sp,
                color = foreground.copy(alpha = 0.80f),
                modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
    }
}

/** The pause glyph the core icon set does not carry, drawn at the button's scale. */
@Composable
private fun VoiceNotePauseGlyph(color: Color) {
    Canvas(modifier = Modifier.size(14.dp)) {
        val bar = size.width / 5f
        val gap = size.width / 5f
        drawRoundRect(
            color = color,
            topLeft = Offset.Zero,
            size = Size(bar, size.height),
            cornerRadius = CornerRadius(bar / 2f),
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(bar + gap, 0f),
            size = Size(bar, size.height),
            cornerRadius = CornerRadius(bar / 2f),
        )
    }
}

/**
 * A tool the bot ran, and what became of it — the status half of
 * `ios/App/Cards/SkillExecutionReceiptView.swift`.
 *
 * Deliberately quiet: these are the bulk of a busy transcript and they are
 * context, not content. So the receipt is a dot and a name, and the badge word
 * appears only for the two states worth a glance ([ActivityReceipt.showsLabel]).
 * A row that failed keeps the warning glyph it already had, so failure is a
 * shape and not only a colour — and the whole row reads as one sentence to a
 * screen reader whichever state it is in.
 *
 * Most of iOS's detail is not here, because it has no data: `durationMs` and
 * `parameters` are absent from [ToolActivity]. Nothing to expand means nothing
 * to tap, which is why the row is not a button — except a chip that names a
 * thread it opened, which is the link to that thread. The one exception is
 * [ToolActivity.output], a teammate's report, which folds open under the row.
 */
@Composable
private fun ActivityChip(
    tool: ToolActivity?,
    threadRef: ThreadRef? = null,
    openThread: ((ThreadRef) -> Unit)? = null,
    /** The chip reports a teammate's work (it links a thread or a room). Only
     * then does [ToolActivity.output] show: an ordinary tool chip carries raw
     * output too, and that log stays on the computer's side. */
    teammateReport: Boolean = false,
) {
    if (tool == null) return
    val status = ActivityReceipt.status(tool.ok)
    val tint = when (status) {
        ActivityStatus.RUNNING -> MaterialTheme.colorScheme.tertiary
        ActivityStatus.SUCCESS -> secondaryTint
        ActivityStatus.ERROR -> MaterialTheme.colorScheme.error
    }
    val haptics = rememberHaptics()
    val linked = if (threadRef != null && openThread != null) {
        Modifier
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button) {
                haptics.play(TactileAction.OPEN_THREAD_CHIP)
                openThread(threadRef)
            }
    } else {
        Modifier
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            modifier = Modifier
                .padding(start = 4.dp)
                .then(linked)
                .semantics(mergeDescendants = true) {
                    contentDescription = ActivityReceipt.announcement(tool.label, status)
                },
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (status == ActivityStatus.ERROR) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(14.dp),
                )
            } else {
                Box(
                    modifier = Modifier
                        .size(ACTIVITY_DOT)
                        .background(tint, CircleShape),
                )
            }
            Text(
                text = tool.label,
                fontSize = 13.sp,
                maxLines = ActivityReceipt.nameLines(status),
                color = if (status == ActivityStatus.ERROR) tint else secondaryTint,
                // measured after the badge, so a wrapped failure never pushes it out
                modifier = Modifier.weight(1f, fill = false),
            )
            if (ActivityReceipt.showsLabel(status)) {
                Text(
                    text = ActivityReceipt.label(status),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    color = tint,
                )
            }
        }
        // A teammate's report under its "replied" chip: a few lines, the rest on
        // tap. Its own tap target, so the chip above still opens the thread.
        tool.output?.trim()?.takeIf { teammateReport && it.isNotEmpty() }?.let { output ->
            var expanded by remember(output) { mutableStateOf(false) }
            Text(
                text = output,
                fontSize = 13.sp,
                color = secondaryTint,
                maxLines = if (expanded) Int.MAX_VALUE else TOOL_OUTPUT_LINES,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(start = 4.dp + ACTIVITY_DOT + 6.dp)
                    .clickable(role = Role.Button) {
                        haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                        expanded = !expanded
                    }
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            )
        }
    }
}

/** How much of a teammate's report shows before a tap opens the rest. */
private const val TOOL_OUTPUT_LINES = 3

/**
 * A quiet chip under a reply for the harness's receipts (the work digest, a
 * compaction record): one line, and the full text on tap. Port of
 * `ReceiptChip` in `ios/App/ChatView.swift`.
 */
@Composable
private fun ReceiptChip(label: String, detail: String) {
    if (label.isEmpty()) return
    var expanded by remember(label) { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Column(
        modifier = Modifier
            .padding(start = 4.dp)
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button) {
                haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                expanded = !expanded
            }
            .semantics(mergeDescendants = true) { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(ACTIVITY_DOT)
                    .background(secondaryTint, CircleShape),
            )
            Text(text = label, fontSize = 13.sp, maxLines = 1, color = secondaryTint)
        }
        if (expanded && detail.isNotEmpty() && detail != label) {
            Text(text = detail, fontSize = 12.sp, color = secondaryTint)
        }
    }
}

/** Several consecutive successful/running activity receipts, folded on demand. */
@Composable
fun ActivityRunChip(items: List<Message>, openThread: ((ThreadRef) -> Unit)? = null) {
    if (items.isEmpty()) return
    val haptics = rememberHaptics()
    // Keyed on the run's identity — the same one the LazyColumn keys the row by
    // (`TranscriptRow.ActivityRun.id = "run.${head.id}"`). Keying on the last id
    // too would throw the reader's disclosure away on every receipt that lands
    // while the run is still going. iOS holds a `@State` with no key at all.
    var expanded by remember(items.first().id) { mutableStateOf(false) }
    val running = items.any { it.tool?.ok == null }
    val summary = if (running) {
        stringResource(R.string.mobile_running_steps, items.size)
    } else {
        stringResource(R.string.mobile_ran_steps, items.size)
    }
    Column(
        modifier = Modifier.padding(start = 4.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        // The pill is ~30 dp tall; the target around it is MIN_TOUCH_TARGET, the
        // way TouchTarget does it for the round buttons. Not TouchTarget itself:
        // that helper is a square box, which would clip a capsule this wide.
        Box(
            modifier = Modifier
                .heightIn(min = MIN_TOUCH_TARGET)
                .clickable(role = Role.Button) {
                    expanded = !expanded
                    haptics.play(TactileAction.TOGGLE_ACTIVITY_RUN)
                }
                .localizedSemantics(contentDescription = {
                    stringResource(
                        if (expanded) R.string.mobile_a11y_summary_expanded
                        else R.string.mobile_a11y_summary_collapsed,
                        summary,
                    )
                }),
            contentAlignment = Alignment.CenterStart,
        ) {
            Row(
                modifier = Modifier
                    .background(secondaryTint.copy(alpha = 0.10f), RoundedCornerShape(18.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (running) {
                    CircularProgressIndicator(modifier = Modifier.size(13.dp), strokeWidth = 1.5.dp)
                } else {
                    Icon(
                        imageVector = Icons.Filled.Check,
                        contentDescription = null,
                        tint = Color(0xFF22C55E),
                        modifier = Modifier.size(14.dp),
                    )
                }
                Text(summary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                Text(if (expanded) stringResource(R.string.mobile_hide_34d8b60f) else stringResource(R.string.mobile_show_d97d1ee3), fontSize = 12.sp, color = secondaryTint)
            }
        }
        if (expanded) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items.forEach { item -> ActivityChip(item.tool, item.threadRef, openThread, teammateReport = item.threadRef != null || item.comm != null) }
            }
        }
    }
}

/** The receipt's status dot, sized to sit level with the 13 sp name beside it. */
private val ACTIVITY_DOT = 7.dp

/**
 * An option card. When it still has a request behind it, this is the screen the
 * companion exists for — a bot stopped, and only a person can let it continue.
 */
@Composable
private fun CardView(chat: Chat, message: Message, haptics: Haptics) {
    val card = message.card ?: return
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    var answering by remember(message.id) { mutableStateOf(false) }
    // The full request behind a short card, collapsed until asked for.
    var showingDetails by remember(message.id) { mutableStateOf(false) }
    val skillRequest = card.skillRequest
    val presentation = card.presentation

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(secondaryTint.copy(alpha = 0.13f), RoundedCornerShape(22.dp))
            .then(
                if (card.isPending) {
                    Modifier.border(
                        1.5.dp,
                        MaterialTheme.colorScheme.primary,
                        RoundedCornerShape(22.dp),
                    )
                } else {
                    Modifier
                },
            )
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (card.isPending) {
            Text(
                stringResource(R.string.mobile_card_waiting_on_you, chat.name),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        // "Send to Linear?" for a held send to one app, the generic question
        // for several, and the computer's own title for every other card.
        val headline = when {
            presentation != CardPresentation.OUTBOUND -> card.title
            card.outboundApp != null -> stringResource(R.string.mobile_card_send_to_app, card.outboundApp.orEmpty())
            else -> stringResource(R.string.mobile_card_send_on_your_behalf)
        }
        Text(headline, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        if (presentation == CardPresentation.STANDARD) {
            // Proposals are reviewed in full; the detail is the thing worth copying.
            SelectionContainer {
                Text(card.subtitle, fontSize = 15.sp, color = secondaryTint)
            }
        } else {
            // An approval leads with one line; the request itself, raw
            // arguments and all, waits under Details.
            val summary = card.summaryLine
            if (summary.isNotEmpty()) {
                Text(
                    summary,
                    fontSize = 15.sp,
                    color = secondaryTint,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (card.hasDetails) {
                CardDetails(card.subtitle, showingDetails) { showingDetails = !showingDetails }
            }
        }

        if (card.showsHeldNote) {
            Text(card.held.orEmpty(), fontSize = 13.sp, color = Color(MausPalette.argb("orange")))
        }

        skillRequest?.let { skill ->
            val reviewed = skill.reviewedSha256
            if (reviewed != null) {
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            stringResource(R.string.mobile_review_the_complete_skill_md_61fb9a9a),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            stringResource(R.string.mobile_sha256_reviewed_take_8_d4013810, reviewed.take(8)),
                            fontSize = 10.sp,
                            fontFamily = FontFamily.Monospace,
                            color = secondaryTint,
                        )
                    }
                    SelectionContainer {
                        Text(
                            stringResource(
                                R.string.mobile_source_skill_source_unknown_6370895d,
                                skill.source ?: stringResource(R.string.mobile_unknown_bc7819b3),
                            ),
                            fontSize = 11.sp,
                            color = secondaryTint,
                        )
                    }
                    SelectionContainer {
                        Text(
                            skill.preview.orEmpty(),
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 220.dp)
                                .verticalScroll(rememberScrollState())
                                .background(
                                    secondaryTint.copy(alpha = 0.08f),
                                    RoundedCornerShape(10.dp),
                                )
                                .padding(10.dp),
                        )
                    }
                }
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = Color(MausPalette.argb("orange")),
                    )
                    Text(
                        stringResource(R.string.mobile_old_proposal_hint),
                        fontSize = 12.sp,
                        color = Color(MausPalette.argb("orange")),
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        if (card.isPending) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // The buttons are the card's own options, never a string
                // invented here. Session maps the choice to allow/deny/answer.
                card.options.forEach { option ->
                    val refusal = ApprovalChoices.emphasis(option) == OptionEmphasis.SECONDARY
                    Button(
                        onClick = {
                            haptics.play(TactileAction.CHOOSE_APPROVAL)
                            answering = true
                            scope.launch {
                                ApprovalAnswers.choose(session, chat, card, option)
                                answering = false
                            }
                        },
                        enabled = !answering && (
                            skillRequest == null ||
                                refusal ||
                                skillRequest.reviewedSha256 != null
                            ),
                        // Same `isRefusal` that picks the allow choice picks the
                        // weight, so the most sensible action on the most
                        // sensitive screen is not the same shape as the refusal.
                        colors = if (refusal) {
                            ButtonDefaults.filledTonalButtonColors()
                        } else {
                            ButtonDefaults.buttonColors()
                        },
                    ) {
                        Text(option)
                    }
                }
            }

            // The grant key comes from the card. The phone never derives its
            // own, so it cannot permit something subtly wider than the computer
            // would have. The same goes for the answer: it is one of the options
            // the card offered, never a string invented here.
            val alwaysAllow = ApprovalChoices.alwaysAllowChoice(card)
            if (alwaysAllow != null && chat is Chat.BotChat) {
                TextButton(
                    onClick = {
                        haptics.play(TactileAction.GRANT_APPROVAL)
                        answering = true
                        scope.launch {
                            ApprovalAnswers.grant(session, chat, card, alwaysAllow)
                            answering = false
                        }
                    },
                    enabled = !answering,
                ) {
                    Text(stringResource(R.string.mobile_always_allow_this_tool_2ce82a7e), fontSize = 14.sp)
                }
            }
        } else {
            val outcome = card.outcome
            if (outcome != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = if (outcome.isPositive) Icons.Filled.Check else Icons.Filled.Close,
                        contentDescription = null,
                        tint = secondaryTint,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(outcomeText(outcome), fontSize = 14.sp, color = secondaryTint)
                }
            } else if (card.expired == true) {
                Text(stringResource(R.string.mobile_card_expired), fontSize = 14.sp, color = secondaryTint)
            }
        }
    }
}

/** What a settled card says happened, in words rather than the stored verdict. */
@Composable
private fun outcomeText(outcome: CardOutcome): String = when (outcome) {
    CardOutcome.Allowed -> stringResource(R.string.mobile_card_allowed)
    CardOutcome.Denied -> stringResource(R.string.mobile_card_denied)
    CardOutcome.Unavailable -> stringResource(R.string.mobile_card_no_longer_available)
    CardOutcome.Remembered -> stringResource(R.string.mobile_card_remembered)
    CardOutcome.Skipped -> stringResource(R.string.mobile_card_skipped)
    is CardOutcome.Answered -> outcome.text.ifEmpty { stringResource(R.string.mobile_card_answered) }
    is CardOutcome.Chose -> outcome.option
    is CardOutcome.Other -> outcome.value
}

/** Long requests scroll inside a capped box; the text stays selectable. */
@Composable
private fun CardDetails(text: String, expanded: Boolean, toggle: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            modifier = Modifier.clickable(onClick = toggle),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.mobile_card_details),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
            )
            Icon(
                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = secondaryTint,
                modifier = Modifier.size(16.dp).rotate(if (expanded) 90f else 0f),
            )
        }
        if (expanded) {
            SelectionContainer {
                Text(
                    text,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 220.dp)
                        .background(secondaryTint.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                )
            }
        }
    }
}

/**
 * A frame of the bot's computer. In the paged shape the pixels are not in the
 * transcript — they are fetched here, once, when the row appears.
 */
@Composable
private fun ScreenShot(threadId: String, message: Message) {
    val session = LocalCompanion.current.session
    var attempt by remember(message.id) { mutableStateOf(0) }
    var state by remember(message.id) { mutableStateOf<ScreenShotState>(ScreenShotState.Loading) }

    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val renderedWidthPixels = with(LocalDensity.current) { maxWidth.toPx().toInt().coerceAtLeast(1) }
        LaunchedEffect(threadId, message.id, attempt, renderedWidthPixels) {
            state = ScreenShotState.Loading
            val bytes = try {
                message.png?.let { encoded ->
                    withContext(Dispatchers.Default) {
                        runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull()
                    }
                } ?: if (message.hasImage == true) session.image(threadId, message.id) else null
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                null
            }
            val bitmap = bytes?.let {
                withContext(Dispatchers.Default) {
                    decodeScreenShotImage(it, renderedWidthPixels)
                }
            }
            state = bitmap?.let(ScreenShotState::Ready) ?: ScreenShotState.Failed
        }

        val aspectRatio = (state as? ScreenShotState.Ready)?.image?.let { image ->
            image.width.toFloat() / image.height.coerceAtLeast(1).toFloat()
        } ?: (16f / 10f)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(aspectRatio)
                .clip(RoundedCornerShape(16.dp))
                .background(secondaryTint.copy(alpha = 0.13f)),
            contentAlignment = Alignment.Center,
        ) {
            when (val current = state) {
                ScreenShotState.Loading ->
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                ScreenShotState.Failed -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(20.dp),
                    )
                    Text(stringResource(R.string.mobile_screenshot_unavailable_cfe6fcbe), fontSize = 13.sp, color = secondaryTint)
                    TextButton(onClick = { attempt += 1 }) { Text(stringResource(R.string.mobile_retry_9f5cd8a2)) }
                }
                is ScreenShotState.Ready -> Image(
                    bitmap = current.image,
                    contentDescription = stringResource(R.string.mobile_a_frame_of_this_bot_s_computer_39b6a5bb),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

private sealed interface ScreenShotState {
    data object Loading : ScreenShotState
    data class Ready(val image: ImageBitmap) : ScreenShotState
    data object Failed : ScreenShotState
}

/**
 * The reply as it is being typed, styled to match the settled bubble it is about
 * to become — the handover should be invisible, and any difference in padding or
 * corner radius reads as the message jumping on arrival.
 *
 * A caret rather than a spinner: a spinner says "something is happening
 * somewhere", which the reader already knows. A caret at the end of real text
 * says how far along it is.
 */
@Composable
fun StreamingBubble(text: String?, reasoning: String?) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
        Column(
            modifier = Modifier
                .weight(1f, fill = false)
                .padding(bottom = SpeechBubble.tailDrop())
                .background(BubbleColor.theirs, SpeechBubbleShape.of(BubbleTail.LEADING))
                .padding(horizontal = 15.dp, vertical = 11.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (!reasoning.isNullOrEmpty() && text.isNullOrEmpty()) {
                // Folded away by default, because reasoning is not the answer.
                // Tail-limited: it runs to thousands of words and the part worth
                // reading is always the end. Plain lines, unlike the answer: the
                // tail cut lands wherever it lands, and rendering markdown that
                // starts mid-syntax invents structure the model did not write.
                ThoughtChamber(reasoning = reasoning)
            }
            if (!text.isNullOrEmpty()) {
                // Same renderer as the settled bubble: a live reply showing
                // `**bold**` that snaps to bold on arrival is the message
                // jumping, just in a different dimension.
                MarkdownText(source = text, caret = true)
            }
        }
        Spacer(Modifier.width(44.dp))
    }
}

/**
 * The bot is typing — the port of the `else if showsTyping` branch of
 * `ChatView.swift` and of `TypingIndicatorView`: three dots hopping in turn, the
 * way Messages shows someone typing.
 *
 * The semantics block matters as much as the dots. Busy already reaches a
 * sighted reader twice over — the mascot wears a working face and the composer
 * offers an interrupt — and reached a TalkBack reader through neither. The row
 * is a polite live region, so it is spoken when it appears, and it carries a name
 * of its own ("Pepper is typing"), so it can also be found by swiping to the end
 * of the transcript.
 *
 * Drawn in the same bubble, padding and tail as the reply that will replace it,
 * one line of text high, so the handover is the text arriving rather than the
 * shape changing. The dots are the bubble's quiet foreground, as on iOS.
 */
@Composable
fun WorkingBubble(name: String) {
    val clock = remember { MausFrameClock() }
    // Android says "reduce motion" through the animator duration scale, and this
    // reads it the way MausAvatar does — through a snapshotFlow, so turning the
    // setting off while a turn is running stops the dots on the next frame
    // rather than at the end of the turn. At zero they sit still on the line, a
    // little fainter: still three dots, just still ones.
    var moving by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val durationScale = coroutineContext[MotionDurationScale]
        snapshotFlow { (durationScale?.scaleFactor ?: 1f) > 0f }
            .collectLatest { live ->
                moving = live
                if (!live) return@collectLatest
                while (true) withFrameNanos(clock.onFrame)
            }
    }

    val dots = secondaryTint
    val label = stringResource(R.string.mobile_chat_typing, name)
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
        Box(
            modifier = Modifier
                .padding(bottom = SpeechBubble.tailDrop())
                .background(BubbleColor.theirs, SpeechBubbleShape.of(BubbleTail.LEADING))
                .padding(horizontal = 15.dp, vertical = 11.dp)
                .semantics {
                    contentDescription = label
                    liveRegion = LiveRegionMode.Polite
                },
        ) {
            Canvas(modifier = Modifier.size(WORKING_DOTS_WIDTH, WORKING_DOTS_HEIGHT)) {
                // Read in the draw phase: a tick repaints the dots without
                // recomposing the bubble, let alone the transcript around it.
                val elapsed = clock.nanos.longValue
                val live = moving
                val radius = WORKING_DOT.toPx() * 0.5f
                val step = WORKING_DOT.toPx() + WORKING_DOT_GAP.toPx()
                // Resting on a line just below the middle, so the hop rises
                // into the bubble's centre rather than out of it.
                val rest = (size.height + WORKING_DOT_BOUNCE.toPx()) * 0.5f
                for (index in 0 until WorkingDots.COUNT) {
                    drawCircle(
                        color = dots,
                        radius = radius,
                        center = Offset(
                            radius + index * step,
                            rest - WorkingDots.lift(index, elapsed, live) * WORKING_DOT_BOUNCE.toPx(),
                        ),
                        alpha = WorkingDots.alpha(index, elapsed, live),
                    )
                }
            }
        }
        Spacer(Modifier.width(44.dp))
    }
}

private val WORKING_DOT = 8.dp
private val WORKING_DOT_GAP = 5.dp
private val WORKING_DOT_BOUNCE = 3.dp
private val WORKING_DOTS_WIDTH =
    WORKING_DOT * WorkingDots.COUNT + WORKING_DOT_GAP * (WorkingDots.COUNT - 1)
/** A line of body text tall, so the bubble matches a one-line reply. */
private val WORKING_DOTS_HEIGHT = 22.dp
