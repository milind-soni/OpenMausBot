package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.BotOverview
import kotlinx.coroutines.launch

/**
 * "What this bot does" — a read-only, server-authored explanation of one bot's
 * standing configuration. The port of the same explanation
 * `ios/App/AgentProfileView.swift` opens from the profile sheet.
 *
 * Nothing here is editable. Identity, notifications and voice stay on
 * [AgentProfileSheet]; this screen only asks the paired computer what it wrote
 * about the agent and shows the sentences back — who it is, what it does, what
 * it can reach, what it refuses, and its most recent changes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BotOverviewScreen(botId: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var overview by remember(botId, connectionId) { mutableStateOf<BotOverview?>(null) }
    var loading by remember(botId, connectionId) { mutableStateOf(true) }
    var refreshing by remember(botId, connectionId) { mutableStateOf(false) }
    var failed by remember(botId, connectionId) { mutableStateOf(false) }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            val loaded = session.loadOverview(botId)
            failed = loaded == null
            if (loaded != null) overview = loaded
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

    val name = overview?.who?.name ?: state.bot(botId)?.name.orEmpty()
    val title = OverviewRules.title(name)

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
                val current = overview
                when {
                    loading -> Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                    }
                    current != null -> OverviewBody(current)
                    failed -> FormSection(header = null) {
                        Text(OverviewRules.FAILED, color = secondaryTint)
                    }
                }
            }
        }
    }
}

@Composable
private fun OverviewBody(overview: BotOverview) {
    FormSection(header = OverviewRules.WHO) {
        Text(overview.who.name, fontWeight = FontWeight.SemiBold)
        if (overview.who.title.isNotBlank()) {
            Text(overview.who.title)
        }
        if (overview.who.blurb.isNotBlank()) {
            Text(overview.who.blurb)
        }
        if (overview.who.soulLead.isNotBlank()) {
            Text(overview.who.soulLead, color = secondaryTint, fontSize = 13.sp)
        }
    }

    FormSection(header = OverviewRules.DOES) {
        if (overview.does.isEmpty()) {
            Text(OverviewRules.EMPTY_DOES, color = secondaryTint)
        } else {
            overview.does.forEach { line ->
                IconNote(text = line, painter = R.drawable.ic_schedule)
            }
        }
    }

    // No empty-state copy on either phone: the server sends this only when
    // there is something to say, and an empty list here is just a header
    // with nothing under it (`ios/App/BotOverviewView.swift:39-43`).
    FormSection(header = OverviewRules.REACHES) {
        overview.reaches.forEach { line ->
            IconNote(text = line, painter = R.drawable.ic_hub)
        }
    }

    FormSection(header = OverviewRules.WONT) {
        overview.wont.forEach { line ->
            IconNote(text = line, painter = R.drawable.ic_block)
        }
    }

    FormSection(header = OverviewRules.RECENT) {
        if (overview.recent.isEmpty()) {
            Text(OverviewRules.EMPTY_RECENT, color = secondaryTint)
        } else {
            overview.recent.forEach { entry ->
                Column {
                    Text(entry.summary)
                    Text(
                        RelativeStamp.dateAndTime(entry.at),
                        color = secondaryTint,
                        fontSize = 12.sp,
                    )
                }
            }
        }
    }
}
