package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.core.ActivityRow
import kotlinx.coroutines.launch

/**
 * What one bot did, newest first, grouped by day: every tool it used and
 * every approval it asked for, each with the outcome. The phone twin of the
 * desktop's Activity panel and of `ios/App/BotActivityView.swift`;
 * read-only, like [BotOverviewScreen] beside it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotActivityScreen(botId: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var rows by remember(botId, connectionId) { mutableStateOf<List<ActivityRow>?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }
    var failed by remember(botId, connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            val loaded = session.loadActivity(botId)
            failed = loaded == null
            if (loaded != null) rows = loaded
        } finally {
            if (showProgress) refreshing = false
        }
    }

    LaunchedEffect(botId, connectionId) {
        loading = true
        try {
            refresh()
        } finally {
            loading = false
        }
    }

    val name = state.bot(botId)?.name.orEmpty()

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(ActivityRules.title(name), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        }
        HorizontalDivider()

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refresh(showProgress = true) } },
            modifier = Modifier.fillMaxSize(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val current = rows
                when {
                    loading -> Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                    }
                    current != null && current.isEmpty() -> FormSection(header = null) {
                        Text(ActivityRules.empty(name), color = secondaryTint)
                    }
                    current != null -> ActivityRules.days(current).forEach { day ->
                        FormSection(header = day.label) {
                            day.rows.forEach { ActivityLine(it) }
                        }
                    }
                    failed -> FormSection(header = null) {
                        Text(ActivityRules.FAILED, color = secondaryTint)
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityLine(row: ActivityRow) {
    val chip = ActivityRules.chip(row.outcome)
    val chipColor = when (chip.tone) {
        ActivityRules.Tone.GOOD -> MaterialTheme.colorScheme.primary
        ActivityRules.Tone.BAD -> MaterialTheme.colorScheme.error
        ActivityRules.Tone.LIVE -> MaterialTheme.colorScheme.primary
        ActivityRules.Tone.WAITING -> MaterialTheme.colorScheme.tertiary
        ActivityRules.Tone.PLAIN -> secondaryTint
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(ActivityRules.time(row.at), fontSize = 12.sp, color = secondaryTint, modifier = Modifier.width(44.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.app?.let {
                    Text(it, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Text("·", fontSize = 15.sp, color = secondaryTint)
                }
                Text(row.label, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            row.summary?.takeIf { it.isNotBlank() }?.let {
                Text(it, fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = secondaryTint, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Text(
            chip.text,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = chipColor,
            modifier = Modifier
                .background(chipColor.copy(alpha = 0.15f), RoundedCornerShape(999.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}
