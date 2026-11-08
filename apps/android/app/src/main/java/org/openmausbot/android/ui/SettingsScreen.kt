package org.openmausbot.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.openmausbot.android.BuildConfig
import org.openmausbot.android.data.ConnectionState
import org.openmausbot.android.data.Repo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onClose: () -> Unit) {
    var dark by remember { mutableStateOf(Repo.store.darkTheme) }
    var notify by remember { mutableStateOf(Repo.store.notifyWhileClosed) }
    var speak by remember { mutableStateOf(Repo.store.speakReplies) }
    var computers by remember { mutableStateOf(Repo.computers) }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                navigationIcon = {
                    IconButton(onClick = onClose) { Icon(Icons.Default.ArrowBack, contentDescription = "返回") }
                },
                title = { Text("设置", fontWeight = FontWeight.SemiBold) },
            )
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
        ) {
            Section("外观")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("主题", style = MaterialTheme.typography.titleMedium)
                    Text(
                        when (dark) {
                            true -> "深色"
                            false -> "浅色"
                            null -> "跟随系统"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = {
                    dark = when (dark) {
                        null -> true
                        true -> false
                        false -> null
                    }
                    Repo.store.darkTheme = dark
                }) {
                    Text(when (dark) { null -> "系统"; true -> "深色"; false -> "浅色" })
                }
            }

            Section("提醒")
            SettingSwitch(
                title = "后台通知",
                subtitle = "在后台保持连接，Bot 回复时发送通知。",
                checked = notify,
            ) {
                notify = it
                Repo.store.notifyWhileClosed = it
            }
            SettingSwitch(
                title = "朗读回复",
                subtitle = "使用手机自带的语音引擎朗读新的 Bot 消息。",
                checked = speak,
            ) {
                speak = it
                Repo.store.speakReplies = it
            }

            Section("连接")
            val computer = Repo.computer
            Text(
                computer?.serverName ?: "未连接",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                computer?.baseUrl ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                when (Repo.connection.phase) {
                    ConnectionState.Phase.ONLINE -> "已连接"
                    ConnectionState.Phase.CONNECTING -> "正在连接"
                    ConnectionState.Phase.ERROR -> "出错"
                    ConnectionState.Phase.OFFLINE -> "离线"
                    else -> "空闲"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = when (Repo.connection.phase) {
                    ConnectionState.Phase.ONLINE -> MaterialTheme.colorScheme.primary
                    ConnectionState.Phase.ERROR -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.padding(top = 2.dp),
            )
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { Repo.connect() }) { Text("重新连接") }
                TextButton(onClick = {
                    computer?.let { Repo.forget(it.id) }
                    computers = Repo.computers
                    onClose()
                }) { Text("忘记这台电脑") }
            }

            HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))

            Text("已配对的电脑", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            computers.forEach { saved ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            Repo.select(saved.id)
                            onClose()
                        }
                        .padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(saved.serverName, style = MaterialTheme.typography.titleMedium)
                        Text(
                            saved.baseUrl,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (saved.id == computer?.id) {
                        Text("当前", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            TextButton(onClick = {
                Repo.disconnect()
                onClose()
            }) { Text("配对另一台电脑") }

            Spacer(Modifier.height(24.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            Text(
                "OpenMausBot Android 版 ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.bodyMedium,
                fontSize = 13.sp,
                modifier = Modifier.padding(top = 14.dp),
            )
            Text(
                "你的电脑负责运行 Bot。此应用只保存一个可撤销的设备令牌，不会在电脑之外保存 Bot 凭据或聊天记录。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp, bottom = 40.dp),
            )
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(
        title.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 22.dp, bottom = 4.dp),
    )
}
