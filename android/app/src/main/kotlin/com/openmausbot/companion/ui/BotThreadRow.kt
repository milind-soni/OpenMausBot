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
import com.openmausbot.companion.core.isArchived
import com.openmausbot.companion.core.isWaitingOnTeammate
import com.openmausbot.companion.core.isWorking
import com.openmausbot.companion.core.listStamp

/** The quiet status under a title: waiting states are never painted as work.
 * The queued flag is client state the harness reports out-of-band. */
internal fun BotTask.runtimeLabel(queued: Boolean = false): String? = when {
    activity == "waiting-on-you" -> "Waiting on you"
    isWaitingOnTeammate -> "Waiting on teammate"
    isWorking -> "Working"
    activity == "queued" || queued -> "Queued"
    else -> null
}

/** Shared by Home and the thread picker, with status taken from this thread alone. */
@Composable
internal fun BotThreadRow(
    task: BotTask,
    selected: Boolean = false,
    modifier: Modifier = Modifier,
    /** The thread is holding a queued send, from the client's queue state.
     * The harness reports this out-of-band; the activity string never says
     * it, so the row derives it here rather than parsing activity. */
    queued: Boolean = false,
) {
    val runtime = task.runtimeLabel(queued)
    val dimmed = (task.isClosed || task.isArchived) && runtime == null && task.unread != true
    val foldedState = when {
        task.isClosed -> "Closed"
        task.isArchived -> "Archived"
        else -> null
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {
                this.selected = selected
                if (dimmed) foldedState?.let { stateDescription = it }
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
                                "Waiting on teammate" -> secondaryTint
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
                RelativeStamp.updated(task.listStamp).takeIf { it.isNotEmpty() },
                "Pinned".takeIf { task.pinned == true },
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
