package com.openmausbot.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.forTask
import com.openmausbot.companion.core.threadGroups

/** Local search includes desktop folder names and every visible conversation title. */
internal fun rosterThreadRows(summaries: List<ChatSummary>, query: String): List<ChatSummary> {
    val matching = RosterLayout.rows(summaries, query).mapTo(mutableSetOf()) { it.id }
    return summaries.filter { summary ->
        summary.id in matching || (summary.chat as? Chat.BotChat)?.bot
            ?.threadGroups(matching = query)?.isNotEmpty() == true
    }
}

@Composable
internal fun BotThreadTree(
    bot: Bot,
    query: String,
    expanded: Boolean,
    collapsedFolders: Set<String>,
    creating: Boolean,
    onToggle: () -> Unit,
    onToggleFolder: (String) -> Unit,
    onCreate: () -> Unit,
    onManage: () -> Unit,
    onOpen: (Chat) -> Unit,
) {
    val searching = query.isNotBlank()
    val isExpanded = searching || expanded
    val groups = bot.threadGroups(matching = if (bot.name.contains(query, ignoreCase = true)) "" else query)
    val count = bot.threadGroups().sumOf { it.tasks.size }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 88.dp, end = 18.dp, bottom = if (isExpanded) 12.dp else 0.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .testTag("threads-toggle.${bot.id}")
                    .semantics(mergeDescendants = true) {
                        contentDescription = "${bot.name}'s threads"
                        stateDescription = "${if (isExpanded) "Expanded" else "Collapsed"}, $count threads"
                    }
                    .clickable(enabled = !searching, role = Role.Button, onClick = onToggle)
                    .heightIn(min = 48.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DisclosureIcon(isExpanded)
                Text("Threads", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = secondaryTint)
                Text(count.toString(), fontSize = 13.sp, color = secondaryTint)
            }
            if (isExpanded) {
                TouchTarget(
                    onClick = onCreate,
                    enabled = !creating,
                    size = 48.dp,
                    contentDescription = "New thread with ${bot.name}",
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, tint = secondaryTint)
                }
                TouchTarget(
                    onClick = onManage,
                    size = 48.dp,
                    contentDescription = "Manage ${bot.name}'s threads",
                ) {
                    Icon(Icons.Filled.MoreVert, contentDescription = null, tint = secondaryTint)
                }
            }
        }
        if (isExpanded) {
            groups.forEach { group ->
                val folder = group.project
                if (folder == null) {
                    ThreadLinks(group.tasks, bot, onOpen)
                } else {
                    val key = "${bot.id}:${folder.id}"
                    val folderExpanded = searching || key !in collapsedFolders
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("thread-folder.$key")
                            .semantics(mergeDescendants = true) {
                                contentDescription = "${folder.name} folder"
                                stateDescription = if (folderExpanded) "Expanded" else "Collapsed"
                            }
                            .clickable(enabled = !searching, role = Role.Button) { onToggleFolder(key) }
                            .heightIn(min = 48.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        DisclosureIcon(folderExpanded)
                        Text(folder.emoji?.takeIf { it.isNotBlank() } ?: "📁", fontSize = 13.sp)
                        Text(
                            folder.name,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = secondaryTint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (folderExpanded) {
                        Column(Modifier.padding(start = 8.dp)) { ThreadLinks(group.tasks, bot, onOpen) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThreadLinks(tasks: List<BotTask>, bot: Bot, onOpen: (Chat) -> Unit) {
    tasks.forEach { task ->
        val projected = bot.forTask(task.threadId)
        if (projected != null) {
            BotThreadRow(
                task,
                modifier = Modifier
                    .testTag("thread.${task.threadId}")
                    .clickable(role = Role.Button) { onOpen(Chat.BotChat(projected)) }
                    .heightIn(min = 48.dp)
                    .padding(vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun DisclosureIcon(expanded: Boolean) {
    Icon(
        if (expanded) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = secondaryTint,
        modifier = Modifier.size(16.dp),
    )
}
