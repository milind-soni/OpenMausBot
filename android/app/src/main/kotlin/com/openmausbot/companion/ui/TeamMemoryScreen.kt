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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import com.openmausbot.companion.core.TeamMemoryEntry
import com.openmausbot.companion.core.TeamMemoryPage
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The people, places, decisions and terms every bot in a section shares.
 * Bots add what they learn (places and terms land at once; people and
 * decisions wait here for a tap); the person answers, adds, and removes.
 * The phone twin of Team map → Memory and of `ios/App/TeamMemoryView.swift`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamMemoryScreen(section: String, onBack: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connectionId = connection?.id
    val scope = rememberCoroutineScope()

    var page by remember(section, connectionId) { mutableStateOf<TeamMemoryPage?>(null) }
    var loading by remember(section, connectionId) { mutableStateOf(true) }
    var refreshing by remember(section, connectionId) { mutableStateOf(false) }
    var failed by remember(section, connectionId) { mutableStateOf(false) }
    var busyId by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var draftKind by remember { mutableStateOf("term") }
    var draftName by remember { mutableStateOf("") }
    var draftDetail by remember { mutableStateOf("") }

    suspend fun refresh(showProgress: Boolean = false) {
        if (showProgress) refreshing = true
        try {
            val loaded = session.loadTeamMemory(section)
            failed = loaded == null
            if (loaded != null) page = loaded
        } finally {
            if (showProgress) refreshing = false
        }
    }

    LaunchedEffect(section, connectionId) {
        loading = true
        try {
            refresh()
        } finally {
            loading = false
        }
    }

    fun apply(entries: List<TeamMemoryEntry>?) {
        val current = page ?: return
        if (entries != null) page = current.copy(entries = entries)
    }

    fun edit(id: String, action: suspend () -> List<TeamMemoryEntry>?) {
        scope.launch {
            busyId = id
            try {
                apply(action())
            } finally {
                busyId = null
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(TeamMemoryRules.title(page?.label), fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
                val entries = page?.entries
                when {
                    loading -> Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
                    }
                    entries != null -> {
                        val proposed = TeamMemoryRules.proposed(entries)
                        if (proposed.isNotEmpty()) {
                            FormSection(header = TeamMemoryRules.WAITING) {
                                proposed.forEach { entry ->
                                    EntryLine(entry)
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Button(
                                            onClick = { edit(entry.id) { session.editTeamMemory { it.answerTeamMemory(section, entry.id, remember = true) } } },
                                            enabled = busyId != entry.id,
                                        ) { Text(TeamMemoryRules.REMEMBER) }
                                        OutlinedButton(
                                            onClick = { edit(entry.id) { session.editTeamMemory { it.answerTeamMemory(section, entry.id, remember = false) } } },
                                            enabled = busyId != entry.id,
                                        ) { Text(TeamMemoryRules.SKIP) }
                                    }
                                }
                            }
                        }
                        val anyAccepted = TeamMemoryRules.KINDS.any { (kind, _) -> TeamMemoryRules.accepted(entries, kind).isNotEmpty() }
                        if (!anyAccepted && proposed.isEmpty()) {
                            FormSection(header = null) { Text(TeamMemoryRules.EMPTY, color = secondaryTint) }
                        }
                        TeamMemoryRules.KINDS.forEach { (kind, title) ->
                            val rows = TeamMemoryRules.accepted(entries, kind)
                            if (rows.isNotEmpty()) {
                                FormSection(header = title) {
                                    rows.forEach { entry ->
                                        Row(verticalAlignment = Alignment.Top) {
                                            Column(modifier = Modifier.weight(1f)) { EntryLine(entry) }
                                            ActionRow(
                                                text = "",
                                                icon = Icons.Filled.Delete,
                                                destructive = true,
                                                enabled = busyId != entry.id,
                                                onClick = { edit(entry.id) { session.editTeamMemory { it.removeTeamMemory(section, entry.id) } } },
                                            )
                                        }
                                    }
                                }
                            }
                        }
                        FormSection(header = null) {
                            if (adding) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    TeamMemoryRules.KINDS.forEach { (kind, title) ->
                                        FilterChip(
                                            selected = draftKind == kind,
                                            onClick = { draftKind = kind },
                                            label = { Text(title.removeSuffix("s")) },
                                        )
                                    }
                                }
                                OutlinedTextField(value = draftName, onValueChange = { draftName = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                                OutlinedTextField(
                                    value = draftDetail,
                                    onValueChange = { draftDetail = it },
                                    label = { Text("What every bot should know about it") },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(
                                        onClick = {
                                            val name = draftName.trim()
                                            val detail = draftDetail.trim()
                                            edit("new") {
                                                val result = session.editTeamMemory { it.addTeamMemory(section, draftKind, name, detail) }
                                                if (result != null) {
                                                    draftName = ""
                                                    draftDetail = ""
                                                    adding = false
                                                }
                                                result
                                            }
                                        },
                                        enabled = busyId != "new" && draftName.isNotBlank() && draftDetail.isNotBlank(),
                                    ) { Text("Add") }
                                    OutlinedButton(onClick = { adding = false }) { Text("Cancel") }
                                }
                            } else {
                                ActionRow(text = TeamMemoryRules.ADD, icon = Icons.Filled.AddCircle, onClick = { adding = true })
                            }
                        }
                    }
                    failed -> FormSection(header = null) { Text(TeamMemoryRules.FAILED, color = secondaryTint) }
                }
            }
        }
    }
}

private val dateFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM yyyy")

@Composable
private fun EntryLine(entry: TeamMemoryEntry) {
    Column {
        Text(TeamMemoryRules.heading(entry), fontSize = 15.sp, fontWeight = FontWeight.Medium)
        Text(entry.detail, fontSize = 15.sp)
        val date = Instant.ofEpochMilli(entry.updatedAt.toLong()).atZone(ZoneId.systemDefault()).toLocalDate().format(dateFormat)
        Text("${TeamMemoryRules.attribution(entry)} · $date", fontSize = 12.sp, color = secondaryTint)
    }
}
