package com.openmausbot.companion.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.NotificationTarget
import com.openmausbot.companion.core.Routine
import com.openmausbot.companion.core.RoutineRun
import kotlinx.coroutines.launch

/**
 * Tasks & Routines — the port of `ios/App/TasksRoutinesView.swift`.
 *
 * A task is one conversation and result; a routine runs with fresh context and
 * collects results in one thread, with no cron syntax anywhere. Webhook management
 * and the cancel/seen operations on a run are not on the paired allowlist and have no
 * control here — only the receipts a webhook run leaves behind.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TasksRoutinesScreen(onBack: () -> Unit, onOpenChat: (Chat) -> Unit) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()
    val scope = rememberCoroutineScope()

    var routines by remember { mutableStateOf<List<Routine>>(emptyList()) }
    var runs by remember { mutableStateOf<List<RoutineRun>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var editor by rememberSaveable(stateSaver = RoutineEditorTarget.Saver) {
        mutableStateOf<RoutineEditorTarget?>(null)
    }
    var deleting by remember { mutableStateOf<Routine?>(null) }

    suspend fun reload() {
        loading = true
        val loaded = session.loadRoutines()
        routines = RoutineRules.sorted(loaded.routines)
        runs = loaded.runs
        loading = false
    }

    LaunchedEffect(Unit) { reload() }

    val receipts = remember(runs) { RoutineRules.receipts(runs) }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            HeaderBackButton(onBack)
            Text(
                text = "Threads & Routines",
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            ChromeButton(
                icon = Icons.Filled.Add,
                contentDescription = "New routine",
                onClick = { editor = RoutineEditorTarget.new() },
                size = 36.dp,
                glyph = 18.dp,
            )
        }
        HorizontalDivider()

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    reload()
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = 16.dp, bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item(key = "explainer") {
                    FormSection(header = null, footer = RoutineRules.HEADER_FOOTER) {
                        IconNote(
                            text = RoutineRules.HEADER_TASK,
                            painter = R.drawable.ic_chat_bubbles,
                            tint = MaterialTheme.colorScheme.onSurface,
                        )
                        IconNote(
                            text = RoutineRules.HEADER_ROUTINE,
                            painter = R.drawable.ic_schedule,
                            tint = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }

                item(key = "routines-header") {
                    SectionHeading("Routines")
                }

                if (routines.isEmpty() && !loading) {
                    item(key = "routines-empty") {
                        SectionNote(
                            title = RoutineRules.NO_ROUTINES_TITLE,
                            description = RoutineRules.NO_ROUTINES_DESCRIPTION,
                        )
                    }
                }

                items(routines, key = { it.id }) { routine ->
                    RoutineRow(
                        routine = routine,
                        bot = state.bot(routine.botId),
                        onEdit = { editor = RoutineEditorTarget.edit(routine) },
                        onRunNow = {
                            scope.launch {
                                session.runRoutine(routine)
                                reload()
                            }
                        },
                        onToggle = {
                            scope.launch {
                                if (!routine.canToggle()) return@launch
                                session.setRoutineEnabled(routine, !routine.enabled)
                                reload()
                            }
                        },
                        onDelete = { deleting = routine },
                    )
                }

                item(key = "receipts-header") {
                    SectionHeading("Run receipts")
                }

                if (receipts.isEmpty() && !loading) {
                    item(key = "receipts-empty") {
                        Text(
                            text = RoutineRules.NO_RECEIPTS,
                            fontSize = 14.sp,
                            color = secondaryTint,
                            modifier = Modifier.padding(horizontal = 20.dp),
                        )
                    }
                }

                items(receipts, key = { it.id }) { run ->
                    RoutineRunRow(
                        run = run,
                        bot = state.bot(run.botId),
                        onOpenTask = { target ->
                            scope.launch {
                                // The same resolver a notification tap uses: it
                                // hydrates when needed and switches the bot to
                                // the task the run created.
                                session.openNotification(target)?.let(onOpenChat)
                            }
                        },
                    )
                }

                item(key = "webhooks") {
                    FormSection(header = "Webhooks", footer = RoutineRules.WEBHOOKS_FOOTER) {
                        IconNote(text = RoutineRules.WEBHOOKS_LABEL, icon = Icons.Filled.Lock)
                    }
                }
            }
        }
    }

    editor?.let { target ->
        // Positional scoping, per routine: `rememberSaveable` inside the sheet is
        // keyed by where it sits in the composition, and this is what makes
        // "where" differ between one routine and the next at the same call site.
        key(target.stateKey) {
            RoutineEditorSheet(
                target = target,
                onSaved = { scope.launch { reload() } },
                onDismiss = { editor = null },
            )
        }
    }

    deleting?.let { routine ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete ${routine.name}?") },
            text = { Text(RoutineRules.DELETE_MESSAGE) },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleting = null
                        scope.launch {
                            if (session.deleteRoutine(routine)) reload()
                        }
                    },
                ) {
                    Text("Delete routine", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { deleting = null }) { Text("Cancel") }
            },
        )
    }
}

/**
 * What the editor is editing — `RoutineEditorTarget` in the Swift, which is
 * `@State` and so survives an orientation change without closing the sheet or
 * forgetting what was typed into it.
 *
 * Only [routineId] and [enabled] are written to saved state. [seed] is the live
 * record and deliberately is not: the form's fields are themselves
 * `rememberSaveable` and keyed to [stateKey], so after a recreation they carry
 * the user's draft, and re-seeding would overwrite it with a stale copy. The key
 * is also what stops one routine's saved draft from being handed to another
 * routine opened later at the same call site.
 */
internal data class RoutineEditorTarget(
    val routineId: String?,
    /** An edit must send the flag back unchanged; a new routine sends none. */
    val enabled: Boolean?,
    val seed: Routine?,
) {
    val stateKey: String get() = "routine-editor:${routineId ?: "new"}"

    companion object {
        fun new(): RoutineEditorTarget =
            RoutineEditorTarget(routineId = null, enabled = null, seed = null)

        fun edit(routine: Routine): RoutineEditorTarget =
            RoutineEditorTarget(routineId = routine.id, enabled = routine.enabled, seed = routine)

        /** An empty save is the closed sheet; restoring it runs the init instead. */
        val Saver: Saver<RoutineEditorTarget?, Any> = listSaver(
            save = { target ->
                if (target == null) {
                    emptyList()
                } else {
                    listOf(target.routineId ?: "", target.enabled?.toString() ?: "")
                }
            },
            restore = { saved ->
                if (saved.size < 2) {
                    null
                } else {
                    RoutineEditorTarget(
                        routineId = saved[0].ifEmpty { null },
                        enabled = saved[1].toBooleanStrictOrNull(),
                        seed = null,
                    )
                }
            },
        )
    }
}

/**
 * One routine.
 *
 * iOS puts Run now / Pause / Resume / Edit / Delete on swipes and repeats every
 * one of them in a context menu. Android has no swipe idiom in a Material list,
 * so the row's overflow carries that same menu, in the same order — the row
 * itself still opens the editor.
 */
@Composable
private fun RoutineRow(
    routine: Routine,
    bot: Bot?,
    onEdit: () -> Unit,
    onRunNow: () -> Unit,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    val now = remember(routine.id, routine.updatedAt) { System.currentTimeMillis().toDouble() }
    val canToggle = routine.canToggle(now)
    val badge = RoutineRules.pausedBadge(routine, now)
    var menuOpen by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button, onClick = onEdit)
            .padding(horizontal = 20.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bot != null) {
            BotAvatar(
                bot = bot,
                size = 42.dp,
                state = if (routine.enabled) MausState.IDLE else MausState.SLEEPING,
                animated = false,
            )
        } else {
            Icon(
                imageVector = Icons.Filled.Warning,
                contentDescription = null,
                tint = secondaryTint,
                modifier = Modifier.size(42.dp).padding(9.dp),
            )
        }

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(routine.name, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(
                text = RoutineRules.routineSubtitle(routine, bot?.name),
                fontSize = 12.sp,
                color = secondaryTint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        badge?.let {
            val paused = it == RoutineRules.PausedBadge.PAUSED
            if (paused) {
                Icon(
                    painter = painterResource(R.drawable.ic_pause_circle),
                    contentDescription = it.label,
                    tint = attentionTint,
                    modifier = Modifier.size(20.dp),
                )
            } else {
                Icon(
                    imageVector = Icons.Filled.CheckCircle,
                    contentDescription = it.label,
                    tint = secondaryTint,
                    modifier = Modifier.size(20.dp),
                )
            }
        }

        Box {
            ChromeButton(
                icon = Icons.Filled.MoreVert,
                contentDescription = "Actions for ${routine.name}",
                onClick = { menuOpen = true },
                size = 36.dp,
                glyph = 18.dp,
            )
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text("Run now") },
                    onClick = {
                        menuOpen = false
                        onRunNow()
                    },
                )
                if (canToggle) {
                    DropdownMenuItem(
                        text = { Text(if (routine.enabled) "Pause" else "Resume") },
                        onClick = {
                            menuOpen = false
                            onToggle()
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Edit") },
                    onClick = {
                        menuOpen = false
                        onEdit()
                    },
                )
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}

/** One run receipt — SwiftUI's `DisclosureGroup`, as a Material expanding row. */
@Composable
private fun RoutineRunRow(
    run: RoutineRun,
    bot: Bot?,
    onOpenTask: (NotificationTarget) -> Unit,
) {
    var expanded by remember(run.id) { mutableStateOf(false) }
    val status = RoutineRules.runStatus(run.status)
    val tint = runStatusTint(status)

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = MIN_TOUCH_TARGET)
                .clickable(role = Role.Button) { expanded = !expanded }
                .padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RunStatusIcon(status = status, tint = tint)
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(run.routineName, fontSize = 15.sp)
                Text(
                    text = RoutineRules.runSubtitle(run, bot?.name),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
            Text(
                text = RoutineRules.runStatusLabel(run.status),
                fontSize = 12.sp,
                color = tint,
            )
            Icon(
                imageVector = if (expanded) {
                    Icons.Filled.KeyboardArrowUp
                } else {
                    Icons.Filled.KeyboardArrowDown
                },
                contentDescription = null,
                tint = secondaryTint,
                modifier = Modifier.size(20.dp),
            )
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 52.dp, end = 20.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // `.textSelection(.enabled)` on both, in the Swift: a long answer
                // is meant to be selectable and an error is meant to be copyable.
                // The rows below it are controls and stay unselectable.
                run.output?.takeIf { it.isNotEmpty() }?.let {
                    SelectionContainer { Text(it, fontSize = 14.sp) }
                }
                run.error?.takeIf { it.isNotEmpty() }?.let {
                    SelectionContainer {
                        Text(it, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
                if (run.status == "waiting") {
                    Text(
                        text = RoutineRules.WAITING_ON_YOU,
                        fontSize = 14.sp,
                        color = attentionTint,
                    )
                }
                NotificationTarget.from(run.botId, run.threadId)?.let { target ->
                    ActionRow(
                        text = "Open thread",
                        icon = Icons.AutoMirrored.Filled.ExitToApp,
                        onClick = { onOpenTask(target) },
                    )
                }
            }
        }
    }
}

@Composable
private fun RunStatusIcon(status: RoutineRules.RunStatus, tint: Color) {
    val size = Modifier.size(20.dp)
    when (status) {
        RoutineRules.RunStatus.RUNNING -> Icon(
            imageVector = Icons.Filled.PlayArrow,
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
        RoutineRules.RunStatus.COMPLETED -> Icon(
            imageVector = Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
        RoutineRules.RunStatus.WAITING -> Icon(
            painter = painterResource(R.drawable.ic_pan_tool),
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
        RoutineRules.RunStatus.FAILED -> Icon(
            imageVector = Icons.Filled.Warning,
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
        RoutineRules.RunStatus.CANCELLED -> Icon(
            imageVector = Icons.Filled.Clear,
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
        RoutineRules.RunStatus.PENDING -> Icon(
            painter = painterResource(R.drawable.ic_schedule),
            contentDescription = null,
            tint = tint,
            modifier = size,
        )
    }
}

/**
 * SwiftUI's `.green` / `.orange` / `.red` / `.secondary`, in this app's palette:
 * the accent is already the mascot green, the mascot orange is the one this
 * theme does not name, and `error` is the red every other screen uses.
 */
@Composable
private fun runStatusTint(status: RoutineRules.RunStatus): Color = when (status) {
    RoutineRules.RunStatus.COMPLETED -> MaterialTheme.colorScheme.primary
    RoutineRules.RunStatus.WAITING -> attentionTint
    RoutineRules.RunStatus.FAILED -> MaterialTheme.colorScheme.error
    else -> secondaryTint
}

/** What "this stopped and is waiting for you" is painted with. */
internal val attentionTint: Color = Color(MausPalette.argb("orange"))

@Composable
internal fun SectionHeading(text: String) {
    Column(
        modifier = Modifier.padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = text.uppercase(),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = secondaryTint,
        )
        HorizontalDivider()
    }
}

/** `ContentUnavailableView`, inside a section rather than filling the screen. */
@Composable
private fun SectionNote(title: String, description: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Text(description, fontSize = 13.sp, color = secondaryTint)
    }
}
