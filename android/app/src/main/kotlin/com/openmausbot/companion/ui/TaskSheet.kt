package com.openmausbot.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.DialogProperties
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Session
import java.util.Locale
import kotlinx.coroutines.launch
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.chat
import com.openmausbot.companion.core.target
import com.openmausbot.companion.core.openedByLabel

/**
 * Separate contexts for an agent or channel — the port of
 * `ios/App/TaskManagerView.swift`.
 *
 * A compact dialog rather than a screen, because tasks are conversation
 * navigation, not host configuration.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskSheet(chat: Chat, onDismiss: () -> Unit, onSelectTask: (ChatTarget) -> Unit) {
    val session = LocalCompanion.current.session
    val scope = rememberCoroutineScope()
    val state by session.state.collectAsState()

    // The live record, so busy and the task list stay current as frames land.
    val current = remember(state, chat) {
        state.chat(chat.target)
    }
    if (current == null) {
        // Deleted while the sheet was open.
        LaunchedEffect(chat.id) { onDismiss() }
        return
    }

    var creating by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<BotTask?>(null) }
    var title by remember { mutableStateOf("") }

    val tasks = TaskRules.tasks(current)

    BasicAlertDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = true),
    ) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 6.dp,
        ) {
            Column(modifier = Modifier.padding(vertical = 16.dp)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "${current.name}'s threads",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = "New thread",
                        tint = if (TaskRules.canCreate(current)) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            secondaryTint.copy(alpha = 0.4f)
                        },
                        modifier = Modifier
                            .size(32.dp)
                            .clickable(enabled = TaskRules.canCreate(current)) {
                                title = ""
                                creating = true
                            }
                            .padding(4.dp),
                    )
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ChatAvatar(chat = current, size = 48.dp, state = MausState.IDLE, animated = false)
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(current.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        Text(TaskRules.subtitle(current), fontSize = 14.sp, color = secondaryTint)
                    }
                }
                Text(
                    text = TaskRules.CONTEXT_FOOTER,
                    fontSize = 13.sp,
                    color = secondaryTint,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
                )

                LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                    items(tasks, key = { it.threadId }) { task ->
                        TaskRow(
                            task = task,
                            chat = current,
                            onSwitch = {
                                scope.launch {
                                    switchTask(session, task, current)?.let { onSelectTask(it.target) }
                                    onDismiss()
                                }
                            },
                            onRename = {
                                title = task.title
                                renaming = task
                            },
                            onDelete = { scope.launch {
                                val updated = deleteTask(session, task, current)
                                if (task.threadId == current.threadId) updated?.let { onSelectTask(it.target) }
                            } },
                        )
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onDismiss) { Text("Done") }
                }
            }
        }
    }

    if (creating) {
        TaskTitleDialog(
            heading = "New thread",
            label = "Title (optional)",
            title = title,
            onTitleChange = { title = it },
            confirmText = "Create",
            confirmEnabled = TaskDialogRules.createEnabled(current),
            onConfirm = {
                val requested = TaskDialogRules.createTitle(title)
                creating = false
                scope.launch {
                    createTask(session, current, requested)?.let { onSelectTask(it.target) }
                    onDismiss()
                }
            },
            onCancel = { creating = false },
        )
    }

    renaming?.let { task ->
        TaskTitleDialog(
            heading = "Rename thread",
            label = "Title",
            title = title,
            onTitleChange = { title = it },
            confirmText = "Save",
            // An empty rename is allowed: the server labels it the untitled task,
            // and iOS submits the field as typed.
            confirmEnabled = TaskDialogRules.renameEnabled(current, title),
            onConfirm = {
                val requested = TaskDialogRules.renameTitle(title)
                renaming = null
                // Rename re-reads the stream rather than applying a returned bot:
                // the harness answers the rename with no record, so `Session`
                // refreshes. Kept as iOS has it.
                scope.launch { renameTask(session, task, current, requested) }
            },
            onCancel = { renaming = null },
        )
    }
}

@Composable
private fun TaskRow(
    task: BotTask,
    chat: Chat,
    onSwitch: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val current = TaskRules.isCurrent(task, chat)
    val canSwitch = TaskRules.canSwitch(task, chat)
    val canDelete = TaskRules.canDelete(task, chat)
    val now = remember(task.threadId) { System.currentTimeMillis() }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = canSwitch, onClick = onSwitch)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text = TaskRules.title(task),
                fontSize = 16.sp,
                color = if (canSwitch || current) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    secondaryTint
                },
            )
            Text(
                text = RelativeStamp.list(task.createdAt, now, locale = Locale.getDefault()),
                fontSize = 12.sp,
                color = secondaryTint,
            )
            task.openedByLabel?.let { openedBy ->
                Text(
                    text = openedBy,
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
        }

        if (current) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = "Current thread",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }

        Icon(
            imageVector = Icons.Filled.Edit,
            contentDescription = "Rename ${TaskRules.title(task)}",
            tint = secondaryTint,
            modifier = Modifier
                .size(28.dp)
                .clickable(enabled = TaskRules.canRename(chat), onClick = onRename)
                .padding(4.dp),
        )

        Icon(
            imageVector = Icons.Filled.Delete,
            contentDescription = "Delete ${TaskRules.title(task)}",
            tint = if (canDelete) MaterialTheme.colorScheme.error else secondaryTint.copy(alpha = 0.4f),
            modifier = Modifier
                .size(28.dp)
                .clickable(enabled = canDelete, onClick = onDelete)
                .padding(4.dp),
        )
    }
}

private suspend fun createTask(session: Session, chat: Chat, title: String?): Chat? =
    when (chat) {
        is Chat.BotChat -> session.createTask(chat.bot, title)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.createTask(chat.room, title)?.let(Chat::RoomChat)
    }

private suspend fun switchTask(session: Session, task: BotTask, chat: Chat): Chat? =
    when (chat) {
        is Chat.BotChat -> session.switchTask(task, chat.bot)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.switchTask(task, chat.room)?.let(Chat::RoomChat)
    }

private suspend fun renameTask(
    session: Session,
    task: BotTask,
    chat: Chat,
    title: String,
) {
    when (chat) {
        is Chat.BotChat -> session.renameTask(task, chat.bot, title)
        is Chat.RoomChat -> session.renameTask(task, chat.room, title)
    }
}

private suspend fun deleteTask(session: Session, task: BotTask, chat: Chat): Chat? =
    when (chat) {
        is Chat.BotChat -> session.deleteTask(task, chat.bot)?.let(Chat::BotChat)
        is Chat.RoomChat -> session.deleteTask(task, chat.room)?.let(Chat::RoomChat)
    }

@Composable
private fun TaskTitleDialog(
    heading: String,
    label: String,
    title: String,
    onTitleChange: (String) -> Unit,
    confirmText: String,
    confirmEnabled: Boolean,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(heading) },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = onTitleChange,
                label = { Text(label) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = confirmEnabled) { Text(confirmText) }
        },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}
