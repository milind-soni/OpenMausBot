package org.openmausbot.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.openmausbot.android.data.ApiClient
import org.openmausbot.android.data.Bot
import org.openmausbot.android.data.Repo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotSheet(bot: Bot, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var name by remember(bot.id) { mutableStateOf(bot.name) }
    var model by remember(bot.id) { mutableStateOf(bot.modelSelection?.model ?: "") }
    var models by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var loadingModels by remember { mutableStateOf(true) }
    var notifications by remember(bot.id) { mutableStateOf(bot.notifications) }

    LaunchedEffect(bot.id) {
        val list = withContext(Dispatchers.IO) {
            runCatching {
                val answer = Repo.let {
                    // /api/instances lists the engines this computer can run.
                    ApiAccess.get("/api/instances")
                }
                parseModels(answer)
            }.getOrDefault(emptyList())
        }
        models = list
        loadingModels = false
        if (model.isBlank()) model = bot.modelSelection?.model ?: ""
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                BotAvatar(bot.name, bot.color, working = bot.busy)
                Column(Modifier.padding(start = 12.dp)) {
                    Text(bot.name, style = MaterialTheme.typography.titleLarge)
                    Text(
                        bot.modelSelection?.let { "${it.instanceId} · ${it.model}" } ?: "未选择模型",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            Text("名称", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(60) },
                    singleLine = true,
                    modifier = Modifier.weight(1f).padding(top = 6.dp),
                )
                TextButton(
                    onClick = {
                        if (name.isNotBlank() && name != bot.name) {
                            Repo.patchBot(bot.id, JSONObject().put("name", name.trim()))
                        }
                    },
                    enabled = name.isNotBlank() && name != bot.name,
                ) { Text("保存") }
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            Spacer(Modifier.height(14.dp))

            Text("模型", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (loadingModels) {
                Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.height(16.dp).padding(end = 8.dp), strokeWidth = 2.dp)
                    Text("正在读取这台电脑的模型…", style = MaterialTheme.typography.bodyMedium)
                }
            } else if (models.isEmpty()) {
                Text(
                    "当前连接无法获取模型列表，请在电脑上切换模型。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            } else {
                models.forEach { (instanceId, modelName) ->
                    val selected = modelName == model
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TextButton(
                            onClick = {
                                model = modelName
                                Repo.setModel(bot.id, instanceId, modelName, null)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                modelName,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                instanceId,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
            Spacer(Modifier.height(10.dp))

            SettingSwitch(
                title = "接收此 Bot 的通知",
                subtitle = "回复和审批请求会推送到手机",
                checked = notifications,
                onChecked = {
                    notifications = it
                    Repo.patchBot(bot.id, JSONObject().put("notifications", it))
                },
            )
            SettingSwitch(
                title = "置顶",
                subtitle = "让这个 Bot 始终排在列表顶部",
                checked = bot.pinned,
                onChecked = { Repo.patchBot(bot.id, JSONObject().put("pinned", it)) },
            )

            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(
                    onClick = {
                        // A fresh conversation on the same bot: the harness
                        // opens one when a new thread title is asked for.
                        Repo.scope.launch {
                            runCatching {
                                ApiAccess.post("/api/bots/${bot.id}/tasks", JSONObject().put("title", "新对话"))
                                Repo.refreshAll()
                            }
                        }
                        onDismiss()
                    },
                ) { Text("新对话") }
                TextButton(
                    onClick = {
                        Repo.patchBot(bot.id, JSONObject().put("hidden", true))
                        onDismiss()
                    },
                ) { Text("隐藏 Bot") }
            }
        }
    }
}

@Composable
fun SettingSwitch(
    title: String,
    subtitle: String,
    checked: Boolean,
    onChecked: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onChecked)
    }
}

/** Small indirection so the sheet can talk to the same authenticated client the
 *  rest of the app uses without exposing it from Repo. */
object ApiAccess {
    private fun api(): ApiClient? = Repo.let { repo ->
        val computer = repo.computer ?: return null
        ApiClient(computer.baseUrl, computer.token)
    }

    fun get(path: String): JSONObject = api()?.get(path) ?: JSONObject()
    fun post(path: String, body: JSONObject): JSONObject = api()?.post(path, body) ?: JSONObject()
}

/** Model catalogs differ per engine: instances carry either `models` or a
 *  `catalog`. Both shapes become (instanceId, model) pairs. */
fun parseModels(answer: JSONObject): List<Pair<String, String>> {
    val result = mutableListOf<Pair<String, String>>()
    val instances = answer.optJSONArray("instances") ?: answer.optJSONArray("engines") ?: return result
    for (index in 0 until instances.length()) {
        val instance = instances.optJSONObject(index) ?: continue
        val instanceId = instance.optString("instanceId").takeIf { it.isNotBlank() } ?: continue
        val models = instance.optJSONArray("models")
            ?: instance.optJSONObject("catalog")?.optJSONArray("models")
        if (models != null) {
            for (modelIndex in 0 until models.length()) {
                val entry = models.opt(modelIndex)
                val name = when (entry) {
                    is String -> entry
                    is JSONObject -> entry.optString("id").ifBlank { entry.optString("model") }
                    else -> null
                }
                if (!name.isNullOrBlank()) result.add(instanceId to name)
            }
        }
    }
    return result.distinct()
}
