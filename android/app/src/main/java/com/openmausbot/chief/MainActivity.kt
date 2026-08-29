package com.openmausbot.chief

import android.Manifest
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.fragment.app.FragmentActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PauseCircle
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.DocumentScanner
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SettingsSuggest
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.openmausbot.chief.data.Bot
import com.openmausbot.chief.data.BiometricGate
import com.openmausbot.chief.data.ApprovalSecurity
import com.openmausbot.chief.data.Message
import com.openmausbot.chief.data.Routine
import com.openmausbot.chief.data.RoutineRun
import com.openmausbot.chief.data.NotificationMirrorSettings
import com.openmausbot.chief.data.WorkerBatch
import com.openmausbot.chief.data.WorkerBatchJob
import com.openmausbot.chief.ui.theme.CentipedeAcid
import com.openmausbot.chief.ui.theme.CentipedeInk
import com.openmausbot.chief.ui.theme.CentipedeSuccess
import com.openmausbot.chief.ui.theme.AgentCentipedeTheme
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<MausViewModel>()
    private var pendingBotId: String? = null
    private var pendingThreadId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        setContent {
            val state by viewModel.state.collectAsStateWithLifecycle()
            val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
            LaunchedEffect(state.session != null) {
                if (state.session != null && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
            LaunchedEffect(state.fleet.bots, pendingBotId, pendingThreadId) {
                val botId = pendingBotId
                if (botId != null && state.fleet.bots.any { it.id == botId }) {
                    viewModel.selectBot(botId)
                    pendingBotId = null
                    pendingThreadId = null
                }
            }
            AgentCentipedeTheme {
                MausRoot(
                    state = state,
                    viewModel = viewModel,
                    scan = {
                        val options = GmsBarcodeScannerOptions.Builder()
                            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                            .enableAutoZoom()
                            .build()
                        GmsBarcodeScanning.getClient(this, options).startScan()
                            .addOnSuccessListener { code -> code.rawValue?.let(viewModel::acceptInvite) }
                    },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        // Notification actions use explicit extras so a tap can land directly
        // in the relevant conversation even when the activity is already open.
        pendingBotId = notificationBotId(intent)
        pendingThreadId = notificationThreadId(intent)
        val data = intent.data ?: return
        // Let only the exact pairing deep link reach the parser. Besides
        // avoiding accidental handling of another openmausbot command, this
        // keeps browser handoffs with a path, authority, or fragment from
        // becoming a confusing pairing error.
        if (!"openmausbot".equals(data.scheme, ignoreCase = true)
            || !"pair".equals(data.host, ignoreCase = true)
            || !data.path.isNullOrEmpty()
            || data.fragment != null
        ) return
        viewModel.acceptInvite(data.toString())
    }
}

internal fun notificationBotId(intent: Intent): String? = intent.getStringExtra("botId")
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

internal fun notificationThreadId(intent: Intent): String? = intent.getStringExtra("threadId")
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

@Composable
private fun MausRoot(state: MausUiState, viewModel: MausViewModel, scan: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.error) {
        state.error?.let { snackbar.showSnackbar(it); viewModel.dismissError() }
    }
    Box(Modifier.fillMaxSize()) {
        AnimatedContent(
            targetState = state.session != null,
            transitionSpec = {
                (fadeIn(tween(220)) + slideInHorizontally(tween(240)) { width -> width / 12 }) togetherWith
                    (fadeOut(tween(150)) + slideOutHorizontally(tween(180)) { width -> -width / 16 })
            },
            label = "session",
        ) { paired ->
            if (paired) Home(state, viewModel) else PairingScreen(state, viewModel, scan)
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp))
    }
}

@Composable
private fun PairingScreen(state: MausUiState, viewModel: MausViewModel, scan: () -> Unit) {
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Box(
            Modifier.size(340.dp).align(Alignment.TopEnd).background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
        )
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 48.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                CentipedeMark(76)
                Spacer(Modifier.height(24.dp))
                Text("Your work crew, in your pocket.", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Black)
                Spacer(Modifier.height(10.dp))
                Text(
                    "Talk to your agents, keep work moving, and jump into an agent’s screen when you need to. The heavy lifting stays on your computer.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Button(onClick = scan, modifier = Modifier.fillMaxWidth().height(56.dp), shape = RoundedCornerShape(18.dp)) {
                    Icon(Icons.Default.QrCodeScanner, null)
                    Spacer(Modifier.width(10.dp))
                    Text("Scan desktop QR")
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    HorizontalDivider(Modifier.weight(1f))
                    Text("  or connect manually  ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    HorizontalDivider(Modifier.weight(1f))
                }
            }
            item {
                Card(shape = RoundedCornerShape(24.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        OutlinedTextField(
                            value = address,
                            onValueChange = { address = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Computer address") },
                            placeholder = { Text("192.168.1.12:8810") },
                            singleLine = true,
                        )
                        OutlinedTextField(
                            value = code,
                            onValueChange = { code = it.filter(Char::isDigit).take(6) },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("Six-digit code") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
                            keyboardActions = KeyboardActions(onDone = { viewModel.manualInvite(address, code) }),
                            singleLine = true,
                        )
                        OutlinedButton(
                            onClick = { viewModel.manualInvite(address, code) },
                            enabled = address.isNotBlank() && code.length == 6,
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("Review connection") }
                    }
                }
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.CheckCircle, null, tint = CentipedeSuccess, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Your computer stays in charge. Your phone is the clever sidekick.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    state.pendingInvite?.let { invite ->
        val secure = invite.connection.origin.startsWith("https://") || invite.connection.origin.contains(".ts.net")
        AlertDialog(
            onDismissRequest = { if (!state.pairing) viewModel.cancelInvite() },
            icon = { Icon(if (secure) Icons.Default.Wifi else Icons.Default.WifiOff, null) },
            title = { Text("Connect to ${invite.connection.name}?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(invite.connection.origin)
                    Text(
                        if (secure) "Protected route. The one-time credential is exchanged for this phone’s private device key."
                        else "Trusted local connection. Use this only on a Wi‑Fi network you trust.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                Button(onClick = { viewModel.pair("${Build.MODEL} Android") }, enabled = !state.pairing) {
                    if (state.pairing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Connect")
                }
            },
            dismissButton = { TextButton(onClick = viewModel::cancelInvite, enabled = !state.pairing) { Text("Cancel") } },
        )
    }
}

private enum class Tab { Today, Chats, Work, Settings }

/** Mobile does not require a coordinator or a specially named agent. When a
 * screen needs a representative agent, use ordinary user-configurable state
 * (pinned, unread, then name) and gracefully fall back to the generic label. */
private fun preferredAgent(bots: List<Bot>): Bot? = bots
    .filter { it.hidden != true }
    .sortedWith(
        compareByDescending<Bot> { it.pinned == true }
            .thenByDescending { it.unread }
            .thenByDescending { it.busy == true }
            .thenBy { it.name.lowercase() },
    )
    .firstOrNull()

@Composable
private fun Home(state: MausUiState, viewModel: MausViewModel) {
    val selected = state.fleet.bots.find { it.id == state.selectedBotId }
    if (state.computerBotId != null) {
        ComputerScreen(state, viewModel)
        return
    }
    if (selected != null) {
        ChatScreen(selected, viewModel)
        return
    }
    var tab by rememberSaveable { mutableStateOf(Tab.Today) }
    Scaffold(
        topBar = { HomeTopBar(preferredAgent(state.fleet.bots)?.name ?: "Your agents", state.live, state.loading, viewModel::refresh) },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(selected = tab == Tab.Today, onClick = { tab = Tab.Today }, icon = { Icon(Icons.Default.Home, null) }, label = { Text("Today") })
                NavigationBarItem(selected = tab == Tab.Chats, onClick = { tab = Tab.Chats }, icon = { Icon(Icons.Default.ChatBubble, null) }, label = { Text("Chats") })
                NavigationBarItem(selected = tab == Tab.Work, onClick = { tab = Tab.Work }, icon = { Icon(Icons.Default.Bolt, null) }, label = { Text("Work") })
                NavigationBarItem(selected = tab == Tab.Settings, onClick = { tab = Tab.Settings }, icon = { Icon(Icons.Default.Settings, null) }, label = { Text("Settings") })
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            AnimatedContent(
                targetState = tab,
                modifier = Modifier.fillMaxSize(),
                transitionSpec = {
                    val direction = if (targetState.ordinal > initialState.ordinal) 1 else -1
                    (fadeIn(tween(150)) + slideInHorizontally(tween(190)) { width -> direction * width / 14 }) togetherWith
                        (fadeOut(tween(110)) + slideOutHorizontally(tween(150)) { width -> -direction * width / 18 })
                },
                label = "home-tab",
            ) { activeTab ->
                when (activeTab) {
                    Tab.Today -> TodayTab(state, viewModel)
                    Tab.Chats -> ChatsTab(state, viewModel)
                    Tab.Work -> WorkTab(state, viewModel)
                    Tab.Settings -> SettingsTab(state, viewModel)
                }
            }
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeTopBar(agentName: String, live: Boolean, loading: Boolean, refresh: () -> Unit) {
    TopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(CentipedeInk),
                    contentAlignment = Alignment.Center,
                ) { CentipedeMark(25) }
                Spacer(Modifier.width(12.dp))
                Column {
                    Text("Agent Centipede", fontWeight = FontWeight.Black, style = MaterialTheme.typography.titleLarge)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LivePulseDot(active = live, modifier = Modifier.size(7.dp))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            if (live) "$agentName · all systems go" else "$agentName · finding the signal…",
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        },
        actions = {
            IconButton(onClick = refresh, enabled = !loading) {
                Icon(Icons.Default.Refresh, "Refresh agents")
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
    )
}

/** A calm launchpad: one glance tells the user what is moving and what needs a call. */
@Composable
private fun TodayTab(state: MausUiState, viewModel: MausViewModel) {
    val bots = state.fleet.bots.filter { it.hidden != true }
    val working = bots.filter { it.busy == true }
    val approvals = bots.sumOf { bot -> visibleChatMessages(bot.messages).count { it.card?.pending == true } }
    val unread = bots.count { it.unread }
    val greeting = when {
        !state.live -> "Your agents are looking for the computer."
        approvals > 0 -> "A few calls are waiting on you."
        working.isNotEmpty() -> "Your agents are moving."
        else -> "Good to see you. What are we shipping?"
    }
    LazyColumn(
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("Good ${timeOfDay()}.", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                Text(greeting, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(26.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(42.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface), contentAlignment = Alignment.Center) {
                            Icon(Icons.Default.AutoAwesome, "", tint = MaterialTheme.colorScheme.primary)
                        }
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text("What’s moving", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                            Text(
                                if (state.live) "Your agents are connected and ready to work." else "We’ll keep trying. Your computer may be asleep.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        LivePulseDot(active = state.live, modifier = Modifier.size(10.dp))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PulseStat("${working.size}", "in motion", Modifier.weight(1f))
                        PulseStat("$approvals", "need you", Modifier.weight(1f))
                        PulseStat("$unread", "unread", Modifier.weight(1f))
                    }
                }
            }
        }
        if (approvals > 0) item {
            SectionHeader("Needs your call", "Tap a card to answer")
            bots.flatMap { bot -> visibleChatMessages(bot.messages).filter { it.card?.pending == true }.map { bot to it } }
                .take(3)
                .forEach { (bot, message) ->
                    ApprovalPreview(bot, message, onOpen = { viewModel.selectBot(bot.id) })
                }
        }
        item { SectionHeader("Your crew", if (bots.isEmpty()) "Bring in your first agent from the desktop." else "Tap an agent to jump in") }
        if (bots.isEmpty() && !state.loading) item { EmptyState("No agents yet", "Create an agent or import a team from your computer.") }
        items(bots.take(6), key = { "today-${it.id}" }) { bot ->
            Box(Modifier.animateItem()) {
                CrewRow(bot, onClick = { viewModel.selectBot(bot.id) })
            }
        }
        if (state.routines.isNotEmpty()) item {
            SectionHeader("Coming up", "Your routines, without the spreadsheet energy")
            state.routines.filter { it.enabled }.take(2).forEach { routine ->
                Surface(
                    Modifier.fillMaxWidth().clickable { viewModel.runRoutine(routine) },
                    shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surface,
                    tonalElevation = 1.dp,
                ) {
                    Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Schedule, "", tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(routine.name, fontWeight = FontWeight.SemiBold)
                            Text(scheduleLabel(routine), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Text("Run", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, detail: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PulseStat(value: String, label: String, modifier: Modifier = Modifier) {
    Surface(modifier, shape = RoundedCornerShape(15.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = .72f)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun CrewRow(bot: Bot, onClick: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = if (bot.unread) 3.dp else 1.dp,
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            BotAvatar(bot, 46)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(bot.name, fontWeight = FontWeight.Bold)
                    if (bot.busy == true) {
                        Spacer(Modifier.width(7.dp))
                        LivePulseDot(active = true, modifier = Modifier.size(6.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("moving", style = MaterialTheme.typography.labelSmall, color = CentipedeSuccess, fontWeight = FontWeight.Bold)
                    }
                }
                Text(bot.messages.lastOrNull()?.text ?: bot.description.ifBlank { "Ready when you are." }, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (bot.unread) Box(Modifier.size(9.dp).background(CentipedeAcid, CircleShape))
        }
    }
}

@Composable
private fun ApprovalPreview(bot: Bot, message: Message, onOpen: () -> Unit) {
    val card = message.card ?: return
    Surface(
        Modifier.fillMaxWidth().clickable(onClick = onOpen),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            BotAvatar(bot, 42)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(card.title.ifBlank { "A decision is waiting" }, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(card.subtitle.ifBlank { "${bot.name} needs your steer." }, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.Default.Bolt, "Open approval", tint = CentipedeAcid)
        }
    }
}

@Composable
private fun ChatsTab(state: MausUiState, viewModel: MausViewModel) {
    val bots = state.fleet.bots.filter { it.hidden != true }.sortedWith(
        compareByDescending<Bot> { it.pinned == true }
            .thenByDescending { it.unread }
            .thenByDescending { it.busy == true }
            .thenBy { it.name },
    )
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Text("Your crew", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
            Text("Pinned agents stay first. Moving agents and fresh work float to the top.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(6.dp))
        }
        items(bots, key = { it.id }) { bot ->
            Card(
                modifier = Modifier.animateItem().fillMaxWidth().clickable { viewModel.selectBot(bot.id) },
                shape = RoundedCornerShape(22.dp),
                colors = CardDefaults.cardColors(containerColor = if (bot.unread) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface),
            ) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    BotAvatar(bot, 48)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(bot.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                            if (bot.busy == true) {
                                Spacer(Modifier.width(8.dp))
                                AssistChip(onClick = {}, label = { Text("moving") })
                            }
                        }
                        val preview = bot.messages.lastOrNull()?.text ?: bot.description
                        Text(preview.ifBlank { "Ready" }, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (bot.unread) Box(Modifier.size(10.dp).background(CentipedeAcid, CircleShape))
                }
            }
        }
        if (bots.isEmpty() && !state.loading) item { EmptyState("No agents yet", "Create an agent or import a team on the desktop.") }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(bot: Bot, viewModel: MausViewModel) {
    BackHandler { viewModel.selectBot(null) }
    var composer by rememberSaveable(bot.id) { mutableStateOf("") }
    val visibleMessages = visibleChatMessages(bot.messages)
    val messageListState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var previousMessageCount by remember(bot.id) { mutableIntStateOf(0) }
    var followNextMessage by remember(bot.id) { mutableStateOf(false) }
    val isNearLatestMessage by remember {
        derivedStateOf {
            val layout = messageListState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull()?.index
            lastVisible == null || lastVisible >= layout.totalItemsCount - 2
        }
    }
    LaunchedEffect(bot.id, visibleMessages.size) {
        val currentMessageCount = visibleMessages.size
        if (
            shouldFollowLatestMessage(
                previousCount = previousMessageCount,
                currentCount = currentMessageCount,
                isNearBottom = isNearLatestMessage,
                requestedByUser = followNextMessage,
            )
        ) {
            val target = currentMessageCount - 1
            if (previousMessageCount == 0) messageListState.scrollToItem(target)
            else messageListState.animateScrollToItem(target)
        }
        previousMessageCount = currentMessageCount
        if (currentMessageCount > 0) followNextMessage = false
    }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = { viewModel.selectBot(null) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        BotAvatar(bot, 38)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(bot.name, fontWeight = FontWeight.Bold)
                        Text(if (bot.busy == true) "moving" else bot.title.ifBlank { "Ready when you are" }, style = MaterialTheme.typography.labelSmall, color = if (bot.busy == true) CentipedeSuccess else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    if (bot.computer != null) IconButton(onClick = { viewModel.openComputer(bot.id) }) { Icon(Icons.Default.Computer, "View computer") }
                    if (bot.busy == true) IconButton(onClick = { viewModel.interrupt(bot.id) }) { Icon(Icons.Default.StopCircle, "Stop") }
                },
            )
        },
        bottomBar = {
            Surface(tonalElevation = 4.dp) {
                Row(
                    // Android 15+ already resizes this activity to the visible IME
                    // frame. Adding imePadding here subtracts the keyboard height a
                    // second time and leaves a keyboard-sized blank band.
                    Modifier.fillMaxWidth().padding(12.dp).navigationBarsPadding(),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    OutlinedTextField(
                        value = composer,
                        onValueChange = { composer = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("Message ${bot.name}") },
                        maxLines = 5,
                        shape = RoundedCornerShape(22.dp),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = {
                            if (composer.isNotBlank()) {
                                followNextMessage = true
                                viewModel.send(bot.id, composer)
                                composer = ""
                            }
                        }),
                    )
                    Spacer(Modifier.width(8.dp))
                    FilledIconButton(onClick = { followNextMessage = true; viewModel.send(bot.id, composer); composer = "" }, enabled = composer.isNotBlank(), modifier = Modifier.size(52.dp)) {
                        Icon(Icons.AutoMirrored.Filled.Send, "Send")
                    }
                }
            }
        },
        floatingActionButton = {
            AnimatedVisibility(
                visible = shouldShowJumpToLatest(visibleMessages.size, isNearLatestMessage),
                enter = fadeIn(tween(140)) + scaleIn(tween(180), initialScale = .9f),
                exit = fadeOut(tween(100)) + scaleOut(tween(120), targetScale = .9f),
            ) {
                SmallFloatingActionButton(
                    onClick = {
                        val target = visibleMessages.lastIndex
                        if (target >= 0) coroutineScope.launch { messageListState.animateScrollToItem(target) }
                    },
                ) { Icon(Icons.Default.KeyboardArrowDown, "Jump to latest message") }
            }
        },
    ) { padding ->
        LazyColumn(
            state = messageListState,
            modifier = Modifier.padding(padding).fillMaxSize(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(visibleMessages, key = { it.id }) { message ->
                Box(Modifier.animateItem()) { MessageBubble(bot, message, viewModel) }
            }
            if (visibleMessages.isEmpty()) item {
                Column(Modifier.fillMaxWidth().padding(top = 36.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Start a thread with ${bot.name}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
                    Text(bot.description.ifBlank { "Ask for a plan, a draft, or a little help getting unstuck." }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("Give me the quick version", "What’s moving?", "Help me think").forEach { starter ->
                            AssistChip(onClick = { followNextMessage = true; viewModel.send(bot.id, starter) }, label = { Text(starter) })
                        }
                    }
                }
            }
            item {
                AnimatedVisibility(
                    visible = bot.busy == true,
                    enter = fadeIn(tween(160)) + expandVertically(tween(190)),
                    exit = fadeOut(tween(110)) + shrinkVertically(tween(150)),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("${bot.name} is moving…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/**
 * The desktop timeline gives activity/tool events their own compact renderer.
 * Android does not expose that internal payload, so rendering those wire events
 * produced empty bubbles. Only messages with content this screen can display
 * belong in the mobile timeline.
 */
internal fun visibleChatMessages(messages: List<Message>): List<Message> = messages.mapNotNull { message ->
    if (message.kind == "activity") {
        if (message.workerBatch != null) return@mapNotNull message
        val tool = message.tool ?: return@mapNotNull null
        if (tool.ok != false) return@mapNotNull null
        val reason = tool.name.removePrefix("error:").trim()
        val text = if (reason.equals("Authentication required", ignoreCase = true)) {
            "This agent needs its model signed in on your computer. Open Agent Centipede, reconnect the model, then retry."
        } else {
            val detail = reason.ifBlank { "its setup needs attention" }
            "This agent stopped because $detail. Open Agent Centipede on your computer, fix the connection, then retry."
        }
        return@mapNotNull message.copy(kind = "text", text = text)
    }
    val hasText = !message.text.isNullOrBlank()
    val hasVisibleCard = message.card?.let { card ->
        card.title.isNotBlank() ||
            card.subtitle.isNotBlank() ||
            card.answered?.isNotBlank() == true ||
            (card.pending && card.options.any(String::isNotBlank))
    } == true
    message.takeIf { hasText || hasVisibleCard }
}

internal fun shouldFollowLatestMessage(
    previousCount: Int,
    currentCount: Int,
    isNearBottom: Boolean,
    requestedByUser: Boolean = false,
): Boolean = currentCount > 0 && (
    previousCount == 0 || (currentCount > previousCount && (isNearBottom || requestedByUser))
)

internal fun shouldShowJumpToLatest(messageCount: Int, isNearBottom: Boolean): Boolean =
    messageCount > 0 && !isNearBottom

@Composable
private fun MessageBubble(bot: Bot, message: Message, viewModel: MausViewModel) {
    message.workerBatch?.let { batch ->
        WorkerBatchBubble(batch)
        return
    }
    val yours = message.role == "user"
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val coroutineScope = rememberCoroutineScope()
    val copyText = copyableMessageText(message)
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (yours) Alignment.End else Alignment.Start) {
        Surface(
            color = if (yours) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (yours) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
            shape = RoundedCornerShape(20.dp),
            modifier = Modifier.fillMaxWidth(if (message.card != null) 0.92f else 0.84f),
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                message.text?.takeIf { it.isNotBlank() }?.let { text ->
                    SelectionContainer { Text(text, style = MaterialTheme.typography.bodyMedium) }
                }
                message.card?.let { card ->
                    if (card.pending) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Bolt, "", Modifier.size(16.dp), tint = CentipedeAcid)
                            Spacer(Modifier.width(5.dp))
                            Text("Your call", style = MaterialTheme.typography.labelMedium, color = CentipedeAcid, fontWeight = FontWeight.Bold)
                        }
                    }
                    SelectionContainer { Text(card.title, fontWeight = FontWeight.Bold) }
                    if (card.subtitle.isNotBlank()) SelectionContainer { Text(card.subtitle) }
                    if (card.pending) card.options.forEach { choice ->
                        val requiresAuth = ApprovalSecurity.requiresBiometric(card, choice)
                        OutlinedButton(
                            onClick = {
                                val activity = context as? FragmentActivity
                                if (!requiresAuth) {
                                    viewModel.answer(bot, message, choice)
                                } else if (activity == null || !BiometricGate.canAuthenticate(activity)) {
                                    viewModel.showError("Set up a screen lock or strong biometrics before approving this action. Deny remains available immediately.")
                                } else {
                                    BiometricGate.authenticate(activity) { verified ->
                                        if (verified) viewModel.answerAfterAuthentication(bot, message, choice)
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(choice) }
                    } else card.answered?.let { answer ->
                        SelectionContainer { Text("Answered: $answer", fontWeight = FontWeight.SemiBold) }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(formatTime(message.at), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
            if (copyText.isNotBlank()) {
                IconButton(
                    onClick = {
                        coroutineScope.launch {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Agent Centipede message", copyText)))
                        }
                        Toast.makeText(context, "Message copied", Toast.LENGTH_SHORT).show()
                    },
                    modifier = Modifier.size(32.dp),
                ) {
                    Icon(Icons.Default.ContentCopy, "Copy message", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

internal fun workerBatchSummary(batch: WorkerBatch): String = when (batch.status) {
    "queued" -> "${batch.counts.total} ${if (batch.counts.total == 1) "worker" else "workers"} queued"
    "running" -> if (batch.counts.completed > 0) {
        "${batch.counts.completed} of ${batch.counts.total} complete"
    } else {
        "${batch.counts.running} of ${batch.counts.total} working"
    }
    "completed" -> "${batch.counts.total} ${if (batch.counts.total == 1) "worker" else "workers"} · Done"
    "failed" -> "${batch.counts.completed} done · ${batch.counts.failed} failed"
    else -> buildList {
        add("Stopped")
        if (batch.counts.completed > 0) add("${batch.counts.completed} completed")
        if (batch.counts.canceled > 0) add("${batch.counts.canceled} canceled")
    }.joinToString(" · ")
}

@Composable
private fun WorkerBatchBubble(batch: WorkerBatch) {
    var expanded by rememberSaveable(batch.id) { mutableStateOf(!batch.terminal) }
    LaunchedEffect(batch.terminal) {
        if (batch.terminal) expanded = false
    }
    val attention = batch.status == "failed" || batch.status == "canceled"
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth(0.92f).clickable { expanded = !expanded },
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when (batch.status) {
                    "running" -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = CentipedeAcid)
                    "completed" -> Icon(Icons.Default.CheckCircle, null, Modifier.size(19.dp), tint = CentipedeSuccess)
                    "failed" -> Icon(Icons.Default.ErrorOutline, null, Modifier.size(19.dp), tint = MaterialTheme.colorScheme.error)
                    "canceled" -> Icon(Icons.Default.StopCircle, null, Modifier.size(19.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> Icon(Icons.Default.Schedule, null, Modifier.size(18.dp), tint = CentipedeAcid)
                }
                Column(Modifier.weight(1f)) {
                    Text(batch.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        workerBatchSummary(batch),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (attention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    if (expanded) "Collapse worker progress" else "Expand worker progress",
                    Modifier.graphicsLayer(rotationZ = if (expanded) 180f else 0f),
                )
            }
            AnimatedVisibility(visible = expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    batch.jobs.forEach { job -> WorkerLane(job) }
                }
            }
        }
    }
}

@Composable
private fun WorkerLane(job: WorkerBatchJob) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        when (job.status) {
            "running" -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = CentipedeAcid)
            "completed" -> Icon(Icons.Default.CheckCircle, null, Modifier.size(15.dp), tint = CentipedeSuccess)
            "failed" -> Icon(Icons.Default.ErrorOutline, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.error)
            "canceled" -> Icon(Icons.Default.StopCircle, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> Icon(Icons.Default.Schedule, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(job.label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            when (job.status) {
                "running" -> "Working"
                "completed" -> "Done"
                "failed" -> "Failed"
                "canceled" -> "Canceled"
                else -> "Queued"
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Work is the mission board for the companion. It only renders state already
 * owned by the desktop: active bots, pending approval cards, routine runs,
 * and their returned output/error evidence.
 */
@Composable
private fun WorkTab(state: MausUiState, viewModel: MausViewModel) {
    val bots = state.fleet.bots.filter { it.hidden != true }
    val active = bots.filter { it.busy == true }
    val approvalItems = bots.flatMap { bot ->
        visibleChatMessages(bot.messages).filter { it.card?.pending == true }.map { bot to it }
    }
    val recentRuns = state.routineRuns.sortedByDescending { it.finishedAt ?: it.startedAt ?: it.scheduledFor }.take(8)
    val botNames = bots.associate { it.id to it.name }
    LazyColumn(
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Work", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                Text("See what’s moving, make the calls, and check the receipts.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (active.isNotEmpty()) {
            item { SectionHeader("In motion", "Your agents are moving") }
            items(active, key = { "work-active-${it.id}" }) { bot -> CrewRow(bot) { viewModel.selectBot(bot.id) } }
        }
        if (approvalItems.isNotEmpty()) {
            item { SectionHeader("Needs your call", "Nothing sends until you say so") }
            items(approvalItems.take(8), key = { "work-approval-${it.first.id}-${it.second.id}" }) { (bot, message) ->
                ApprovalPreview(bot, message) { viewModel.selectBot(bot.id) }
            }
        }
        item { SectionHeader("Routines", if (state.routines.isEmpty()) "No routines have arrived from the desktop yet." else "A quick tap can kick one off") }
        if (state.routines.isEmpty() && !state.loading) {
            item { EmptyState("No routines yet", "Create one on the desktop and it’ll land here.") }
        } else {
            items(state.routines, key = { "work-routine-${it.id}" }) { routine ->
                Surface(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(20.dp),
                    color = MaterialTheme.colorScheme.surface,
                    tonalElevation = 1.dp,
                ) {
                    Column(Modifier.padding(15.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(routine.name, fontWeight = FontWeight.Bold)
                                Text("${botNames[routine.botId] ?: "Agent"} · ${scheduleLabel(routine)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(checked = routine.enabled, onCheckedChange = { viewModel.setRoutineEnabled(routine, it) })
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (routine.enabled) "Ready to run" else "Paused", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.weight(1f))
                            OutlinedButton(onClick = { viewModel.runRoutine(routine) }) {
                                Icon(Icons.Default.PlayArrow, "", Modifier.size(17.dp))
                                Spacer(Modifier.width(5.dp))
                                Text("Run now")
                            }
                        }
                    }
                }
            }
        }
        if (recentRuns.isNotEmpty()) {
            item { SectionHeader("Receipts", "What the last runs actually returned") }
            items(recentRuns, key = { "work-run-${it.id}" }) { run -> RoutineRunCard(run) }
        }
    }
}

internal fun copyableMessageText(message: Message): String {
    val sections = mutableListOf<String>()
    message.text?.takeIf { it.isNotBlank() }?.let(sections::add)
    message.card?.let { card ->
        val cardText = buildList {
            card.title.takeIf { it.isNotBlank() }?.let(::add)
            card.subtitle.takeIf { it.isNotBlank() }?.let(::add)
            card.answered?.takeIf { it.isNotBlank() }?.let { add("Answered: $it") }
        }.joinToString("\n")
        if (cardText.isNotBlank()) sections += cardText
    }
    return sections.joinToString("\n\n")
}

@Composable
private fun RoutinesTab(state: MausUiState, viewModel: MausViewModel) {
    val botNames = state.fleet.bots.associate { it.id to it.name }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Routines", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Run, pause, or resume your automations without opening the computer.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(state.routines, key = { it.id }) { routine ->
            Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(routine.name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
                            Text("${botNames[routine.botId] ?: "Agent"} · ${scheduleLabel(routine)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = routine.enabled, onCheckedChange = { viewModel.setRoutineEnabled(routine, it) })
                    }
                    Text(routine.prompt, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AssistChip(onClick = {}, label = { Text(if (routine.enabled) "Active" else "Paused") }, leadingIcon = { Icon(if (routine.enabled) Icons.Default.CheckCircle else Icons.Default.PauseCircle, null, Modifier.size(16.dp)) })
                        Spacer(Modifier.weight(1f))
                        OutlinedButton(onClick = { viewModel.runRoutine(routine) }) {
                            Icon(Icons.Default.PlayArrow, null)
                            Spacer(Modifier.width(4.dp))
                            Text("Run now")
                        }
                    }
                }
            }
        }
        if (state.routineRuns.isNotEmpty()) {
            item {
                Spacer(Modifier.height(8.dp))
                Text("Recent runs", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text("The latest results from your agents.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(
                state.routineRuns.sortedByDescending { it.finishedAt ?: it.startedAt ?: it.scheduledFor }.take(8),
                key = { it.id },
            ) { run -> RoutineRunCard(run) }
        }
        if (state.routines.isEmpty() && !state.loading) item { EmptyState("No routines", "Create a routine for any agent on the desktop.") }
    }
}

@Composable
private fun RoutineRunCard(run: RoutineRun) {
    val status = run.status.ifBlank { "unknown" }.replace('-', ' ').replace('_', ' ').replaceFirstChar(Char::uppercase)
    val normalized = run.status.lowercase()
    val statusColor = when {
        normalized in setOf("completed", "complete", "success", "succeeded", "done") -> CentipedeSuccess
        normalized in setOf("failed", "error", "cancelled", "canceled") -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.primary
    }
    Card(shape = RoundedCornerShape(18.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(run.routineName.ifBlank { "Routine run" }, fontWeight = FontWeight.Bold)
                    Text(if (run.manual) "Started manually" else "Scheduled run", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(status, color = statusColor, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
            }
            run.output?.takeIf { it.isNotBlank() }?.let {
                Text(it, maxLines = 4, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
            }
            run.error?.takeIf { it.isNotBlank() }?.let {
                Text(it, maxLines = 3, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            val timestamp = run.finishedAt ?: run.startedAt ?: run.scheduledFor
            if (timestamp > 0) Text(formatDateTime(timestamp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
    }
}

@Composable
private fun SettingsTab(state: MausUiState, viewModel: MausViewModel) {
    var confirm by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val application = context.applicationContext as? MausApplication
    var crashEntries by remember { mutableStateOf(application?.crashDiagnostics?.entries().orEmpty()) }
    val lifecycleOwner = LocalLifecycleOwner.current
    var mirrorEnabled by remember { mutableStateOf(NotificationMirrorSettings.isEnabled(context)) }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) mirrorEnabled = NotificationMirrorSettings.isEnabled(context)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val session = state.session ?: return
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
            Text("A few knobs for your phone and your agent workspace.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item {
            Card(shape = RoundedCornerShape(22.dp)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Diagnostics", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(
                        if (crashEntries.isEmpty()) "Nothing weird logged here." else "${crashEntries.size} small mystery${if (crashEntries.size == 1) "" else "ies"} ready to share with troubleshooting.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("Only timestamps and technical breadcrumbs live here—never your messages, tokens, or credentials.", style = MaterialTheme.typography.bodySmall)
                    if (crashEntries.isNotEmpty()) {
                        OutlinedButton(onClick = { application?.crashDiagnostics?.clear(); crashEntries = emptyList() }, modifier = Modifier.fillMaxWidth()) { Text("Clear local reports") }
                    }
                }
            }
        }
        item {
            Card(shape = RoundedCornerShape(22.dp)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(session.connection.name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(session.connection.origin)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(9.dp).background(if (state.live) CentipedeSuccess else MaterialTheme.colorScheme.outline, CircleShape))
                        Spacer(Modifier.width(8.dp))
                        Text(if (state.live) "Connected · updates are flowing" else "Trying to reconnect · the computer may be asleep")
                    }
                }
            }
        }
        item {
            Card(shape = RoundedCornerShape(22.dp)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Agent updates", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("Choose how much background chatter reaches you. Personality, tools, and full routines stay editable on desktop.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.fleet.bots.filter { it.hidden != true }.forEach { bot ->
                        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(bot.name, fontWeight = FontWeight.SemiBold)
                            Row(
                                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                            ) {
                                listOf("all" to "Everything", "actionable" to "Important only", "silent" to "Asked only").forEach { (mode, label) ->
                                    if (bot.reportingMode == mode) {
                                        Button(onClick = { viewModel.setReportingMode(bot, mode) }) { Text(label) }
                                    } else {
                                        OutlinedButton(onClick = { viewModel.setReportingMode(bot, mode) }) { Text(label) }
                                    }
                                }
                            }
                        }
                        if (bot != state.fleet.bots.filter { it.hidden != true }.lastOrNull()) HorizontalDivider()
                    }
                }
            }
        }
        item {
            Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Private by design", fontWeight = FontWeight.Bold)
            Text("Your phone holds a locked device key. Agents, transcripts, files, API keys, and computer sessions stay on your computer.")
                }
            }
        }
        item {
            Card(shape = RoundedCornerShape(22.dp)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Google Messages mirror", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(
                        if (mirrorEnabled) "On · visible Google Messages notifications can reach your configured agents."
                        else "Off · turn it on if an agent should keep an eye on visible Messages notifications.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("Read-only visible notification text only. Agent Centipede does not access the SMS database, drafts, replies, or notification actions, and does not change your default Messages app.", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(
                        onClick = { context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (mirrorEnabled) "Manage notification access" else "Turn on notification access") }
                }
            }
        }
        item { OutlinedButton(onClick = { confirm = true }, modifier = Modifier.fillMaxWidth()) { Text("Disconnect this phone") } }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false },
        title = { Text("Disconnect this phone?") },
        text = { Text("The encrypted device token will be removed from this phone. You can also revoke it from desktop Settings → Phone.") },
        confirmButton = { Button(onClick = viewModel::disconnect) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComputerScreen(state: MausUiState, viewModel: MausViewModel) {
    BackHandler { viewModel.openComputer(null) }
    val bot = state.fleet.bots.find { it.id == state.computerBotId }
    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = { viewModel.openComputer(null) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            title = { Text("${bot?.name ?: "Agent"}’s computer", fontWeight = FontWeight.Bold) },
        )
    }) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(CentipedeInk), contentAlignment = Alignment.Center) {
            val bitmap = remember(state.screenPng) { state.screenPng?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } }
            if (bitmap != null) {
                Image(bitmap.asImageBitmap(), "Live computer screen", Modifier.fillMaxSize().padding(8.dp), contentScale = ContentScale.Fit)
                Surface(Modifier.align(Alignment.TopCenter).padding(12.dp), shape = CircleShape, color = Color.Black.copy(alpha = 0.65f)) {
                    Text("LIVE · view only", color = Color.White, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium)
                }
            } else Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (state.screenError == null) CircularProgressIndicator(color = CentipedeAcid)
                Spacer(Modifier.height(12.dp))
                Text(
                    state.screenError ?: "Waiting for the next screen frame…",
                    color = if (state.screenError == null) Color.White else Color(0xFFFFC5BC),
                    modifier = Modifier.padding(horizontal = 24.dp),
                )
                if (state.screenError != null) {
                    Spacer(Modifier.height(12.dp))
                    OutlinedButton(onClick = { viewModel.openComputer(state.computerBotId) }) {
                        Text("Try again")
                    }
                }
            }
        }
    }
}

@Composable
private fun CentipedeMark(size: Int) {
    Canvas(Modifier.width((size * 1.35f).dp).height(size.dp)) {
        val acid = CentipedeAcid
        val ink = CentipedeInk
        val centerY = this.size.height / 2f
        val segmentWidth = this.size.width / 7.2f
        val bodyHeight = this.size.height * 0.38f
        val gap = segmentWidth * 0.12f
        val startX = segmentWidth * 0.45f
        repeat(6) { index ->
            val x = startX + index * (segmentWidth + gap)
            val legColor = if (index % 2 == 0) ink else acid
            drawLine(legColor, Offset(x + segmentWidth * .5f, centerY - bodyHeight * .4f), Offset(x + segmentWidth * .25f, centerY - bodyHeight), strokeWidth = 2.2f)
            drawLine(legColor, Offset(x + segmentWidth * .5f, centerY + bodyHeight * .4f), Offset(x + segmentWidth * .25f, centerY + bodyHeight), strokeWidth = 2.2f)
            drawRoundRect(
                color = if (index % 2 == 0) acid else ink,
                topLeft = Offset(x, centerY - bodyHeight / 2f),
                size = Size(segmentWidth, bodyHeight),
                cornerRadius = CornerRadius(bodyHeight * .42f),
            )
        }
        drawCircle(acid, radius = this.size.height * .07f, center = Offset(this.size.width * .89f, centerY - bodyHeight * .09f))
    }
}

@Composable
private fun LivePulseDot(active: Boolean, modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "live-pulse")
    val pulse by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (active) 1.16f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1_250),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "live-pulse-scale",
    )
    Box(
        modifier
            .graphicsLayer {
                scaleX = pulse
                scaleY = pulse
                alpha = if (active) .92f + ((pulse - 1f) * .5f) else .72f
            }
            .background(if (active) CentipedeSuccess else CentipedeAcid, CircleShape),
    )
}

@Composable
private fun BotAvatar(bot: Bot, size: Int) {
    val shape = RoundedCornerShape((size * .25f).dp)
    val line = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .68f)
    val ink = MaterialTheme.colorScheme.onSurface
    Box(
        Modifier
            .size(size.dp)
            .clip(shape)
            .border(1.dp, line, shape)
            .background(MaterialTheme.colorScheme.surface),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val step = this.size.width / 5f
            for (index in 1..4) {
                val offset = step * index
                drawLine(line, Offset(offset, 0f), Offset(offset, this.size.height), strokeWidth = .55f)
                drawLine(line, Offset(0f, offset), Offset(this.size.width, offset), strokeWidth = .55f)
            }
        }
        Box(
            Modifier
                .align(Alignment.TopStart)
                .padding(start = (size * .13f).dp, top = (size * .1f).dp)
                .width((size * .24f).dp)
                .height(2.dp)
                .background(CentipedeAcid, CircleShape),
        )
        Icon(
            imageVector = agentRoleIcon(bot),
            contentDescription = "${bot.name} agent",
            modifier = Modifier.size((size * .43f).dp),
            tint = ink,
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = (size * .08f).dp, bottom = (size * .08f).dp)
                .size((size * .16f).coerceAtLeast(5f).dp)
                .border(1.5.dp, MaterialTheme.colorScheme.surface, CircleShape)
                .background(CentipedeAcid, CircleShape),
        )
    }
}

private fun agentRoleIcon(bot: Bot): ImageVector {
    if (bot.chiefOfStaff == true) return Icons.Outlined.AccountTree
    val identity = "${bot.name} ${bot.title} ${bot.description}".lowercase()
    return when {
        listOf("capture", "collector", "ingest", "inbox", "source", "sync").any(identity::contains) -> Icons.Outlined.DocumentScanner
        listOf("build", "code", "developer", "engineer", "product").any(identity::contains) -> Icons.Outlined.Code
        listOf("research", "analyst", "analysis", "investigate").any(identity::contains) -> Icons.Outlined.Search
        listOf("browser", "computer", "desktop", "windows", "operator").any(identity::contains) -> Icons.Outlined.Computer
        listOf("ops", "operations", "reliability", "monitor", "watch").any(identity::contains) -> Icons.Outlined.SettingsSuggest
        else -> Icons.Outlined.AutoAwesome
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.ErrorOutline, null, Modifier.size(38.dp), tint = MaterialTheme.colorScheme.outline)
        Spacer(Modifier.height(10.dp))
        Text(title, fontWeight = FontWeight.Bold)
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 24.dp))
    }
}

private fun formatTime(milliseconds: Double): String = runCatching {
    DateTimeFormatter.ofPattern("h:mm a").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(milliseconds.toLong()))
}.getOrDefault("")

private fun formatDateTime(milliseconds: Double): String = runCatching {
    DateTimeFormatter.ofPattern("MMM d · h:mm a").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(milliseconds.toLong()))
}.getOrDefault("")

private fun timeOfDay(): String = when (LocalTime.now().hour) {
    in 5..11 -> "morning"
    in 12..16 -> "afternoon"
    else -> "evening"
}

private fun scheduleLabel(routine: Routine): String = when (routine.schedule.type) {
    "interval" -> "Every ${routine.schedule.intervalMinutes ?: "?"} min"
    "daily" -> buildString {
        val days = routine.schedule.weekdays.orEmpty()
        append(if (days.size == 7 || days.isEmpty()) "Daily" else if (days == listOf(1, 2, 3, 4, 5)) "Weekdays" else "Selected days")
        routine.schedule.time?.let { append(" at ").append(it) }
    }
    "once" -> routine.schedule.at?.let { "Once · ${formatTime(it)}" } ?: "Once"
    else -> routine.schedule.type.replaceFirstChar(Char::uppercase)
}
