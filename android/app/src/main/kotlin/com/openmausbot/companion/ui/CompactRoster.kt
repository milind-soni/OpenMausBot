package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.AlignmentLine
import androidx.compose.ui.layout.FirstBaseline
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotProject
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.RosterBotRow
import com.openmausbot.companion.core.displayTitle
import com.openmausbot.companion.core.forTask
import com.openmausbot.companion.core.isArchived
import com.openmausbot.companion.core.isClosed
import com.openmausbot.companion.core.isSnoozed
import com.openmausbot.companion.core.labelsUnfiledThreads
import com.openmausbot.companion.core.listStamp
import com.openmausbot.companion.core.threadGroups
import java.util.Locale

/**
 * The compact home list: one line per bot and per group. It mirrors the iPhone
 * companion's compact list.
 *
 * The phone's version of the desktop sidebar's compact density: name, role and
 * status on one line, a crown after a Chief of Staff's name, and a thread list
 * only under a bot that has more than one thread — opened from its "› N"
 * control and lined up with the bot's name. What each row shows is decided in
 * `:core`'s [RosterBotRow]; this file is layout.
 */

/**
 * Horizontal rhythm shared by bot rows, group rows and the thread lines beneath
 * a bot, so a thread starts exactly where its bot's name does.
 */
internal object CompactRosterMetrics {
    /** Before the unread-dot gutter: with the gutter, faces start on the section titles' 20 dp edge. */
    val leading: Dp = 4.dp
    val dotGutter: Dp = 16.dp
    val faceSpacing: Dp = 12.dp
    val trailing: Dp = 16.dp

    /** The face at the default text size. It grows with the text, up to [maxFace]. */
    val face: Dp = 26.dp

    /** Where the largest text sizes stop growing the face and spend the width on names. */
    val maxFace: Dp = 40.dp

    /**
     * From this font scale up, one line cannot hold a name and a time: the name
     * takes the whole width and wraps between words, and the time, status and
     * role move beneath it. It is the first step past Android's old largest
     * setting, 1.3.
     */
    const val STACKED_FONT_SCALE: Float = 1.5f

    fun nameInset(face: Dp): Dp = leading + dotGutter + face + faceSpacing
}

/** The face, scaled with the text the way the rest of the row is. */
@Composable
private fun compactFace(): Dp =
    (CompactRosterMetrics.face * LocalDensity.current.fontScale)
        .coerceIn(CompactRosterMetrics.face, CompactRosterMetrics.maxFace)

@Composable
private fun stackedRows(): Boolean =
    LocalDensity.current.fontScale >= CompactRosterMetrics.STACKED_FONT_SCALE

/**
 * How a name or title wraps once it has lines to spare: between words,
 * balanced over its lines the way a heading is. Automatic hyphenation stays
 * off — on a phone it may cut "Christoffersen" into "Christof-" and "fersen" to
 * balance the lines.
 */
@Composable
private fun wrapsBetweenWords(): TextStyle =
    LocalTextStyle.current.copy(lineBreak = LineBreak.Heading, hyphens = Hyphens.None)

/**
 * The text to draw when it may wrap, with a zero-width break after each hyphen.
 * Without hyphenation Android's line breakers do not all treat a hyphen as a
 * place to break, and would cut a long double name mid-word instead of at its
 * own hyphen. The break has no width and screen readers skip it.
 */
private fun String.breakableAtHyphens(): String = replace("-", "-\u200B")

/** A glyph that sits in a line of text grows with that text. */
@Composable
private fun glyph(size: TextUnit): Dp = with(LocalDensity.current) { size.toDp() }

/** One bot on one line, with its threads beneath it when opened. */
@Composable
internal fun CompactBotEntry(
    bot: Bot,
    /** When the bot's current thread last moved, from the roster summary. */
    lastActivity: Double,
    face: MausState,
    /** An unanswered approval or question sits in one of its threads. */
    hasPendingCard: Boolean,
    query: String,
    expanded: Boolean,
    collapsedFolders: Set<String>,
    creating: Boolean,
    queuedThreadIds: Set<String>,
    /** The row itself: the bot's last-opened thread, as before. */
    onOpenRow: () -> Unit,
    onToggle: () -> Unit,
    onToggleFolder: (String) -> Unit,
    onCreate: () -> Unit,
    onManage: () -> Unit,
    /** An exact thread. */
    onOpen: (Chat) -> Unit,
    /** Forget that this bot's list was opened. */
    onCollapse: () -> Unit,
) {
    val searching = query.isNotBlank()
    // Wakes the list when a timed snooze ends, so the count and the list fold
    // that thread back in without waiting for a snapshot.
    val now = rememberSnoozeNow(bot.tasks.orEmpty())
    val row = RosterBotRow(bot, hasPendingCard, queuedThreadIds, now)
    // A list whose control went away is forgotten, not kept for a later
    // second thread to reopen by itself.
    val drops = row.dropsExpansion(expanded)
    LaunchedEffect(drops) { if (drops) onCollapse() }
    Column(modifier = Modifier.fillMaxWidth()) {
        CompactBotLine(
            bot = bot,
            row = row,
            lastActivity = lastActivity,
            face = face,
            listed = searching || expanded,
            searching = searching,
            // The New thread line shows its own progress; otherwise the row does.
            creatingHere = creating && !row.endsWithNewThread(expanded, searching),
            creating = creating,
            onOpenRow = onOpenRow,
            onToggle = onToggle,
            onCreate = onCreate,
            onManage = onManage,
        )
        if (row.listsThreads(expanded, searching)) {
            CompactThreadList(
                bot = bot,
                row = row,
                query = query,
                expanded = expanded,
                searching = searching,
                collapsedFolders = collapsedFolders,
                creating = creating,
                queuedThreadIds = queuedThreadIds,
                now = now,
                onToggleFolder = onToggleFolder,
                onCreate = onCreate,
                onOpen = onOpen,
            )
        }
    }
}

@Composable
private fun CompactBotLine(
    bot: Bot,
    row: RosterBotRow,
    lastActivity: Double,
    face: MausState,
    listed: Boolean,
    searching: Boolean,
    /** A thread is being made from this row's menu or TalkBack action: the spinner says so. */
    creatingHere: Boolean,
    creating: Boolean,
    onOpenRow: () -> Unit,
    onToggle: () -> Unit,
    onCreate: () -> Unit,
    onManage: () -> Unit,
) {
    val faceSize = compactFace()
    val stacked = stackedRows()
    val now = remember(lastActivity) { System.currentTimeMillis() }
    val stamp = if (row.showsTime && !creatingHere) {
        RelativeStamp.list(lastActivity, now, locale = Locale.getDefault())
    } else {
        ""
    }
    var menuOpen by remember { mutableStateOf(false) }

    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("chat-row.${bot.id}")
                    .combinedClickable(
                        role = Role.Button,
                        // A single-thread bot has no list to end in New thread,
                        // so the row offers it here — on every bot, one gesture.
                        onLongClickLabel = THREAD_ACTIONS,
                        onLongClick = { menuOpen = true },
                        onClick = onOpenRow,
                    )
                    // The same two, without the gesture, for TalkBack's actions menu.
                    .semantics {
                        customActions = listOf(
                            CustomAccessibilityAction(NEW_THREAD) {
                                if (!creating) onCreate()
                                !creating
                            },
                            CustomAccessibilityAction(MANAGE_THREADS) {
                                onManage()
                                true
                            },
                        )
                    }
                    .heightIn(min = MIN_TOUCH_TARGET)
                    .padding(
                        start = CompactRosterMetrics.leading,
                        end = if (row.showsThreadControl) 0.dp else CompactRosterMetrics.trailing,
                    )
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                UnreadDot(visible = row.showsUnreadDot, color = bot.color)
                BotAvatar(bot = bot, size = faceSize, state = face, animated = false)
                Spacer(modifier = Modifier.width(CompactRosterMetrics.faceSpacing))
                val status: @Composable () -> Unit = {
                    RowStatus(
                        waiting = row.showsWaiting,
                        working = row.showsSpinner || creatingHere,
                        stamp = stamp,
                        color = bot.color,
                        workingLabel = if (row.showsSpinner) WORKING else CREATING_THREAD,
                    )
                }
                if (stacked) {
                    // One line cannot hold a name and a time at these sizes: the
                    // name gets the whole width, whole words intact, and the
                    // time and role move beneath it.
                    Column(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        BotName(bot, row, maxLines = 3)
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            status()
                            if (bot.title.isNotEmpty()) {
                                // a time and a role in one quiet colour would read as one phrase
                                if (stamp.isNotEmpty()) Separator()
                                RoleText(bot.title, Modifier.weight(1f, fill = false))
                            }
                        }
                    }
                } else {
                    NameAndRole(
                        name = { BotName(bot, row, maxLines = 1) },
                        role = bot.title.takeIf { it.isNotEmpty() }?.let { title -> { RoleText(title) } },
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    status()
                }
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(NEW_THREAD) },
                    leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    enabled = !creating,
                    onClick = {
                        menuOpen = false
                        onCreate()
                    },
                )
                DropdownMenuItem(
                    text = { Text(MANAGE_THREADS) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
                    onClick = {
                        menuOpen = false
                        onManage()
                    },
                )
            }
        }
        if (row.showsThreadControl) {
            ThreadControl(bot = bot, count = row.threadCount, listed = listed, enabled = !searching, onToggle = onToggle)
        }
    }
}

/** The name, and the crown after it when the bot is a Chief of Staff. */
@Composable
private fun BotName(bot: Bot, row: RosterBotRow, maxLines: Int) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (maxLines > 1) bot.name.breakableAtHyphens() else bot.name,
            fontSize = 17.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = maxLines,
            overflow = TextOverflow.Ellipsis,
            style = if (maxLines > 1) wrapsBetweenWords() else LocalTextStyle.current,
            modifier = Modifier
                .weight(1f, fill = false)
                .testTag("bot-name.${bot.id}"),
        )
        if (row.showsChiefBadge) ChiefBadge()
    }
}

/** Between two quiet words on one line; nothing for TalkBack to read. */
@Composable
private fun Separator() {
    Text(
        text = "·",
        fontSize = 15.sp,
        color = secondaryTint,
        modifier = Modifier.clearAndSetSemantics {},
    )
}

/** The bot's job as plain quiet text — no chip — and the first thing to give way. */
@Composable
private fun RoleText(title: String, modifier: Modifier = Modifier) {
    Text(
        text = title,
        fontSize = 15.sp,
        color = secondaryTint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/**
 * Name first: the role takes what is left and truncates, and when too little
 * is left for a word of it the role steps aside rather than showing a sliver.
 * The two share a baseline.
 */
@Composable
private fun NameAndRole(
    name: @Composable () -> Unit,
    role: (@Composable () -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val roleContent: @Composable () -> Unit = role ?: {}
    Layout(contents = listOf(name, roleContent), modifier = modifier) { (names, roles), constraints ->
        val gap = ROLE_GAP.roundToPx()
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val namePlaced = names.single().measure(loose)
        val room = constraints.maxWidth - namePlaced.width - gap
        val rolePlaced = roles.singleOrNull()
            ?.takeIf { room >= MIN_ROLE_WIDTH.roundToPx() }
            ?.measure(loose.copy(maxWidth = room))
        val height = constraints.constrainHeight(maxOf(namePlaced.height, rolePlaced?.height ?: 0))
        val width = constraints.constrainWidth(
            if (constraints.hasBoundedWidth) constraints.maxWidth
            else namePlaced.width + (rolePlaced?.let { gap + it.width } ?: 0),
        )
        layout(width, height) {
            val nameTop = (height - namePlaced.height) / 2
            namePlaced.placeRelative(0, nameTop)
            rolePlaced?.let { placed ->
                val nameBaseline = namePlaced[FirstBaseline]
                val roleBaseline = placed[FirstBaseline]
                val top = if (nameBaseline != AlignmentLine.Unspecified && roleBaseline != AlignmentLine.Unspecified) {
                    nameTop + nameBaseline - roleBaseline
                } else {
                    (height - placed.height) / 2
                }
                placed.placeRelative(namePlaced.width + gap, top)
            }
        }
    }
}

/** "› N": the bot's threads, opened in place. */
@Composable
private fun ThreadControl(bot: Bot, count: Int, listed: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .testTag("threads-toggle.${bot.id}")
            .clickable(enabled = enabled, role = Role.Button, onClick = onToggle)
            // One label and one state, as a single control: merged, the drawn
            // count would be read out a second time before them. After the
            // clickable, so its button role and enabled state stay.
            .clearAndSetSemantics {
                contentDescription = "${bot.name}'s threads"
                stateDescription = "${if (listed) "Expanded" else "Collapsed"}, $count threads"
            }
            .heightIn(min = MIN_TOUCH_TARGET)
            .widthIn(min = MIN_TOUCH_TARGET)
            // its own padding lands the count on the edge other rows' times end on
            .padding(start = 8.dp, end = CompactRosterMetrics.trailing),
        horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.End),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (listed) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(glyph(16.sp)),
        )
        Text(
            text = count.toString(),
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            color = secondaryTint,
        )
    }
}

/** The threads beneath a bot, starting where its name starts. */
@Composable
private fun CompactThreadList(
    bot: Bot,
    row: RosterBotRow,
    query: String,
    expanded: Boolean,
    searching: Boolean,
    collapsedFolders: Set<String>,
    creating: Boolean,
    queuedThreadIds: Set<String>,
    now: Long,
    onToggleFolder: (String) -> Unit,
    onCreate: () -> Unit,
    onOpen: (Chat) -> Unit,
) {
    // A name match lists everything; otherwise only what matched.
    val groups = bot.threadGroups(
        matching = if (bot.name.contains(query, ignoreCase = true)) "" else query,
        now = now,
        queuedThreadIds = queuedThreadIds,
    )
    // Beneath a folder, unfiled threads would read as that folder's.
    val labelled = labelsUnfiledThreads(groups)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = CompactRosterMetrics.nameInset(compactFace()),
                end = CompactRosterMetrics.trailing,
                bottom = 4.dp,
            ),
    ) {
        groups.forEach { group ->
            val folder = group.project
            if (folder == null) {
                if (labelled) UnfiledLabel(bot)
                CompactThreadLines(group.tasks, bot, now, queuedThreadIds, onOpen)
            } else {
                val key = "${bot.id}:${folder.id}"
                val open = searching || key !in collapsedFolders
                FolderLine(folder, key, open = open, enabled = !searching, onToggle = { onToggleFolder(key) })
                if (open) CompactThreadLines(group.tasks, bot, now, queuedThreadIds, onOpen)
            }
        }
        if (row.endsWithNewThread(expanded, searching)) {
            NewThreadLine(bot = bot, creating = creating, onCreate = onCreate)
        }
    }
}

@Composable
private fun CompactThreadLines(
    tasks: List<BotTask>,
    bot: Bot,
    now: Long,
    queuedThreadIds: Set<String>,
    onOpen: (Chat) -> Unit,
) {
    tasks.forEach { task ->
        val projected = bot.forTask(task.threadId) ?: return@forEach
        CompactThreadLine(
            task = task,
            now = now,
            queued = task.threadId in queuedThreadIds,
            color = bot.color,
            modifier = Modifier
                .testTag("thread.${task.threadId}")
                .clickable(role = Role.Button) { onOpen(Chat.BotChat(projected)) }
                .heightIn(min = MIN_TOUCH_TARGET),
        )
    }
}

/** One thread under its bot: title, then its status and when it last moved. */
@Composable
private fun CompactThreadLine(task: BotTask, now: Long, queued: Boolean, color: String, modifier: Modifier) {
    val runtime = task.runtimeLabel(queued)
    val snoozed = task.isSnoozed(now)
    val dimmed = (task.isClosed || task.isArchived || snoozed) && runtime == null && task.unread != true
    val folded = when {
        task.isClosed -> "Closed"
        task.isArchived -> "Archived"
        snoozed -> "Snoozed"
        else -> null
    }
    val stampNow = remember(task.listStamp) { System.currentTimeMillis() }
    val stamp = RelativeStamp.list(task.listStamp, stampNow, locale = Locale.getDefault())
    val title: @Composable (Modifier, Int) -> Unit = { titleModifier, lines ->
        Row(
            modifier = titleModifier,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (lines > 1) task.displayTitle.breakableAtHyphens() else task.displayTitle,
                fontSize = 15.sp,
                fontWeight = if (task.unread == true) FontWeight.SemiBold else FontWeight.Normal,
                color = if (dimmed) secondaryTint else MaterialTheme.colorScheme.onSurface,
                maxLines = lines,
                overflow = TextOverflow.Ellipsis,
                style = if (lines > 1) wrapsBetweenWords() else LocalTextStyle.current,
                modifier = Modifier.weight(1f, fill = false),
            )
            // why it sits first in its list, as the comfortable byline says
            if (task.pinned == true) {
                Icon(
                    painter = painterResource(R.drawable.ic_push_pin),
                    contentDescription = PINNED,
                    tint = secondaryTint,
                    modifier = Modifier.size(glyph(12.sp)),
                )
            }
        }
    }
    val described = modifier
        .fillMaxWidth()
        .semantics { if (dimmed) folded?.let { stateDescription = it } }
        .padding(vertical = 6.dp)
    if (stackedRows()) {
        // the title gets the whole width; its marks and time follow
        Column(modifier = described, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            title(Modifier, 3)
            ThreadMarks(task, runtime, stamp, color)
        }
    } else {
        Row(
            modifier = described,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            title(Modifier.weight(1f), 1)
            ThreadMarks(task, runtime, stamp, color)
        }
    }
}

/** Unread, then the live mark, then the time — or the spinner in its place. */
@Composable
private fun ThreadMarks(task: BotTask, runtime: String?, stamp: String, color: String) {
    val size = glyph(13.sp)
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (task.unread == true) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape)
                    .semantics { contentDescription = UNREAD },
            )
        }
        when (runtime) {
            WAITING_ON_YOU -> Icon(
                painter = painterResource(R.drawable.ic_pan_tool),
                contentDescription = runtime,
                tint = Color(MausPalette.argb(color)),
                modifier = Modifier.size(size),
            )
            // a quiet clock, never a spinner: nothing is running yet
            "Waiting on teammate", "Queued" -> Icon(
                painter = painterResource(R.drawable.ic_schedule),
                contentDescription = runtime,
                tint = secondaryTint,
                modifier = Modifier.size(size),
            )
        }
        if (runtime == WORKING) {
            Spinner(size)
        } else if (stamp.isNotEmpty()) {
            Text(text = stamp, fontSize = 13.sp, color = secondaryTint, maxLines = 1)
        }
    }
}

/** A desktop folder inside an opened list: its mark, its name, and whether it is open. */
@Composable
private fun FolderLine(folder: BotProject, key: String, open: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("thread-folder.$key")
            .semantics(mergeDescendants = true) {
                contentDescription = "${folder.name} folder"
                stateDescription = if (open) "Expanded" else "Collapsed"
            }
            .clickable(enabled = enabled, role = Role.Button, onClick = onToggle)
            .heightIn(min = MIN_TOUCH_TARGET),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(folder.emoji?.takeIf { it.isNotBlank() } ?: "📁", fontSize = 13.sp)
        Text(
            text = folder.name,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = secondaryTint,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Icon(
            imageVector = if (open) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(glyph(14.sp)),
        )
    }
}

/**
 * A quiet heading over a bot's unfiled threads when a folder sits above them —
 * the desktop's "Threads" label. Not a control: nothing to open or close.
 */
@Composable
private fun UnfiledLabel(bot: Bot) {
    Text(
        text = UNFILED_THREADS,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = secondaryTint,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("unfiled-label.${bot.id}")
            .semantics { heading() }
            .heightIn(min = UNFILED_LABEL_HEIGHT)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

/** The end of an opened list: where a new thread with this bot starts. */
@Composable
private fun NewThreadLine(bot: Bot, creating: Boolean, onCreate: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("new-thread.${bot.id}")
            .semantics(mergeDescendants = true) { contentDescription = "New thread with ${bot.name}" }
            .clickable(enabled = !creating, role = Role.Button, onClick = onCreate)
            .heightIn(min = MIN_TOUCH_TARGET),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = accent, modifier = Modifier.size(glyph(18.sp)))
        Text(text = NEW_THREAD, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = accent)
        if (creating) Spinner(glyph(14.sp))
    }
}

/** A group on one line: two of its members' faces, overlapping, then its name. */
@Composable
internal fun CompactRoomRow(
    room: Room,
    /** Resolved members, in the room's own order; the first two lend their faces. */
    members: List<Bot>,
    lastActivity: Double,
    /** An unanswered approval or question sits in the group's thread. */
    waiting: Boolean,
    onClick: () -> Unit,
) {
    val busy = room.busyBotId != null
    val faceSize = compactFace()
    val now = remember(lastActivity) { System.currentTimeMillis() }
    val stamp = if (busy) "" else RelativeStamp.list(lastActivity, now, locale = Locale.getDefault())
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("chat-row.${room.id}")
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = MIN_TOUCH_TARGET)
            .padding(start = CompactRosterMetrics.leading, end = CompactRosterMetrics.trailing)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        UnreadDot(visible = room.unread && !busy, color = ROOM_COLOR)
        RoomFaces(members = members, size = faceSize)
        Spacer(modifier = Modifier.width(CompactRosterMetrics.faceSpacing))
        val name: @Composable (Modifier, Int) -> Unit = { nameModifier, lines ->
            Text(
                text = if (lines > 1) room.name.breakableAtHyphens() else room.name,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = lines,
                overflow = TextOverflow.Ellipsis,
                style = if (lines > 1) wrapsBetweenWords() else LocalTextStyle.current,
                modifier = nameModifier,
            )
        }
        if (stackedRows()) {
            // as on a bot's row: the whole width for the name
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                name(Modifier, 3)
                RowStatus(waiting = waiting, working = busy, stamp = stamp, color = ROOM_COLOR)
            }
        } else {
            name(Modifier.weight(1f), 1)
            Spacer(modifier = Modifier.width(8.dp))
            RowStatus(waiting = waiting, working = busy, stamp = stamp, color = ROOM_COLOR)
        }
    }
}

/**
 * Two members' faces in one face's square: the first up and to the start, the
 * second down and to the end on a ring of the list's background.
 */
@Composable
private fun RoomFaces(members: List<Bot>, size: Dp) {
    Box(modifier = Modifier.size(size)) {
        val first = members.getOrNull(0)
        if (first == null) {
            MausAvatar(color = ROOM_COLOR, size = size, state = MausState.HAPPY, animated = false)
        } else {
            BotAvatar(
                bot = first,
                size = size * 0.74f,
                state = MausState.HAPPY,
                animated = false,
                modifier = Modifier.align(Alignment.TopStart),
            )
        }
        members.getOrNull(1)?.let { second ->
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 3.dp, y = 3.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(1.5.dp),
            ) {
                BotAvatar(bot = second, size = size * 0.62f, state = MausState.HAPPY, animated = false)
            }
        }
    }
}

/** The unread dot, in its own gutter at the row's leading edge, in the chat's colour. */
@Composable
private fun UnreadDot(visible: Boolean, color: String) {
    Box(modifier = Modifier.width(CompactRosterMetrics.dotGutter), contentAlignment = Alignment.Center) {
        if (visible) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(Color(MausPalette.argb(color)), CircleShape)
                    .semantics { contentDescription = UNREAD },
            )
        }
    }
}

/**
 * The trailing marks: a hand in the chat's colour while it waits on the
 * person, and a spinner in place of the time while it works.
 */
@Composable
private fun RowStatus(
    waiting: Boolean,
    working: Boolean,
    stamp: String,
    color: String,
    /** What the spinner says to TalkBack: work, or a thread being made. */
    workingLabel: String = WORKING,
) {
    val size = glyph(15.sp)
    Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (waiting) {
            Icon(
                painter = painterResource(R.drawable.ic_pan_tool),
                contentDescription = WAITING_ON_YOU,
                tint = Color(MausPalette.argb(color)),
                modifier = Modifier.size(size),
            )
        }
        if (working) {
            Spinner(size, workingLabel)
        } else if (stamp.isNotEmpty()) {
            Text(text = stamp, fontSize = 15.sp, color = secondaryTint, maxLines = 1)
        }
    }
}

/**
 * The work mark. The indicator is its own semantics node, which TalkBack would
 * visit on its own; this reads as one word of the row it sits in instead.
 */
@Composable
private fun Spinner(size: Dp, label: String = WORKING) {
    Box(modifier = Modifier.clearAndSetSemantics { contentDescription = label }) {
        CircularProgressIndicator(modifier = Modifier.size(size), strokeWidth = 2.dp)
    }
}

/** The Chief of Staff mark after a bot's name: the desktop's crown, in the app's accent. */
@Composable
private fun ChiefBadge() {
    Icon(
        painter = painterResource(R.drawable.ic_crown),
        contentDescription = "Chief of Staff",
        tint = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .size(glyph(14.sp))
            .testTag("chief-badge"),
    )
}

private const val NEW_THREAD = "New thread"
private const val MANAGE_THREADS = "Manage threads"
private const val THREAD_ACTIONS = "Show thread actions"
private const val WAITING_ON_YOU = "Waiting on you"
private const val WORKING = "Working"
private const val CREATING_THREAD = "Creating a thread"
private const val UNREAD = "Unread"
private const val PINNED = "Pinned"

/** The desktop's `task.list` label over unfiled threads. */
private const val UNFILED_THREADS = "Threads"

/** A quiet label, not a control: shorter than a 48 dp touch target. */
private val UNFILED_LABEL_HEIGHT = 36.dp

/** Rooms have no colour of their own; `Chat.RoomChat.color` is always this. */
private const val ROOM_COLOR = "blue"

private val ROLE_GAP = 6.dp

/** Less room than this for the role, and it steps aside rather than showing a sliver. */
private val MIN_ROLE_WIDTH = 40.dp
