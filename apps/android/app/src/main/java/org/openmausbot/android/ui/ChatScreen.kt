package org.openmausbot.android.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.openmausbot.android.data.Attachment
import org.openmausbot.android.data.Message
import org.openmausbot.android.data.Repo
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    selection: Selection,
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val bot = (selection as? Selection.BotTarget)?.bot
    val group = (selection as? Selection.GroupTarget)?.group
    val threadId = bot?.activeTask?.threadId ?: bot?.threadId ?: group?.threadId ?: ""
    val title = bot?.name ?: group?.name ?: "聊天"
    val subtitle = bot?.subtitle ?: group?.subtitle ?: ""
    val liveBot = bot?.let { Repo.bots.firstOrNull { b -> b.id == it.id } } ?: bot
    val messages = Repo.messages(threadId)
    val visibleMessages = messages.filterNot { it.isChatNoise() }
    val hasMore = Repo.hasMore(threadId)
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf(false) }
    var didInitialScroll by remember(threadId) { mutableStateOf(false) }
    var draft by rememberSaveable(threadId) { mutableStateOf("") }
    var attachment by remember { mutableStateOf<Attachment?>(null) }
    var uploading by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val busy = liveBot?.busy == true

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        uploading = true
        scope.launch {
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            }.getOrNull()
            val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
            if (bytes != null) {
                Repo.uploadImage(bytes, mime, "photo.jpg").onSuccess { attachment = it }
            }
            uploading = false
        }
    }

    LaunchedEffect(threadId) {
        Repo.openThread(threadId)
    }
    LaunchedEffect(threadId, Repo.openThreadId) {
        Repo.openThreadId = threadId
    }
    LaunchedEffect(threadId, visibleMessages.size) {
        if (visibleMessages.isEmpty()) return@LaunchedEffect
        val lastItem = visibleMessages.lastIndex + if (hasMore) 1 else 0
        if (!didInitialScroll) {
            runCatching { listState.scrollToItem(lastItem) }
            didInitialScroll = true
        } else {
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            if (lastVisible >= lastItem - 2) {
                runCatching { listState.animateScrollToItem(lastItem) }
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, contentDescription = "返回") }
                },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (liveBot != null) {
                            BotAvatar(liveBot.name, liveBot.color, working = liveBot.busy)
                            Spacer(Modifier.size(10.dp))
                        }
                        Column {
                            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                subtitle,
                                style = MaterialTheme.typography.labelSmall,
                                color = if (busy) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "菜单") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (bot != null) {
                            DropdownMenuItem(text = { Text("Bot 设置") }, onClick = { menu = false; sheet = true })
                            DropdownMenuItem(
                                text = { Text("停止本轮") },
                                enabled = busy,
                                onClick = { menu = false; Repo.interrupt(bot.id, threadId) },
                            )
                        }
                        DropdownMenuItem(text = { Text("设置") }, onClick = { menu = false; onOpenSettings() })
                    }
                },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 10.dp),
            ) {
                if (hasMore && visibleMessages.isNotEmpty()) {
                    item {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            if (Repo.isLoading(threadId)) {
                                CircularProgressIndicator(Modifier.padding(10.dp).size(18.dp), strokeWidth = 2.dp)
                            } else {
                                TextButton(onClick = { scope.launch { Repo.loadOlder(threadId) } }) { Text("加载更早") }
                            }
                        }
                    }
                }
                items(visibleMessages, key = { it.id }) { message ->
                    MessageRow(
                        message = message,
                        botId = bot?.id,
                        threadId = threadId,
                        onAnswer = { answer -> bot?.let { Repo.respondCard(it.id, threadId, message, answer) } },
                        onAlwaysAllow = { message.card?.let { bot?.let { b -> Repo.alwaysAllow(b.id, threadId, it) } } },
                    )
                }
                item { Spacer(Modifier.height(6.dp)) }
            }

            attachment?.let { pending ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("已附加 1 张图片", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    TextButton(onClick = { attachment = null }) { Text("移除") }
                }
            }

            Composer(
                draft = draft,
                onDraft = { draft = it },
                busy = busy,
                uploading = uploading,
                canAttach = bot != null,
                onAttach = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onSend = {
                    val text = draft
                    val files = listOfNotNull(attachment)
                    if (bot != null) {
                        Repo.send(bot.id, threadId, text, files)
                    } else if (group != null) {
                        Repo.sendToGroup(group.id, threadId, text)
                    }
                    draft = ""
                    attachment = null
                },
                onStop = { bot?.let { Repo.interrupt(it.id, threadId) } },
            )
        }
    }

    if (sheet && bot != null) {
        BotSheet(bot = liveBot ?: bot, onDismiss = { sheet = false })
    }
}

private fun Message.isChatNoise(): Boolean =
    kind == "digest" || kind == "activity" || kind == "notice" ||
        tool != null || (isBot && (text.startsWith("[digest]") || text.startsWith("notice:")))

@Composable
private fun MessageRow(
    message: Message,
    botId: String?,
    threadId: String,
    onAnswer: (String) -> Unit,
    onAlwaysAllow: () -> Unit,
) {
    val dark = isDark()
    val fromColor = message.fromColor?.let { botColor(it, dark) }
    when {
        message.kind == "activity" || message.tool != null -> {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 5.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                Text(
                    message.tool?.let { tool ->
                        (tool.label ?: tool.name).let { if (tool.ok) it else "失败：$it" }
                    } ?: message.text,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (message.tool?.ok == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        message.isUser -> Row(
            Modifier.fillMaxWidth().padding(vertical = 3.dp),
            horizontalArrangement = Arrangement.End,
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp),
                modifier = Modifier.widthIn(max = 320.dp),
            ) {
                Column(Modifier.padding(horizontal = 14.dp, vertical = 9.dp)) {
                    if (message.text.isNotBlank()) Text(message.text, style = MaterialTheme.typography.bodyLarge)
                    message.attachments.forEach { AttachmentView(it) }
                    if (message.pending) {
                        Text(
                            if (message.failed) "未发送" else "发送中…",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (message.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.6f),
                        )
                    }
                }
            }
        }
        else -> Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
            message.fromName?.let { name ->
                Text(
                    name,
                    style = MaterialTheme.typography.labelSmall,
                    color = fromColor ?: MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(bottom = 3.dp, start = 2.dp),
                )
            }
            if (message.card != null) {
                DecisionCard(message, onAnswer = onAnswer, onAlwaysAllow = onAlwaysAllow)
            } else {
                Surface(
                    color = MaterialTheme.colorScheme.surface,
                    shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp),
                    modifier = Modifier.widthIn(max = 340.dp),
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        if (message.text.isNotBlank()) Markdown(message.text)
                        message.attachments.forEach { AttachmentView(it) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentView(attachment: Attachment) {
    if (!attachment.isImage) {
        Text(
            attachment.name ?: "附件",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
        return
    }
    val bitmap by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, attachment.path) {
        val bytes = Repo.imageBytes(attachment.path)
        value = bytes?.let { raw ->
            runCatching { BitmapFactory.decodeByteArray(raw, 0, raw.size)?.asImageBitmap() }.getOrNull()
        }
    }
    val image = bitmap
    if (image != null) {
        Image(
            bitmap = image,
            contentDescription = attachment.name ?: "图片",
            modifier = Modifier
                .padding(top = 6.dp)
                .clip(RoundedCornerShape(12.dp))
                .widthIn(max = 300.dp),
        )
    } else {
        Box(
            Modifier
                .padding(top = 6.dp)
                .size(width = 180.dp, height = 90.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center,
        ) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    busy: Boolean,
    uploading: Boolean,
    canAttach: Boolean,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
        Row(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (canAttach) {
                IconButton(onClick = onAttach, enabled = !uploading) {
                    if (uploading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Text("＋", fontSize = 24.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.weight(1f).padding(horizontal = 2.dp),
                placeholder = { Text(if (busy) "Bot 正在工作…" else "输入消息") },
                maxLines = 6,
                shape = RoundedCornerShape(22.dp),
            )
            if (busy) {
                IconButton(onClick = onStop) {
                    Icon(Icons.Default.Close, contentDescription = "停止", tint = MaterialTheme.colorScheme.error)
                }
            } else {
                IconButton(onClick = onSend, enabled = draft.isNotBlank()) {
                    Icon(
                        Icons.Default.Send,
                        contentDescription = "发送",
                        tint = if (draft.isNotBlank()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                    )
                }
            }
        }
    }
}
