package org.openmausbot.android.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.launch
import org.openmausbot.android.data.PairingInvite
import org.openmausbot.android.data.currentBaseUrl
import org.openmausbot.android.data.Repo

@Composable
fun PairScreen(invite: String?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pasted by remember { mutableStateOf("") }
    var manualOpen by remember { mutableStateOf(false) }
    var host by remember { mutableStateOf("http://") }
    var code by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<PairingInvite?>(null) }
    var saved by remember { mutableStateOf(Repo.computers) }

    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents == null) return@rememberLauncherForActivityResult
        val parsed = PairingInvite.parse(contents)
        if (parsed == null) error = "这个二维码不是 OpenMausBot 的配对码。"
        else pending = parsed
    }

    fun pair(inviteValue: PairingInvite) {
        busy = true
        error = null
        scope.launch {
            val outcome = Repo.pairWith(inviteValue)
            busy = false
            outcome.onSuccess {
                saved = Repo.computers
                pending = null
                onDismiss()
                Repo.connect(it)
            }.onFailure { error = it.message ?: "配对失败" }
        }
    }

    LaunchedEffect(invite) {
        if (invite != null) {
            val parsed = PairingInvite.parse(invite)
            if (parsed == null) error = "这个链接不是有效的配对邀请。"
            else pending = parsed
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 22.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Spacer(Modifier.height(40.dp))
            Text("OpenMausBot", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            Text(
                "你的 AI Bot 团队，随身携带。与电脑上运行的 OpenMausBot 配对即可使用。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )

            Spacer(Modifier.height(26.dp))

            if (pending != null) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Column(Modifier.padding(18.dp)) {
                        Text("连接这台电脑？", style = MaterialTheme.typography.titleMedium)
                        Text(
                            pending!!.serverName,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        Text(
                            pending!!.baseUrl,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                        if (pending!!.token == null && pending!!.code == null) {
                            Text(
                                "这个链接不含配对码。请在电脑上重新生成一个。",
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(
                                onClick = { pending?.let(::pair) },
                                enabled = !busy && (pending!!.token != null || pending!!.code != null),
                            ) {
                                if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                else Text("配对")
                            }
                            OutlinedButton(onClick = { pending = null; onDismiss() }) { Text("取消") }
                        }
                    }
                }
                Spacer(Modifier.height(22.dp))
            }

            Button(
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt("扫描电脑上的配对二维码")
                            .setBeepEnabled(false)
                            .setOrientationLocked(true)
                    )
                },
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) { Text("扫描配对二维码") }

            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = pasted,
                onValueChange = { pasted = it },
                label = { Text("粘贴邀请链接") },
                placeholder = { Text("openmausbot://pair?…") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                Button(
                    onClick = {
                        val parsed = PairingInvite.parse(pasted)
                        if (parsed == null) error = "无法识别这个链接。" else pending = parsed
                    },
                    enabled = pasted.isNotBlank(),
                ) { Text("使用链接") }
            }

            TextButton(onClick = { manualOpen = !manualOpen }, modifier = Modifier.padding(top = 2.dp)) {
                Text(if (manualOpen) "收起其他连接方式" else "其他连接方式")
            }

            if (manualOpen) {
                OutlinedTextField(
                    value = host,
                    onValueChange = { host = it },
                    label = { Text("电脑地址") },
                    placeholder = { Text("http://192.168.1.20:8810") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it.filter(Char::isDigit).take(6) },
                    label = { Text("六位配对码") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            val outcome = Repo.pairWithCode(host.trim(), code, null)
                            busy = false
                            outcome.onSuccess {
                                saved = Repo.computers
                                onDismiss()
                                Repo.connect(it)
                            }.onFailure { error = it.message ?: "配对失败" }
                        }
                    },
                    enabled = !busy && code.length == 6 && host.length > 8,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                ) { Text("用配对码配对") }
            }

            error?.let { message ->
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Start,
                    modifier = Modifier.padding(top = 14.dp),
                )
            }

            if (saved.isNotEmpty()) {
                Spacer(Modifier.height(30.dp))
                Text("已配对的电脑", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                saved.forEach { computer ->
                    Card(
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    ) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(34.dp)
                                    .background(MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.small),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    computer.serverName.take(1).uppercase(),
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                                Text(computer.serverName, style = MaterialTheme.typography.titleMedium)
                                Text(
                                    computer.currentBaseUrl(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            TextButton(onClick = {
                                Repo.forget(computer.id)
                                saved = Repo.computers
                            }) { Text("忘记") }
                            TextButton(onClick = { Repo.select(computer.id); onDismiss() }) { Text("打开") }
                        }
                    }
                }
            }
            Spacer(Modifier.height(40.dp))
        }
    }
}
