package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.bylineLabel
import com.openmausbot.companion.core.displayTitle
import com.openmausbot.companion.core.isClosed

/** Shared by Home and the thread picker, with status taken from this thread alone. */
@Composable
internal fun BotThreadRow(task: BotTask, selected: Boolean = false, modifier: Modifier = Modifier) {
    val runtime = when (task.activity) {
        "waiting-on-you" -> "Waiting on you"
        "queued" -> "Queued"
        "working", "running" -> "Working"
        else -> if (task.busy == true) "Working" else null
    }
    val dimmed = task.isClosed && runtime == null && task.unread != true
    val now = remember(task.createdAt) { System.currentTimeMillis() }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {
                this.selected = selected
                if (dimmed) stateDescription = "Closed"
            }
            .padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                text = task.displayTitle,
                fontSize = 16.sp,
                fontWeight = if (task.unread == true) FontWeight.SemiBold else FontWeight.Normal,
                color = if (dimmed) secondaryTint else MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (runtime != null || task.unread == true) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (runtime != null) {
                        Text(
                            text = runtime,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = when (runtime) {
                                "Waiting on you" -> MaterialTheme.colorScheme.error
                                "Queued" -> secondaryTint
                                else -> MaterialTheme.colorScheme.primary
                            },
                        )
                    }
                    if (task.unread == true) {
                        Text(
                            "Unread",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            val byline = listOfNotNull(
                RelativeStamp.list(task.createdAt, now).takeIf { it.isNotEmpty() },
                task.bylineLabel,
            ).joinToString(" · ")
            if (byline.isNotEmpty()) {
                Text(
                    byline,
                    fontSize = 12.sp,
                    color = secondaryTint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (selected) {
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
