package org.openmausbot.android.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.openmausbot.android.data.Bot
import org.openmausbot.android.data.ConnectionState
import org.openmausbot.android.data.Group
import org.openmausbot.android.data.Repo
import org.openmausbot.android.notify.Notifier
import androidx.compose.ui.platform.LocalContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen() {
    var selection by remember { mutableStateOf<Selection?>(null) }
    var tab by remember { mutableStateOf(0) }
    var showSettings by remember { mutableStateOf(false) }
    var newBotOpen by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        if (Repo.computer == null) Repo.connect()
    }

    LaunchedEffect(Repo.lastError) {
        val message = Repo.lastError ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(
            message = message,
            actionLabel = "忽略",
            withDismissAction = true,
            duration = SnackbarDuration.Short,
        )
        Repo.clearError()
    }

    BackHandler(enabled = selection != null) { selection = null }

    if (showSettings) {
        SettingsScreen(onClose = { showSettings = false })
        return
    }

    selection?.let { selected ->
        ChatScreen(
            selection = selected,
            onBack = { selection = null },
            onOpenSettings = { showSettings = true },
        )
        return
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                title = {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("OpenMausBot", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                            Box(Modifier.padding(start = 8.dp).size(8.dp).clip(CircleShape).background(statusColor()))
                        }
                        Text(
                            statusText(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { scope.launch { runCatching { Repo.refreshAll() } } }) {
                        Icon(Icons.Default.Refresh, contentDescription = "刷新")
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "更多")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("设置") }, onClick = { menuOpen = false; showSettings = true })
                        DropdownMenuItem(
                            text = { Text("重新连接") },
                            onClick = { menuOpen = false; Repo.connect() },
                        )
                    }
                },
            )
        },
        floatingActionButton = {
            if (tab == 0) {
                FloatingActionButton(onClick = { newBotOpen = true }) {
                    Icon(Icons.Default.Add, contentDescription = "新建 Bot")
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("聊天") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("房间") })
            }
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                when (val state = Repo.connection) {
                    is ConnectionState -> if (state.phase == ConnectionState.Phase.CONNECTING && Repo.bots.isEmpty()) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
                            Text(
                                state.detail.ifBlank { "正在连接…" },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 14.dp),
                            )
                        }
                    } else if (state.phase == ConnectionState.Phase.ERROR && Repo.bots.isEmpty()) {
                        ConnectionError(state.detail)
                    } else {
                        if (tab == 0) BotList(onOpen = { bot ->
                            selection = Selection.BotTarget(bot)
                            Repo.openThread(bot.activeTask?.threadId ?: bot.threadId)
                        }) else GroupList(onOpen = { group ->
                            selection = Selection.GroupTarget(group)
                            Repo.openThread(group.threadId)
                        })
                    }
                    else -> Unit
                }
            }
        }
    }

    if (newBotOpen) {
        NewBotDialog(
            onDismiss = { newBotOpen = false },
            onCreate = { name ->
                newBotOpen = false
                val id = Repo.createBot(name)
                if (id != null) scope.launch { Repo.refreshAll() }
            },
        )
    }

}

sealed interface Selection {
    data class BotTarget(val bot: Bot) : Selection
    data class GroupTarget(val group: Group) : Selection
}

@Composable
private fun statusColor(): Color = when (Repo.connection.phase) {
    ConnectionState.Phase.ONLINE -> Color(0xFF7EE787)
    ConnectionState.Phase.CONNECTING -> Color(0xFFF2DE7B)
    ConnectionState.Phase.ERROR, ConnectionState.Phase.OFFLINE -> Color(0xFFFF8A80)
    else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun statusText(): String = when (Repo.connection.phase) {
    ConnectionState.Phase.ONLINE -> Repo.computer?.serverName ?: "已连接"
    ConnectionState.Phase.CONNECTING -> "正在连接…"
    ConnectionState.Phase.ERROR -> "未连接"
    ConnectionState.Phase.OFFLINE -> "离线"
    else -> "未配对"
}

@Composable
private fun BotList(onOpen: (Bot) -> Unit) {
    val visible = Repo.bots.filterNot { it.hidden }
    if (visible.isEmpty()) {
        EmptyState("还没有 Bot", "点右下角的 + 新建一个。")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(visible, key = { it.id }) { bot ->
            BotRow(bot, onClick = { onOpen(bot) })
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
        }
    }
}

@Composable
private fun BotRow(bot: Bot, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BotAvatar(bot.name, bot.color, working = bot.busy, unread = bot.unread)
        Column(Modifier.weight(1f).padding(start = 13.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    bot.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (bot.pinned) Text("  · 置顶", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                bot.subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = when {
                    bot.activity == "waiting-on-you" -> MaterialTheme.colorScheme.error
                    bot.busy -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (bot.unread) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
        }
    }
}

@Composable
fun BotAvatar(name: String, color: String, working: Boolean = false, unread: Boolean = false) {
    val dark = isDark()
    val tint = botColor(color, dark)
    Box(
        Modifier
            .size(46.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = if (dark) 0.18f else 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        if (working) {
            CircularProgressIndicator(
                modifier = Modifier.size(46.dp),
                strokeWidth = 2.dp,
                color = tint,
            )
        }
        Text(
            name.trim().take(1).uppercase(),
            color = tint,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
        )
    }
}

@Composable
private fun GroupList(onOpen: (Group) -> Unit) {
    if (Repo.groups.isEmpty()) {
        EmptyState("还没有房间", "房间是多个 Bot 的群聊，请在电脑上创建。")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(Repo.groups, key = { it.id }) { group ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onOpen(group) }
                    .padding(horizontal = 18.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(46.dp).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer),
                    contentAlignment = Alignment.Center,
                ) { Text(group.name.take(1).uppercase(), color = MaterialTheme.colorScheme.onSecondaryContainer, fontWeight = FontWeight.Bold) }
                Column(Modifier.weight(1f).padding(start = 13.dp)) {
                    Text(group.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        group.subtitle,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
                if (group.unread) Box(Modifier.size(9.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

@Composable
private fun ConnectionError(detail: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("连不上你的电脑", style = MaterialTheme.typography.titleMedium)
        Text(
            detail.ifBlank { "那台电脑上的 OpenMausBot 必须正在运行，且手机要和它处于同一网络，或已配对可远程访问的线路。" },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
        TextButton(onClick = { Repo.connect() }, modifier = Modifier.padding(top = 12.dp)) { Text("重试") }
    }
}

@Composable
private fun NewBotDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建 Bot") },
        text = {
            Column {
                Text("每个 Bot 都有独立的对话、记忆和模型。", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(60) },
                    label = { Text("名称") },
                    singleLine = true,
                )
            }
        },
        confirmButton = { TextButton(onClick = { if (name.isNotBlank()) onCreate(name.trim()) }) { Text("创建") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
