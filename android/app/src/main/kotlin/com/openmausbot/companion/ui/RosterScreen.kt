package com.openmausbot.companion.ui

import androidx.compose.ui.res.stringResource

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
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
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatSummary
import com.openmausbot.companion.core.Room
import com.openmausbot.companion.core.SearchHit
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.chat
import com.openmausbot.companion.core.chatSummaries
import com.openmausbot.companion.core.forTask
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The roster — the port of `ios/App/ChatListView.swift`.
 *
 * Messages-shaped: a header with you on the left and settings on the right, your
 * groups across the top, every bot below with the unread dot in the bot's own
 * colour at the left edge, and a bar floating at the bottom. The bar's pill is
 * Updates — only the bots that need you, are working, or have something you have
 * not read — beside round search and new-bot buttons. Everything scrolls under
 * the bar, which is why the list leaves [BAR_CLEARANCE] below its last row.
 *
 * Ordering is not decided here. `chatSummaries` (`:core`) folds pinned → unread →
 * last activity and hides hidden bots; [RosterLayout] decides which of those are
 * rows and which are tiles; the screen renders what it is handed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RosterScreen(navigator: CompanionNavigator) {
    val environment = LocalCompanion.current
    val session = environment.session
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val state by session.state.collectAsState()
    val connection by session.connection.collectAsState()
    val status by session.status.collectAsState()
    // The same preference the transcript folds by, from the same store: a reader
    // who turned activity off must not still read tool names here.
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()

    var bar by rememberSaveable(stateSaver = RosterBarSaver) { mutableStateOf(RosterBar()) }
    var hits by remember { mutableStateOf<List<SearchHit>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var showingUpdates by remember { mutableStateOf(false) }
    var showingNewGroup by remember { mutableStateOf(false) }
    var showingNewSection by remember { mutableStateOf(false) }
    var expandedBots by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var collapsedFolders by rememberSaveable(stateSaver = StringSetSaver) { mutableStateOf(emptySet<String>()) }
    var creatingThreads by remember { mutableStateOf(emptySet<String>()) }
    // One createBot at a time: a second tap while the first is in flight
    // would race two bots into existence.
    var creatingBot by remember { mutableStateOf(false) }
    var managingThreads by remember { mutableStateOf<Chat?>(null) }

    val query = bar.query

    // Local filtering is always on; the computer is only asked past two
    // characters and after a quiet moment (§10).
    LaunchedEffect(query) {
        when (val decision = SearchPolicy.decide(query)) {
            SearchPolicy.Decision.Clear -> {
                hits = emptyList()
                searching = false
            }
            is SearchPolicy.Decision.Remote -> {
                searching = true
                delay(SearchPolicy.DEBOUNCE_MILLIS)
                hits = session.search(decision.query)
                searching = false
            }
        }
    }

    // Folding the fleet walks every thread's transcript, so it is keyed on the
    // state and the activity level alone: typing filters the fold instead of
    // repeating it.
    val summaries = remember(state, activityDetail) { state.chatSummaries(activityDetail) }
    // Only a search has rows to filter; the unsearched roster is assembled
    // section by section below.
    val rows = remember(summaries, query, state.queuedThreadIds) {
        rosterThreadRows(summaries, query, state.queuedThreadIds)
    }
    val approvals = remember(state) { state.pendingApprovals }
    val waiting = remember(state, approvals) { RosterLayout.waitingChats(state, approvals) }
    // One pass over the fleet rather than one per row: resolving a face walks the
    // chat's visible transcript.
    val faces = remember(state, summaries) {
        summaries.associate { it.id to MausState.forChat(it.chat, state) }
    }
    val summariesById = remember(summaries) { summaries.associateBy { it.id } }
    // Hoisted out of the list: read inside a lazy item, `state` would make that
    // item's recompose scope the whole fleet.
    val rooms = state.rooms
    val tiles = remember(state) {
        rooms.associate { it.id to RosterLayout.memberBots(state, it) }
    }
    // Read by the bar over the list and by nothing inside it, so the rows never
    // recompose for it. `approvals` is handed over rather than walked again.
    val updates = remember(state, approvals) { state.updates(approvals) }
    // The cross-bot Needs attention section rides above every roster section.
    val attention = remember(state) { state.crossBotAttention() }

    val entry: @Composable (ChatSummary, Boolean) -> Unit = { summary, last ->
        Column {
            ChatRow(
                summary = summary,
                face = faces[summary.id] ?: MausState.IDLE,
                waiting = summary.id in waiting,
                last = last,
                onClick = { navigator.open(environment.chatPreferences.restoringThread(summary.chat, connection?.id)) },
            )
            (summary.chat as? Chat.BotChat)?.bot?.let { bot ->
                BotThreadTree(
                    bot = bot,
                    queuedThreadIds = state.queuedThreadIds,
                    query = query,
                    expanded = bot.id in expandedBots,
                    collapsedFolders = collapsedFolders,
                    creating = bot.id in creatingThreads,
                    onToggle = {
                        haptics.play(HapticCue.SELECT)
                        expandedBots = if (bot.id in expandedBots) expandedBots - bot.id else expandedBots + bot.id
                    },
                    onToggleFolder = { key ->
                        haptics.play(HapticCue.SELECT)
                        collapsedFolders = if (key in collapsedFolders) collapsedFolders - key else collapsedFolders + key
                    },
                    onCreate = {
                        // Hoisted across bot sections and search, so moving a row
                        // cannot permit a second creation while the first is pending.
                        if (bot.id !in creatingThreads) {
                            creatingThreads = creatingThreads + bot.id
                            scope.launch {
                                try {
                                    val created = session.createTask(bot, title = null)
                                    if (created != null) {
                                        navigator.open(Chat.BotChat(created))
                                    } else if (session.actionError == null) {
                                        session.actionError = "Couldn't create a thread. Check the connection and try again."
                                    }
                                } finally {
                                    creatingThreads = creatingThreads - bot.id
                                }
                            }
                        }
                    },
                    onManage = { managingThreads = Chat.BotChat(bot) },
                    onOpen = navigator::open,
                )
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            RosterHeader(
                name = connection?.name,
                status = status,
                onSettings = { navigator.push(Destination.Settings) },
            )
            StatusBanner()

            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    scope.launch {
                        refreshing = true
                        // Session.refresh waits until the stream leaves connecting
                        // (or 10s), so the spinner means what it appears to mean.
                        session.refresh()
                        refreshing = false
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                // Unsearched, the empty state is about bots: channels are tiles
                // in the strip, not rows.
                val nothingToList =
                    if (query.isEmpty()) !RosterLayout.listsAnyBot(summaries) else rows.isEmpty()
                if (nothingToList && hits.isEmpty()) {
                    EmptyState(
                        title = stringResource(if (query.isEmpty()) R.string.mobile_roster_no_bots_yet else R.string.mobile_roster_nothing_matches),
                        description = if (query.isEmpty()) {
                            stringResource(R.string.mobile_roster_empty_description)
                        } else {
                            stringResource(R.string.mobile_roster_no_thread_matches, query)
                        },
                    )
                }

                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = BAR_CLEARANCE),
                ) {
                    if (RosterLayout.showsGroups(query)) {
                        if (attention.isNotEmpty()) {
                            item(key = "attention-label") {
                                SectionLabel(stringResource(R.string.mobile_roster_needs_attention), Modifier.padding(top = 2.dp, bottom = 4.dp))
                            }
                            items(attention, key = { "attention-${it.id}" }) { entry ->
                                AttentionRow(entry = entry, onOpen = {
                                    state.bots.firstOrNull { it.id == entry.botId }
                                        ?.let { bot -> Chat.BotChat(bot.forTask(entry.task.threadId) ?: bot) }
                                        ?.let(navigator::open)
                                })
                            }
                        }
                        state.unsectionedChief?.let { chief ->
                            summariesById[chief.id]?.let { summary ->
                                item(key = "chief-${chief.id}") {
                                    entry(summary, true)
                                }
                            }
                        }
                        val pinned = state.pinnedBots.mapNotNull { summariesById[it.id] }
                        if (pinned.isNotEmpty()) {
                            item(key = "pinned-label") {
                                SectionLabel(stringResource(R.string.mobile_roster_pinned), Modifier.padding(top = 2.dp, bottom = 4.dp))
                            }
                            itemsIndexed(pinned, key = { _, summary -> "pinned-${summary.id}" }) { index, summary ->
                                entry(summary, index == pinned.lastIndex)
                            }
                        }
                        item(key = "channels") {
                            GroupsStrip(
                                title = stringResource(R.string.mobile_groups_ae9629f4),
                                rooms = state.unsectionedChannels,
                                members = tiles,
                                onOpen = { navigator.open(Chat.RoomChat(it)) },
                                onCreate = {
                                    haptics.play(TactileAction.START_NEW_GROUP)
                                    showingNewGroup = true
                                },
                            )
                        }
                        if (state.botChats.isNotEmpty()) {
                            item(key = "bot-chats") {
                                GroupsStrip(
                                    title = stringResource(R.string.mobile_bot_threads_ec81acf2),
                                    rooms = state.botChats,
                                    members = tiles,
                                    onOpen = { navigator.open(Chat.RoomChat(it)) },
                                    onCreate = null,
                                )
                            }
                        }
                        val unsectioned = state.unsectionedBots.mapNotNull { summariesById[it.id] }
                        if (unsectioned.isNotEmpty()) {
                            item(key = "bots-label") {
                                SectionLabel(stringResource(R.string.mobile_bots_4ca88ea4), Modifier.padding(top = 18.dp, bottom = 4.dp))
                            }
                            itemsIndexed(unsectioned, key = { _, summary -> "bot-${summary.id}" }) { index, summary ->
                                entry(summary, index == unsectioned.lastIndex)
                            }
                        }
                        // Chiefs, then the section's channels, then its bots —
                        // the order of `rosterSections` in `ChatListView.swift`.
                        state.sidebarSections.forEach { section ->
                            item(key = "section-${section.id}") {
                                SectionLabel(section.name, Modifier.padding(top = 18.dp, bottom = 4.dp))
                            }
                            val sectionChiefs = section.chiefs.mapNotNull { summariesById[it.id] }
                            val sectionBots = section.bots.mapNotNull { summariesById[it.id] }
                            itemsIndexed(
                                sectionChiefs,
                                key = { _, summary -> "section-${section.id}-chief-${summary.id}" },
                            ) { index, summary ->
                                entry(
                                    summary,
                                    // A divider separates two rows. The strip is
                                    // not a row, and neither is the end of the
                                    // section.
                                    index == sectionChiefs.lastIndex &&
                                        (section.channels.isNotEmpty() || sectionBots.isEmpty()),
                                )
                            }
                            if (section.channels.isNotEmpty()) {
                                item(key = "section-${section.id}-channels") {
                                    GroupsStrip(
                                        title = stringResource(R.string.mobile_groups_ae9629f4),
                                        rooms = section.channels,
                                        members = tiles,
                                        onOpen = { navigator.open(Chat.RoomChat(it)) },
                                        onCreate = null,
                                    )
                                }
                            }
                            itemsIndexed(
                                sectionBots,
                                key = { _, summary -> "section-${section.id}-bot-${summary.id}" },
                            ) { index, summary ->
                                entry(summary, index == sectionBots.lastIndex)
                            }
                        }
                    }

                    if (query.isNotEmpty() && hits.isNotEmpty()) {
                        item(key = "search-header") {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(top = 10.dp, bottom = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SectionLabel(stringResource(R.string.mobile_roster_messages))
                                Spacer(Modifier.weight(1f))
                                if (searching) {
                                    CircularProgressIndicator(
                                        modifier = Modifier
                                            .padding(end = 20.dp)
                                            .size(14.dp),
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                        }
                        items(hits, key = { it.id }) { hit ->
                            SearchHitRow(
                                hit = hit,
                                onClick = {
                                    scope.launch {
                                        // Session.open switches task, sets the
                                        // active branch, loads the `around` page
                                        // and focuses the message — the chat
                                        // screen honours the focus when it opens.
                                        session.open(hit)?.let {
                                            haptics.play(TactileAction.OPEN_SEARCH_RESULT)
                                            navigator.open(it)
                                        }
                                    }
                                },
                            )
                        }
                        item(key = "chats-label") {
                            SectionLabel(stringResource(R.string.mobile_threads_bb12e8aa), Modifier.padding(top = 14.dp, bottom = 4.dp))
                        }
                    }

                    if (query.isNotEmpty()) {
                        itemsIndexed(rows, key = { _, summary -> summary.chat.threadId }) { index, summary ->
                            entry(summary, index == rows.lastIndex)
                        }
                    }
                }
            }
        }

        RosterBottomBar(
            updates = updates,
            bar = bar,
            onBar = { bar = it },
            onOpenUpdates = {
                haptics.play(TactileAction.OPEN_UPDATES)
                showingUpdates = true
            },
            onOpenSearch = {
                haptics.play(TactileAction.OPEN_SEARCH)
                bar = bar.openSearch()
            },
            onCreateBot = {
                if (!creatingBot) {
                    creatingBot = true
                    scope.launch {
                        try {
                            session.createBot()?.let {
                                haptics.play(TactileAction.CREATE_BOT_SUCCESS)
                                navigator.open(Chat.BotChat(it))
                            }
                        } finally {
                            creatingBot = false
                        }
                    }
                }
            },
            canCreateBot = !creatingBot,
            onCreateSection = {
                haptics.play(TactileAction.START_NEW_SECTION)
                showingNewSection = true
            },
            // The same rule the sheet picks from: two copies of "which bots can
            // be sectioned" could disagree about a hidden one.
            canCreateSection = remember(state) { SectionRules.selectable(state).isNotEmpty() },
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    if (showingUpdates) {
        UpdatesSheet(
            onOpen = { chat ->
                showingUpdates = false
                navigator.open(chat)
            },
            onDismiss = { showingUpdates = false },
        )
    }

    if (showingNewGroup) {
        NewGroupSheet(
            onCreated = { room ->
                showingNewGroup = false
                navigator.open(Chat.RoomChat(room))
            },
            onDismiss = { showingNewGroup = false },
        )
    }

    if (showingNewSection) {
        NewSectionSheet(onDismiss = { showingNewSection = false })
    }

    managingThreads?.let { chat ->
        TaskSheet(
            chat = chat,
            onDismiss = { managingThreads = null },
            onSelectTask = { target ->
                managingThreads = null
                session.state.value.chat(target)?.let(navigator::open)
            },
        )
    }
}

/** Room for the floating bar, so the last row can scroll clear of it. */
private val BAR_CLEARANCE = 96.dp

/** Two flags and a string: enough to survive a rotation with the search still up. */
private val RosterBarSaver = listSaver<RosterBar, Any>(
    save = { listOf(it.searchOpen, it.query) },
    restore = { RosterBar(searchOpen = it[0] as Boolean, query = it[1] as String) },
)

private val StringSetSaver = listSaver<Set<String>, String>(
    save = { it.toList() },
    restore = { it.toSet() },
)

/**
 * You (the computer you are paired with) on the left, settings on the right, and
 * where you are in between. Search and both creations are not here any more —
 * they live in the bar at the bottom and at the end of the groups strip.
 */
@Composable
private fun RosterHeader(name: String?, status: Session.Status, onSettings: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TouchTarget(onClick = onSettings, size = 44.dp, contentDescription = stringResource(R.string.mobile_settings_c7f73bb5)) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .chromeCapsule(),
                contentAlignment = Alignment.Center,
            ) {
                ProfileAvatar(name = name ?: "You", size = 30.dp)
            }
        }

        Column(
            modifier = Modifier.weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(stringResource(R.string.mobile_threads_bb12e8aa), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Text(
                text = localizedRosterHeaderSubtitle(name, status),
                fontSize = 13.sp,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        ChromeButton(
            icon = Icons.Filled.Settings,
            contentDescription = stringResource(R.string.mobile_settings_c7f73bb5),
            onClick = onSettings,
        )
    }
}

/** A heading over a stretch of the list. */
@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = RosterLayout.sectionLabel(text),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.4.sp,
        color = secondaryTint,
        modifier = modifier.padding(horizontal = 20.dp),
    )
}

/**
 * Every group, across the top, with the tile that makes one at the end — the
 * place iOS puts it, and the reason the header no longer carries a second plus.
 */
@Composable
private fun GroupsStrip(
    title: String,
    rooms: List<Room>,
    members: Map<String, List<Bot>>,
    onOpen: (Room) -> Unit,
    onCreate: (() -> Unit)?,
) {
    Column(
        modifier = Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionLabel(title)
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 16.dp),
        ) {
            items(rooms, key = { it.id }) { room ->
                GroupTile(
                    room = room,
                    members = members[room.id].orEmpty(),
                    onClick = { onOpen(room) },
                )
            }
            if (onCreate != null) {
                item(key = "new-group") { NewGroupTile(onClick = onCreate) }
            }
        }
    }
}

/**
 * A room as a round tile: the first two members' mascots stacked, its name
 * beneath.
 */
@Composable
private fun GroupTile(room: Room, members: List<Bot>, onClick: () -> Unit) {
    GroupTileFrame(
        label = room.name,
        labelColor = MaterialTheme.colorScheme.onSurface,
        onClick = onClick,
    ) {
        Box(
            Modifier
                .size(64.dp)
                .background(secondaryTint.copy(alpha = 0.14f), CircleShape),
        )
        members.getOrNull(0)?.let {
            BotAvatar(
                bot = it,
                size = 34.dp,
                state = MausState.HAPPY,
                animated = false,
                modifier = Modifier.offset(x = (-9).dp, y = (-6).dp),
            )
        }
        members.getOrNull(1)?.let {
            Box(
                modifier = Modifier
                    .offset(x = 11.dp, y = 9.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp),
            ) {
                BotAvatar(bot = it, size = 30.dp, state = MausState.HAPPY, animated = false)
            }
        }
        if (room.unread) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(3.dp)
                    .size(14.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .background(BubbleColor.mine, CircleShape),
            )
        }
    }
}

/** The empty tile at the end of the strip: this is where a group is made. */
@Composable
private fun NewGroupTile(onClick: () -> Unit) {
    val outline = secondaryTint.copy(alpha = 0.6f)
    GroupTileFrame(label = stringResource(R.string.mobile_new_group_f9850c0b), labelColor = secondaryTint, onClick = onClick) {
        Spacer(
            modifier = Modifier
                .size(64.dp)
                .drawWithCache {
                    val width = 1.5.dp.toPx()
                    val dash = 4.dp.toPx()
                    val style = Stroke(
                        width = width,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f),
                    )
                    val radius = size.minDimension / 2f - width / 2f
                    onDrawBehind { drawCircle(color = outline, radius = radius, style = style) }
                },
        )
        Icon(
            imageVector = Icons.Filled.Add,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(24.dp),
        )
    }
}

@Composable
private fun GroupTileFrame(
    label: String,
    labelColor: Color,
    onClick: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .width(76.dp)
            .clip(RoundedCornerShape(18.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(modifier = Modifier.size(64.dp), contentAlignment = Alignment.Center, content = content)
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = labelColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ChatRow(
    summary: ChatSummary,
    face: MausState,
    waiting: Boolean,
    last: Boolean,
    onClick: () -> Unit,
) {
    val chat = summary.chat
    val now = remember(summary.lastActivity) { System.currentTimeMillis() }
    val accent = remember(chat.color) { Color(MausPalette.argb(chat.color)) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // The unread dot, in the bot's own colour, at the very edge.
        Box(
            modifier = Modifier
                .width(22.dp)
                .align(Alignment.CenterVertically),
            contentAlignment = Alignment.Center,
        ) {
            if (chat.unread && !chat.busy) {
                Box(Modifier.size(10.dp).background(accent, CircleShape))
            }
        }

        Row(
            modifier = Modifier
                .weight(1f)
                .padding(end = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.Top,
        ) {
            ChatAvatar(
                chat = chat,
                size = 52.dp,
                state = face,
                modifier = Modifier.padding(top = 12.dp),
            )

            Box(modifier = Modifier.weight(1f)) {
                Column(
                    modifier = Modifier.padding(vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(
                            modifier = Modifier.weight(1f),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = chat.name,
                                fontSize = 17.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            // The bot's job, the way the desktop shows it.
                            if (chat.subtitle.isNotEmpty()) {
                                Text(
                                    text = chat.subtitle,
                                    fontSize = 13.sp,
                                    color = secondaryTint,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier
                                        .weight(1f, fill = false)
                                        .background(
                                            secondaryTint.copy(alpha = 0.15f),
                                            CircleShape,
                                        )
                                        .padding(horizontal = 8.dp, vertical = 3.dp),
                                )
                            }
                        }
                        Text(
                            text = RelativeStamp.list(
                                summary.lastActivity,
                                now,
                                locale = Locale.getDefault(),
                            ),
                            fontSize = 15.sp,
                            color = secondaryTint,
                            maxLines = 1,
                        )
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = secondaryTint.copy(alpha = 0.5f),
                            modifier = Modifier.size(16.dp),
                        )
                    }

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        // One line for every bot, so the rows keep one rhythm.
                        Text(
                            text = summary.preview.ifEmpty { " " },
                            fontSize = 15.sp,
                            color = secondaryTint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (chat.busy) {
                            CircularProgressIndicator(
                                modifier = Modifier
                                    .padding(top = 3.dp)
                                    .size(12.dp),
                                strokeWidth = 2.dp,
                            )
                        }
                    }

                    if (waiting) {
                        Row(
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .background(accent, CircleShape)
                                .padding(horizontal = 9.dp, vertical = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Notifications,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(12.dp),
                            )
                            Text(
                                text = stringResource(R.string.mobile_waiting_on_you_edab5b72),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = Color.White,
                            )
                        }
                    }
                }

                if (!last) HorizontalDivider(modifier = Modifier.align(Alignment.BottomStart))
            }
        }
    }
}

/**
 * The bar over the bottom of the list: Updates beside search and new bot, or —
 * once search is open — the field beside Cancel.
 *
 * Cancel is what closes it, and it takes the query with it: that is what puts the
 * groups strip back and returns the list to bots only.
 */
@Composable
private fun RosterBottomBar(
    updates: List<ChatUpdate>,
    bar: RosterBar,
    onBar: (RosterBar) -> Unit,
    onOpenUpdates: () -> Unit,
    onOpenSearch: () -> Unit,
    onCreateBot: () -> Unit,
    canCreateBot: Boolean,
    onCreateSection: () -> Unit,
    canCreateSection: Boolean,
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    LaunchedEffect(bar.searchOpen) {
        if (bar.searchOpen) focus.requestFocus() else focusManager.clearFocus()
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bar.searchOpen) {
            Row(
                modifier = Modifier
                    .weight(1f)
                    .chromeCapsule()
                    .height(BAR_HEIGHT)
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = Icons.Filled.Search,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(18.dp),
                )
                Box(modifier = Modifier.weight(1f)) {
                    if (bar.query.isEmpty()) {
                        Text(stringResource(R.string.mobile_search_threads_006299d3), fontSize = 17.sp, color = secondaryTint)
                    }
                    BasicTextField(
                        value = bar.query,
                        onValueChange = { onBar(bar.typed(it)) },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 17.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus),
                    )
                }
                if (bar.query.isNotEmpty()) {
                    TouchTarget(onClick = { onBar(bar.clearQuery()) }, size = 24.dp) {
                        Icon(
                            imageVector = Icons.Filled.Close,
                            contentDescription = stringResource(R.string.mobile_clear_search_67300d0f),
                            tint = secondaryTint,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }

            Box(
                modifier = Modifier
                    .chromeCapsule()
                    .clip(CircleShape)
                    .height(BAR_HEIGHT)
                    .clickable(role = Role.Button, onClick = { onBar(bar.cancelSearch()) })
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(stringResource(R.string.mobile_cancel_77dfd213), fontSize = 17.sp)
            }
        } else {
            UpdatesBar(
                updates = updates,
                onOpen = onOpenUpdates,
                modifier = Modifier.weight(1f),
            )
            ChromeButton(
                icon = Icons.Filled.Search,
                contentDescription = stringResource(R.string.mobile_search_bce06414),
                onClick = onOpenSearch,
                size = MIN_TOUCH_TARGET,
            )
            ChromeButton(
                icon = Icons.Filled.Add,
                contentDescription = stringResource(R.string.mobile_organize_bots_into_a_section_9293c5af),
                onClick = onCreateSection,
                enabled = canCreateSection,
                size = MIN_TOUCH_TARGET,
            )
            // Writing something new, which is what making a bot is. The empty
            // tile in the groups strip wears a plus because gathering existing
            // bots into a room is the other thing — two glyphs, two actions.
            ChromeButton(
                icon = Icons.Filled.Create,
                contentDescription = stringResource(R.string.mobile_new_bot_66d3c052),
                onClick = onCreateBot,
                enabled = canCreateBot,
                size = MIN_TOUCH_TARGET,
            )
        }
    }
}

private val BAR_HEIGHT = 52.dp

@Composable
private fun SearchHitRow(hit: SearchHit, onClick: () -> Unit) {
    val now = remember(hit.id) { System.currentTimeMillis() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // Who said it. Two hits with the same words are otherwise identical.
        Icon(
            // A person for what you said, the Maus mark for what a bot said —
            // iOS makes the same split with person.fill and a speech bubble.
            painter = if (SearchHitRole.isFromUser(hit.role)) {
                rememberVectorPainter(Icons.Filled.Person)
            } else {
                painterResource(R.drawable.ic_maus_mark)
            },
            contentDescription = SearchHitRole.contentDescription(hit.role, hit.name),
            tint = secondaryTint,
            modifier = Modifier
                .size(26.dp)
                .background(secondaryTint.copy(alpha = 0.13f), CircleShape)
                .padding(5.dp),
        )

        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(hit.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                hit.task?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, fontSize = 12.sp, color = secondaryTint)
                }
                Spacer(Modifier.weight(1f))
                Text(
                    text = RelativeStamp.list(hit.at, now, locale = Locale.getDefault()),
                    fontSize = 12.sp,
                    color = secondaryTint,
                )
            }
            Text(
                text = hit.snippet,
                fontSize = 14.sp,
                color = secondaryTint,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Connection state, shown only when it is not "fine". */
@Composable
fun StatusBanner() {
    val session = LocalCompanion.current.session
    val status by session.status.collectAsState()
    val banner: Pair<String, Color>? = when (val current = status) {
        Session.Status.Live, Session.Status.Unpaired -> null
        Session.Status.Connecting -> stringResource(R.string.mobile_connecting_fd3e7969) to secondaryTint
        is Session.Status.Offline -> current.message to Color(MausPalette.argb("orange"))
        Session.Status.Unauthorized ->
            stringResource(R.string.mobile_phone_unpaired_banner) to MaterialTheme.colorScheme.error
    }
    val (text, tint) = banner ?: return
    Text(
        text = text,
        fontSize = 13.sp,
        color = tint,
        modifier = Modifier
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(secondaryTint.copy(alpha = 0.12f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

@Composable
private fun localizedRosterHeaderSubtitle(name: String?, status: Session.Status): String {
    if (status == Session.Status.Unpaired) {
        return stringResource(R.string.mobile_settings_not_paired_status)
    }
    val computer = name ?: stringResource(R.string.mobile_settings_not_paired_status)
    return when (status) {
        Session.Status.Live -> stringResource(R.string.mobile_roster_header_connected, computer)
        Session.Status.Connecting -> stringResource(R.string.mobile_roster_header_connecting, computer)
        is Session.Status.Offline -> stringResource(R.string.mobile_roster_header_offline, computer)
        Session.Status.Unauthorized -> stringResource(R.string.mobile_roster_header_unpaired, computer)
        Session.Status.Unpaired -> stringResource(R.string.mobile_settings_not_paired_status)
    }
}
