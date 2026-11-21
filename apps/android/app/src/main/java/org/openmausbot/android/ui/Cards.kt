package org.openmausbot.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.openmausbot.android.data.Card
import org.openmausbot.android.data.Message

/** Approvals, questions and the harness's other decision cards. The phone may
 *  only answer the exact pending request it was shown; nothing here can
 *  invent a standing grant beyond the "always allow" key the server issued. */
@Composable
fun DecisionCard(
    message: Message,
    onAnswer: (String) -> Unit,
    onAlwaysAllow: () -> Unit,
) {
    val card: Card = message.card ?: return
    var sending by remember(message.id) { mutableStateOf(false) }
    val accent = when {
        card.expired || card.stopped -> MaterialTheme.colorScheme.onSurfaceVariant
        card.isApproval -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.secondary
    }

    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        shape = RoundedCornerShape(14.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    when {
                        card.isQuestion -> "问题"
                        card.isApproval -> "审批"
                        else -> "请求"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = accent,
                    fontWeight = FontWeight.SemiBold,
                )
                card.tool?.let {
                    Text(
                        "  ·  $it",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                card.title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 6.dp),
            )
            if (card.subtitle.isNotBlank()) {
                Text(
                    card.subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            card.held?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            when {
                card.answeredText != null -> Result("已回答：${card.answeredText}")
                card.answered != null -> Result(
                    when (card.answered.lowercase()) {
                        "allow" -> "已允许"
                        "deny", "reject" -> "已拒绝"
                        else -> "已回答：${card.answered}"
                    }
                )
                card.expired -> Result("这个请求已过期，请让 Bot 重新发起。")
                card.stopped -> Result("当前回合已停止，无法再回答这个请求。")
                card.dismissed -> Result("已忽略")
                card.requestId == null -> Result("正在等待电脑响应")
                else -> {
                    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        card.options.forEach { option ->
                            val deny = option.lowercase().let {
                                it == "deny" || it == "reject" || it.contains("don't allow") || it.contains("deny")
                            }
                            if (deny) {
                                OutlinedButton(
                                    onClick = { sending = true; onAnswer(option) },
                                    enabled = !sending,
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text(optionLabel(option)) }
                            } else {
                                Button(
                                    onClick = { sending = true; onAnswer(option) },
                                    enabled = !sending,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    if (sending) CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp)
                                    else Text(optionLabel(option))
                                }
                            }
                        }
                        if (card.allowKey != null && card.isApproval) {
                            TextButton(
                                onClick = { sending = true; onAlwaysAllow() },
                                enabled = !sending,
                            ) { Text("始终允许此类操作") }
                        }
                    }
                }
            }
        }
    }
}

/** 审批选项由电脑以英文下发，这里只翻译标准选项，回传的仍是原值。 */
private fun optionLabel(option: String): String = when (option.trim().lowercase()) {
    "allow", "allow once" -> "允许一次"
    "always allow" -> "始终允许"
    "deny", "reject", "don't allow" -> "拒绝"
    else -> option
}

@Composable
private fun Result(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 10.dp),
    )
}
