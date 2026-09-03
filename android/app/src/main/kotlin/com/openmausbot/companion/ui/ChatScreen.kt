package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openmausbot.companion.R
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.ChatTarget
import com.openmausbot.companion.core.CompanionState
import com.openmausbot.companion.core.Dictation
import com.openmausbot.companion.core.Message
import com.openmausbot.companion.core.TranscriptRow
import com.openmausbot.companion.core.target
import com.openmausbot.companion.core.transcriptRows
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * One conversation: the transcript, the approval cards, and the composer — the
 * port of `ios/App/ChatView.swift`.
 *
 * The transcript is whatever the harness folded — settled text, tool chips,
 * option cards, screenshots. This renders those and nothing else; it does not
 * re-derive anything from provider events, because the server already did that
 * and having two folds is how two clients start disagreeing.
 *
 * The chrome floats: back and the bot's computer on a strip that fades into the
 * transcript, the bot's face and name over it, and the composer below. Everything
 * else scrolls underneath, which is what makes the conversation the screen.
 */
@Composable
fun ChatScreen(
    destination: Destination.Conversation,
    onResolved: (ChatTarget) -> Unit,
    onBack: () -> Unit,
    onOpenComputer: (String) -> Unit,
    /**
     * True while this conversation is still on the navigator stack (including
     * under Computer). Used on dispose to keep the in-memory draft across a
     * push and drop it after a pop that removed the chat.
     */
    retainsDraft: (chatId: String) -> Boolean = { false },
) {
    val session = LocalCompanion.current.session
    val state by session.state.collectAsState()

    // A notification tap at a cold start arrives before the fleet is hydrated,
    // and so does a navigation stack restored after the process was killed: wait
    // for it rather than concluding the chat is gone and bouncing back to the
    // roster, which would make the tap open nothing.
    val resolution = remember(state, destination) {
        ThreadResolution.resolve(state, destination)
    }
    when (resolution) {
        ThreadResolution.Result.Waiting -> OpeningThread(onBack)
        ThreadResolution.Result.Gone -> LaunchedEffect(destination) { onBack() }
        // The live chat record, so busy/unread stay current as frames land.
        is ThreadResolution.Result.Open -> {
            // A thread the fleet has now put a name to stops being a thread, so
            // this chat follows its bot from here on — including when the task
            // that is open is the one deleted.
            val resolved = (destination as? Destination.Thread)?.let { resolution.chat.target }
            LaunchedEffect(resolved) { if (resolved != null) onResolved(resolved) }
            LoadedChat(resolution.chat, state, onBack, onOpenComputer, retainsDraft)
        }
    }
}

/** The transcript is on its way. Leaving is still possible while it is. */
@Composable
private fun OpeningThread(onBack: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BackPill(unreadElsewhere = 0, onBack = onBack)
        }
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun LoadedChat(
    chat: Chat,
    state: CompanionState,
    onBack: () -> Unit,
    onOpenComputer: (String) -> Unit,
    retainsDraft: (chatId: String) -> Boolean,
) {
    // The bot's *current* thread, not the one the destination named. Switching or
    // creating a task moves a bot to another thread; everything below re-keys on
    // that, so the screen follows the bot to the task it is now in.
    val threadId = chat.threadId
    // Stable conversation identity — not threadId. iOS keeps `@State draft`
    // across a task switch inside the same ChatView; keying the draft on
    // threadId would wipe it.
    val chatId = chat.id
    val environment = LocalCompanion.current
    val session = environment.session
    val dictation = environment.dictation
    val chatDrafts = environment.chatDrafts
    val haptics = rememberHaptics()
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    var showingTasks by remember { mutableStateOf(false) }
    // Saveable: the profile form is a form, and a rotation must not throw away
    // what was typed into it — the sheet has to come back for that to matter.
    var showingProfile by rememberSaveable { mutableStateOf(false) }
    var showingPlus by remember(threadId) { mutableStateOf(false) }
    // The bot on the line. Not saveable: a call does not survive a rotation's
    // teardown of the audio session any better than a phone call would.
    var showingCall by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val focusedMessageId by session.focusedMessageId.collectAsState()

    val dictationListening by dictation.isListening.collectAsState()
    val dictationStarting by dictation.isStarting.collectAsState()
    val dictationError by dictation.error.collectAsState()
    val dictationLocked = dictationListening || dictationStarting

    val rawTranscript = remember(state, threadId) { state.visibleTranscript(threadId) }
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()
    val quickReplies by environment.chatPreferences.quickReplies.collectAsState()
    // The source transcript stays intact for approvals, mascot state and
    // pagination. Only the rendered rows fold activity according to the local
    // preference, so changing the choice never mutates server state.
    val transcript = remember(rawTranscript, activityDetail) {
        transcriptRows(rawTranscript, activityDetail)
    }
    val predictiveChips = remember(quickReplies) {
        quickReplies.map { PredictiveChip(title = it.title, prompt = it.prompt, icon = it.icon) }
    }
    val streaming = state.streaming[threadId]
    val reasoning = state.reasoning[threadId]
    // Stream, then reasoning, then the bare fact of being busy — the order in
    // `ChatView.swift`, and the reason it is a rule rather than three `if`s here.
    val tail = LiveTail.of(streaming = streaming, reasoning = reasoning, busy = chat.busy)
    val liveText = streaming?.takeIf { tail == TranscriptTail.STREAM }
    val liveReasoning = reasoning?.takeIf { tail == TranscriptTail.REASONING }
    val hasMore = state.hasMore[threadId] == true
    // What stops the predictive chips from covering the one question on screen
    // that only a person can answer.
    val pendingApproval = remember(rawTranscript) {
        ComposerAccessories.hasPendingApproval(rawTranscript)
    }

    // Two halves of the composer draft:
    // (a) ChatComposerDraft under its saver — rememberSaveable persists only
    //     [ChatComposerDraft.saveableValue] (typed before any dictation). The
    //     screen never chooses a field; the saver is the only bridge (§6).
    // (b) draft — volatile TextField mirror; the holder keeps the full string
    //     across a Computer push (which removes ChatScreen from composition).
    // iOS `@State draft` survives rotation and an in-view Computer push
    // because ChatView's identity stays; Android needs this split to match
    // that without serialising transcripts.
    //
    // Push vs pop: leave-to-roster clears both halves via
    // [ChatComposerDraft.onLeaveToRoster] before pop. Computer must not —
    // [retainsDraft] stays true while the chat is under Computer.
    //
    // Keys include chatDrafts as well as chatId: the saver and ChatComposerDraft
    // both capture the holder, so a replaced CompanionEnvironment must remount
    // them together. Today MainActivity builds the holder once per Activity
    // (unreachable while the same chat stays composed); the key still guards
    // that latent case. Factory stays inside remember — never per recomposition.
    val heldOnEntry = remember(chatId, chatDrafts) { chatDrafts.get(chatId) }
    // Hoist the saver: building it inline in rememberSaveable reallocates the
    // Saver + both lambdas on every LoadedChat recomposition (partials included).
    val composerSaver = remember(chatId, chatDrafts) {
        ChatComposerDraft.saver(chatId, chatDrafts)
    }
    val composer = rememberSaveable(chatId, chatDrafts, saver = composerSaver) {
        ChatComposerDraft(
            chatId,
            chatDrafts,
            initialSaveable = heldOnEntry?.typedSnapshot.orEmpty(),
        )
    }
    var draft by remember(chatId, chatDrafts) { mutableStateOf(composer.text) }
    // The command HUD opens from the button *or* from a draft that starts with a
    // slash — and typing anything else closes it again. iOS drives that from
    // `onChange(of: draft)`, which fires however the draft moved, so the rule
    // lives in the one funnel every draft change goes through rather than in the
    // text field's callback alone.
    //
    // Seeded from the restored draft rather than from `false`: coming back from
    // Computer, or from a process death, is a mount and not an edit, so nothing
    // would ever re-apply the rule to a `/dif` that is already in the field.
    // Closing the HUD by hand still sticks — the seed runs once per mount, and
    // `remember` does not re-run it.
    var hudOpen by remember(chatId, chatDrafts) {
        mutableStateOf(SlashCommands.openOnEntry(composer.text))
    }
    val listState = rememberLazyListState()

    fun publishFrom(composerDraft: ChatComposerDraft) {
        // UI mirror only. Saveable half is owned by the composer + its saver.
        draft = composerDraft.text
        hudOpen = SlashCommands.opensOnDraft(draft)
    }

    // Bind dictation to this chat's lifecycle: leaving the screen (including
    // pushing Computer) and process background both stop capture.
    DisposableEffect(lifecycleOwner, threadId) {
        dictation.bind(lifecycleOwner)
        onDispose { dictation.unbind(lifecycleOwner) }
    }

    // Drop the in-memory entry when the chat leaves the stack (roster pop or
    // stack rewrite). Keep it when Computer is pushed on top.
    DisposableEffect(chatId) {
        onDispose {
            if (!retainsDraft(chatId)) {
                chatDrafts.clear(chatId)
            }
        }
    }

    // Always join against the text frozen at capture start. A newer partial
    // then replaces the older partial instead of duplicating it. Skip the
    // first emission: StateFlow replays a sticky transcript from a prior
    // session, and applying that on open would clobber this chat's draft.
    // Merged text stays in the volatile draft / holder — never in the
    // saveable typed snapshot.
    LaunchedEffect(threadId, dictation) {
        var first = true
        dictation.transcript.collect { next ->
            if (first) {
                first = false
                return@collect
            }
            val merged = Dictation.draft(base = dictation.base, transcript = next)
            composer.onDictation(merged)
            publishFrom(composer)
        }
    }
    LaunchedEffect(dictationListening) {
        if (dictationListening) focusManager.clearFocus()
    }
    // Stop when computer / tasks / profile / plus open — matching ChatView.swift.
    LaunchedEffect(showingPlus) { if (showingPlus) dictation.stop() }
    LaunchedEffect(showingTasks) { if (showingTasks) dictation.stop() }
    LaunchedEffect(showingProfile) { if (showingProfile) dictation.stop() }
    LaunchedEffect(showingCall) { if (showingCall) dictation.stop() }

    // Opening a chat is what marks it read, exactly as on the desktop — and a
    // message can arrive while it is already on screen, so this keys on the bit
    // rather than running once.
    LaunchedEffect(threadId, chat.unread) {
        if (chat.unread) session.markRead(chat)
    }

    val headerCount = if (hasMore) 1 else 0
    // One slot at the bottom, whichever of the three is in it — iOS gives all of
    // them the same `.id(Self.liveBubbleId)` for the same reason: they replace
    // one another, they do not stack.
    val liveCount = if (tail == TranscriptTail.NONE) 0 else 1
    val itemCount = headerCount + transcript.size + liveCount

    // A conversation grows from the bottom: opening a chat starts on the newest
    // message rather than the oldest.
    var settled by remember(threadId) { mutableStateOf(false) }
    LaunchedEffect(threadId, itemCount) {
        if (settled || itemCount == 0) return@LaunchedEffect
        listState.scrollToItem(itemCount - 1)
        settled = true
    }
    LaunchedEffect(threadId, transcript.lastOrNull()?.id) {
        if (!settled || itemCount == 0) return@LaunchedEffect
        listState.animateScrollToItem(itemCount - 1)
    }
    // Follow the live row: its arrival, its change of kind, and the text inside
    // it. Keyed on length rather than the string so this fires once per delta
    // batch, and without animation — animating every token turns a smooth stream
    // into a stutter. [tail] is a key of its own because the working row appears
    // with no text at all, and a row nobody scrolls to is a row nobody is told
    // about.
    LaunchedEffect(threadId, tail, liveText?.length ?: 0) {
        if (liveCount == 0 || itemCount == 0) return@LaunchedEffect
        listState.scrollToItem(itemCount - 1)
    }
    // A search hit lands on its message.
    LaunchedEffect(focusedMessageId, transcript.size) {
        val target = focusedMessageId ?: return@LaunchedEffect
        val index = transcript.indexOfFirst { row ->
            row.id == target ||
                (row as? TranscriptRow.ActivityRun)?.items?.any { it.id == target } == true
        }
        if (index < 0) return@LaunchedEffect
        listState.scrollToItem(headerCount + index)
        session.consumeFocus(target)
        settled = true
    }

    val bot = (chat as? Chat.BotChat)?.bot
    // The computer is bot-only; a non-DM room exposes task navigation when the
    // paired desktop supplied a task list. Both answers are constants.
    val commands = SlashCommands.forChat(chat)
    // One handler for the one door. The name pill stopped being the second when
    // it became the way into a bot's profile, so the + now carries every action
    // there is — including both export formats.
    val onAction: (ChatActionId) -> Unit = { action ->
        when (action) {
            ChatActionId.NEW_TASK -> scope.launch {
                when (chat) {
                    is Chat.BotChat -> session.createTask(chat.bot, null)
                    is Chat.RoomChat -> if (chat.supportsTasks) session.createTask(chat.room, null)
                }
            }
            ChatActionId.TASKS -> showingTasks = true
            ChatActionId.WATCH_COMPUTER -> {
                // iOS stops on showingComputer; Android leaves ChatScreen when
                // Computer is pushed, but stop here too so capture ends before
                // the navigation frame, not only on dispose.
                dictation.stop()
                if (bot != null) onOpenComputer(bot.id)
            }
            ChatActionId.SHARE_MARKDOWN -> share(scope, environment, threadId, ShareFormat.MARKDOWN)
            ChatActionId.SHARE_JSON -> share(scope, environment, threadId, ShareFormat.JSON)
            ChatActionId.INTERRUPT -> if (bot != null) scope.launch { session.interrupt(bot) }
        }
        Unit
    }

    // A slash command that navigates clears the draft the way emptying the
    // field does — including its provenance, so a spoken word cannot outlive it.
    fun clearDraft() {
        composer.onTypedChange("")
        publishFrom(composer)
    }

    /**
     * The port of iOS `submit(_ explicitText:)`. A command or a chip sends its
     * own prompt and still clears the composer, exactly as the Swift does: the
     * `/dif` you had half-typed is what you were asking for, and leaving it
     * behind would send it again on the next tap of the send button.
     */
    fun submit(explicitText: String? = null) {
        // Cancels an in-flight permission prompt before it can open the
        // microphone after the message has already been sent.
        dictation.stop()
        val text = (explicitText ?: draft).trim()
        if (text.isEmpty()) return
        composer.onSend()
        // Clearing the draft closes the HUD through the rule above, which is
        // how iOS's `showCommandHUD = false` on submit happens as well.
        publishFrom(composer)
        // Where iOS plays `SoundEffects.playSent()` and a medium impact. The
        // motor only: the sound there is an Apple system id with no counterpart
        // here, and the keyboard already owns that job on this platform.
        haptics.play(HapticCue.SEND)
        // Deliberately not disabled while the bot is busy: the harness answers
        // 409 and Session surfaces "The bot is busy — stop it first." That is a
        // clearer answer than a dead button.
        scope.launch { session.send(text, chat) }
    }

    fun selectCommand(command: SlashCommand) {
        // Null for a command that sends: `submit` below plays the send cue, and
        // two effects back to back on one gesture are one muddled buzz.
        CompanionHaptics.forCommand(command.effect)?.let { haptics.play(it) }
        when (val effect = command.effect) {
            SlashEffect.OpenComputer -> {
                // Stop before clearing, not after: a partial still in flight
                // would land on the draft this just emptied. iOS stops on
                // `showingComputer`; Android leaves ChatScreen when Computer is
                // pushed, so stop here too — before the navigation frame, not
                // only on dispose.
                dictation.stop()
                clearDraft()
                if (bot != null) onOpenComputer(bot.id)
            }

            SlashEffect.OpenTasks -> {
                dictation.stop()
                clearDraft()
                showingTasks = true
            }

            is SlashEffect.Send -> submit(effect.prompt)
        }
        hudOpen = false
    }

    /**
     * Closing takes back the `/` that opened the HUD and nothing else. Routed
     * around [publishFrom] when the draft did not change, because re-applying
     * the open rule to an unchanged `/dif` would reopen what was just closed.
     */
    fun closeHud() {
        val next = SlashCommands.draftAfterClose(draft)
        if (next != draft) {
            composer.onTypedChange(next)
            publishFrom(composer)
        }
        hudOpen = false
    }

    // Clear draft while still composed so rememberSaveable does not resurrect
    // it after a roster pop. Computer push never takes this path.
    fun leaveToRoster() {
        composer.onLeaveToRoster()
        publishFrom(composer)
        onBack()
    }

    BackHandler(enabled = showingPlus) { showingPlus = false }
    // Back dismisses an open panel before it leaves the screen — the platform's
    // own gesture, applied to the HUD the way it already was to the + sheet.
    BackHandler(enabled = !showingPlus && hudOpen) { closeHud() }
    BackHandler(enabled = !showingPlus && !hudOpen) { leaveToRoster() }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        // Room for the floating face when scrolled to the top.
                        top = HEADER_CLEARANCE,
                        bottom = 12.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (hasMore) {
                        item(key = LOAD_EARLIER_KEY) {
                            TextButton(
                                onClick = {
                                    // Keep the reader where they were: after older
                                    // messages are prepended, sit back on the one
                                    // that used to be at the top.
                                    val anchor = transcript.firstOrNull()?.id
                                    scope.launch {
                                        session.loadOlder(threadId)
                                        if (anchor == null) return@launch
                                        val fresh = session.state.value
                                        val freshRows = transcriptRows(
                                            fresh.visibleTranscript(threadId),
                                            activityDetail,
                                        )
                                        val index = freshRows.indexOfFirst { row ->
                                            row.id == anchor ||
                                                (row as? TranscriptRow.ActivityRun)
                                                    ?.items
                                                    ?.any { it.id == anchor } == true
                                        }
                                        if (index < 0) return@launch
                                        // The "load earlier" row is item 0 for as
                                        // long as there is still more to fetch.
                                        val offset = if (fresh.hasMore[threadId] == true) 1 else 0
                                        listState.scrollToItem(index + offset)
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text("Load earlier messages", fontSize = 13.sp)
                            }
                        }
                    }

                    itemsIndexedKeyed(transcript) { index, message ->
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            // A gap in time is worth marking; a timestamp on every
                            // message is just noise.
                            if (TranscriptLayout.startsNewRowStretch(transcript, index)) {
                                Text(
                                    text = RelativeStamp.separator(
                                        message.at,
                                        System.currentTimeMillis(),
                                        locale = Locale.getDefault(),
                                    ),
                                    fontSize = 13.sp,
                                    color = secondaryTint,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 6.dp),
                                    textAlign = TextAlign.Center,
                                )
                            }
                            when (message) {
                                is TranscriptRow.Single -> MessageRow(
                                    chat = chat,
                                    message = message.message,
                                    // One tail per run of bubbles from the same author,
                                    // not one per bubble.
                                    endsRun = TranscriptLayout.endsRowRun(transcript, index),
                                )
                                is TranscriptRow.ActivityRun -> ActivityRunChip(message.items)
                            }
                        }
                    }

                    if (liveCount == 1) {
                        item(key = LIVE_BUBBLE_KEY) {
                            if (tail == TranscriptTail.WORKING) {
                                WorkingBubble(name = chat.name, color = chat.color)
                            } else {
                                StreamingBubble(text = liveText, reasoning = liveReasoning)
                            }
                        }
                    }
                }

                ChatHeader(
                    chat = chat,
                    face = remember(chat, rawTranscript) {
                        MausState.forChat(chat, rawTranscript.lastOrNull())
                    },
                    unreadElsewhere = remember(state, chat) {
                        (state.unreadCount - if (chat.unread) 1 else 0).coerceAtLeast(0)
                    },
                    onBack = { leaveToRoster() },
                    onWatchComputer = {
                        dictation.stop()
                        if (bot != null) onOpenComputer(bot.id)
                    },
                    onCall = {
                        focusManager.clearFocus()
                        showingCall = true
                    },
                    // A bot's face and its name pill are both the door to its
                    // profile; a room has no profile, so its pill opens the same
                    // sheet the + does.
                    onOpenProfile = {
                        if (bot != null) {
                            showingProfile = true
                        } else {
                            dictation.stop()
                            focusManager.clearFocus()
                            showingPlus = true
                        }
                    },
                )
            }

            Composer(
                name = chat.name,
                draft = draft,
                accessory = ComposerAccessories.accessory(
                    hudOpen = hudOpen,
                    draft = draft,
                    busy = chat.busy,
                    pendingApproval = pendingApproval,
                    hasQuickReplies = predictiveChips.isNotEmpty(),
                ),
                commands = commands,
                chips = predictiveChips,
                plusOpen = showingPlus,
                dictationListening = dictationListening,
                dictationLocked = dictationLocked,
                dictationError = dictationError,
                onTogglePlus = {
                    // iOS drops the composer's focus before the sheet rises; a
                    // keyboard under it would leave the sheet nowhere to go.
                    dictation.stop()
                    if (!showingPlus) focusManager.clearFocus()
                    showingPlus = !showingPlus
                },
                onDraftChange = { next ->
                    if (dictationLocked) return@Composer
                    composer.onTypedChange(next)
                    publishFrom(composer)
                },
                onToggleDictation = {
                    focusManager.clearFocus()
                    dictation.toggle(capturing = draft)
                },
                onSend = { submit() },
                onToggleHud = {
                    dictation.stop()
                    haptics.play(HapticCue.SELECT)
                    hudOpen = !hudOpen
                },
                // The button, not the back gesture — `closeHud` is also what the
                // BackHandler calls, and Android already gives back its own feel.
                onCloseHud = {
                    haptics.play(HapticCue.SELECT)
                    closeHud()
                },
                onSelectCommand = { selectCommand(it) },
                // A chip is the whole message, sent on the tap.
                onSelectChip = { submit(it.prompt) },
            )
        }

        PlusSheet(
            open = showingPlus,
            actions = remember(chat, pendingApproval) {
                ChatActions.sheet(chat, hasPendingApproval = pendingApproval)
            },
            onDismiss = { showingPlus = false },
            onAction = {
                showingPlus = false
                onAction(it)
            },
        )
    }

    if (showingTasks) {
        if (chat.supportsTasks) TaskSheet(chat = chat, onDismiss = { showingTasks = false })
    }

    if (showingProfile && bot != null) {
        AgentProfileSheet(bot = bot, onDismiss = { showingProfile = false })
    }

    if (showingCall && bot != null) {
        CallScreen(bot = bot, onDismiss = { showingCall = false })
    }
}

private fun share(
    scope: kotlinx.coroutines.CoroutineScope,
    environment: CompanionEnvironment,
    threadId: String,
    format: ShareFormat,
) {
    scope.launch {
        val session = environment.session
        val exported = session.export(threadId, format.wire) ?: return@launch
        environment.shareTranscript(exported, format)?.let { session.actionError = it }
    }
}

private const val LOAD_EARLIER_KEY = "companion.loadEarlier"
private const val LIVE_BUBBLE_KEY = "companion.live"

/** `itemsIndexed` with the message id as the key — one call site, one helper. */
private fun androidx.compose.foundation.lazy.LazyListScope.itemsIndexedKeyed(
    messages: List<TranscriptRow>,
    content: @Composable (Int, TranscriptRow) -> Unit,
) {
    items(
        count = messages.size,
        key = { messages[it].id },
        itemContent = { index -> content(index, messages[index]) },
    )
}

// The strip the top controls sit on, and the air the transcript needs below the
// name pill before its first row.
private val HEADER_BAR = 56.dp
private val HEADER_SCRIM_FADE = 24.dp
private val HEADER_CLEARANCE = 128.dp

/**
 * Back on the left with the rest-of-app unread count, the bot's computer on the
 * right, and the bot itself between them over its name.
 *
 * The strip behind the two buttons is opaque and then fades out, so the
 * transcript slides under the chrome and disappears rather than stopping at a
 * line. The face and the name pill float below it on their own tiles.
 */
@Composable
private fun ChatHeader(
    chat: Chat,
    face: MausState,
    unreadElsewhere: Int,
    onBack: () -> Unit,
    onWatchComputer: () -> Unit,
    onCall: () -> Unit,
    onOpenProfile: () -> Unit,
) {
    val surface = MaterialTheme.colorScheme.surface
    Box(modifier = Modifier.fillMaxWidth()) {
        Spacer(
            modifier = Modifier
                .fillMaxWidth()
                .height(HEADER_BAR + HEADER_SCRIM_FADE)
                .drawWithCache {
                    val solid = HEADER_BAR.toPx() / size.height
                    val brush = Brush.verticalGradient(
                        0f to surface,
                        solid to surface,
                        1f to Color.Transparent,
                    )
                    onDrawBehind { drawRect(brush) }
                },
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.Top,
        ) {
            BackPill(unreadElsewhere = unreadElsewhere, onBack = onBack)
            Spacer(Modifier.weight(1f))
            // The computer is a bot idea; a room has none (§12). So is a call.
            if (chat is Chat.BotChat) {
                ChromeButton(
                    painter = painterResource(R.drawable.ic_phone),
                    contentDescription = "Call ${chat.name}",
                    onClick = onCall,
                )
                Spacer(Modifier.size(8.dp))
                ChromeButton(
                    painter = painterResource(R.drawable.ic_display),
                    contentDescription = "Watch ${chat.name}'s computer",
                    onClick = onWatchComputer,
                )
            } else {
                Spacer(Modifier.size(MIN_TOUCH_TARGET))
            }
        }

        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .padding(top = 2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ChatAvatar(
                chat = chat,
                size = 60.dp,
                state = face,
                modifier = if (chat is Chat.BotChat) {
                    Modifier
                        .clickable(role = Role.Button, onClick = onOpenProfile)
                        .semantics { contentDescription = "Open ${chat.name} profile" }
                } else {
                    Modifier
                },
            )
            NamePill(chat = chat, onOpen = onOpenProfile)
        }
    }
}

/** Leaving, with what is unread everywhere else — the badge Messages puts there. */
@Composable
private fun BackPill(unreadElsewhere: Int, onBack: () -> Unit) {
    Row(
        modifier = Modifier
            .chromeCapsule()
            .clip(CircleShape)
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(role = Role.Button, onClick = onBack)
            .padding(
                start = 14.dp,
                end = if (unreadElsewhere > 0) 10.dp else 14.dp,
            ),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
            contentDescription = "Back",
            modifier = Modifier.size(20.dp),
        )
        if (unreadElsewhere > 0) {
            Text(
                text = "$unreadElsewhere",
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape)
                    .defaultMinSize(minWidth = 22.dp, minHeight = 22.dp)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/**
 * The bot's name over its job, and the door to its profile — "who this is", as
 * against the composer's + for "do something". A room has no profile, so its
 * pill opens that same + sheet.
 */
@Composable
private fun NamePill(chat: Chat, onOpen: () -> Unit) {
    val isBot = chat is Chat.BotChat
    Row(
        modifier = Modifier
            .chromeCapsule()
            .clip(CircleShape)
            .heightIn(min = MIN_TOUCH_TARGET)
            .clickable(
                role = Role.Button,
                onClickLabel = if (isBot) {
                    "Open ${chat.name} profile"
                } else {
                    "Open ${chat.name} chat options"
                },
                onClick = onOpen,
            )
            .padding(start = 14.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = chat.name,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (chat.subtitle.isNotEmpty()) {
            Text(
                text = chat.subtitle,
                fontSize = 13.sp,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        Icon(
            imageVector = if (isBot) Icons.Filled.Person else Icons.Filled.MoreVert,
            contentDescription = null,
            tint = secondaryTint,
            modifier = Modifier.size(16.dp),
        )
    }
}

/**
 * What the composer's + opens: the things you can do here, each with a line
 * saying what it does. Rises above the composer; tapping anywhere else, the back
 * gesture, or the × the + became, puts it away.
 */
@Composable
private fun BoxScope.PlusSheet(
    open: Boolean,
    actions: List<ChatAction>,
    onDismiss: () -> Unit,
    onAction: (ChatActionId) -> Unit,
) {
    AnimatedVisibility(
        visible = open,
        enter = fadeIn(tween(PLUS_MILLIS)),
        exit = fadeOut(tween(PLUS_MILLIS)),
        modifier = Modifier.matchParentSize(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.35f))
                // The scrim is a dismissal, not a control: no ripple, and the
                // back gesture does the same thing for anyone not using touch.
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    role = Role.Button,
                    onClick = onDismiss,
                )
                .semantics { contentDescription = "Close" },
        )
    }

    AnimatedVisibility(
        visible = open,
        enter = slideInVertically(tween(PLUS_MILLIS)) { it / 2 } + fadeIn(tween(PLUS_MILLIS)),
        exit = slideOutVertically(tween(PLUS_MILLIS)) { it / 2 } + fadeOut(tween(PLUS_MILLIS)),
        modifier = Modifier
            .align(Alignment.BottomStart)
            .padding(start = 12.dp, end = 44.dp, bottom = 70.dp),
    ) {
        Column(
            modifier = Modifier
                .chromeSheet()
                .clip(RoundedCornerShape(PLUS_SHEET_RADIUS))
                .padding(vertical = 10.dp),
        ) {
            actions.forEach { action ->
                val tint = if (action.destructive) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                }
                val alpha = if (action.enabled) 1f else 0.45f
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 64.dp)
                        .clickable(
                            enabled = action.enabled,
                            role = Role.Button,
                            onClick = { onAction(action.id) },
                        )
                        .padding(horizontal = 18.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .background(
                                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f * alpha),
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        ChatActionIcon(id = action.id, tint = tint.copy(alpha = alpha))
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = action.title,
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Medium,
                            color = tint.copy(alpha = alpha),
                        )
                        Text(
                            text = action.subtitle,
                            fontSize = 13.sp,
                            color = secondaryTint.copy(alpha = alpha),
                        )
                    }
                }
            }
        }
    }
}

private const val PLUS_MILLIS = 280
private val PLUS_SHEET_RADIUS = 28.dp

/** The + becomes an ×. */
private const val PLUS_TURN_DEGREES = 45f

/**
 * The glyph beside an action. Decorative: the row's own text is the label, and
 * TalkBack reading the icon too would say everything twice.
 */
@Composable
private fun ChatActionIcon(id: ChatActionId, tint: Color) {
    val modifier = Modifier.size(22.dp)
    when (id) {
        ChatActionId.NEW_TASK ->
            Icon(Icons.Filled.Add, null, tint = tint, modifier = modifier)
        ChatActionId.TASKS ->
            Icon(Icons.AutoMirrored.Filled.List, null, tint = tint, modifier = modifier)
        ChatActionId.WATCH_COMPUTER ->
            Icon(painterResource(R.drawable.ic_display), null, tint = tint, modifier = modifier)
        ChatActionId.SHARE_MARKDOWN, ChatActionId.SHARE_JSON ->
            Icon(Icons.Filled.Share, null, tint = tint, modifier = modifier)
        ChatActionId.INTERRUPT ->
            Icon(Icons.Filled.Close, null, tint = tint, modifier = modifier)
    }
}

/** A round + and a pill with the send button inside it. */
@Composable
private fun Composer(
    name: String,
    draft: String,
    accessory: ComposerAccessory,
    commands: List<SlashCommand>,
    plusOpen: Boolean,
    dictationListening: Boolean,
    dictationLocked: Boolean,
    dictationError: String?,
    onTogglePlus: () -> Unit,
    onDraftChange: (String) -> Unit,
    onToggleDictation: () -> Unit,
    onSend: () -> Unit,
    onToggleHud: () -> Unit,
    onCloseHud: () -> Unit,
    onSelectCommand: (SlashCommand) -> Unit,
    chips: List<PredictiveChip>,
    onSelectChip: (PredictiveChip) -> Unit,
) {
    val canSend = draft.isNotBlank()
    // Held as the state rather than unwrapped with `by`: read inside the layer
    // block, the turn is a new frame, not a new composition of the composer.
    val turn = animateFloatAsState(
        targetValue = if (plusOpen) PLUS_TURN_DEGREES else 0f,
        animationSpec = tween(PLUS_MILLIS),
        label = "plus",
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dictationError != null) {
            Text(
                text = dictationError,
                fontSize = 13.sp,
                color = Color(0xFFFF9800),
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        // One or the other, never both: the HUD is what the composer is doing
        // right now, and a row of send-immediately chips under it would be a
        // second thing to tap by accident.
        when (accessory) {
            ComposerAccessory.HUD -> CommandSkillHud(
                commands = commands,
                draft = draft,
                onSelect = onSelectCommand,
                onClose = onCloseHud,
            )

            ComposerAccessory.CHIPS -> PredictiveChipsRow(chips = chips, onSelect = onSelectChip)

            ComposerAccessory.NONE -> Unit
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            TouchTarget(
                onClick = onTogglePlus,
                contentDescription = if (plusOpen) "Close" else "More",
            ) {
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .chromeCapsule()
                        .then(
                            if (plusOpen) {
                                Modifier.background(MaterialTheme.colorScheme.onSurface, CircleShape)
                            } else {
                                Modifier
                            },
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = null,
                        tint = if (plusOpen) {
                            MaterialTheme.colorScheme.surface
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                        modifier = Modifier
                            .size(22.dp)
                            .graphicsLayer { rotationZ = turn.value },
                    )
                }
            }

            Row(
                modifier = Modifier
                    .weight(1f)
                    .chromeCapsule()
                    .heightIn(min = MIN_TOUCH_TARGET),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                // The way into the HUD that does not start with typing. iOS draws
                // the `command` glyph here; Android's core icon set has no
                // counterpart, and the character the feature is named after says
                // it better than a borrowed symbol would.
                TouchTarget(
                    onClick = onToggleHud,
                    contentDescription = "Slash commands",
                    modifier = Modifier.semantics {
                        stateDescription = if (accessory == ComposerAccessory.HUD) {
                            "Expanded"
                        } else {
                            "Collapsed"
                        }
                    },
                ) {
                    Text(
                        text = "/",
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        color = if (accessory == ComposerAccessory.HUD) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            secondaryTint
                        },
                    )
                }

                Box(
                    modifier = Modifier
                        .weight(1f)
                        .padding(top = 13.dp, bottom = 13.dp),
                ) {
                    if (draft.isEmpty()) {
                        Text(
                            text = if (dictationListening) "Listening…" else "Ask $name",
                            fontSize = 17.sp,
                            color = secondaryTint,
                        )
                    }
                    BasicTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        // Partials rebuild from a frozen base; prevent competing
                        // edits without dimming the text.
                        readOnly = dictationLocked,
                        maxLines = 5,
                        textStyle = LocalTextStyle.current.copy(
                            fontSize = 17.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
                        // Software keyboards have no Shift+Return, so their Return key
                        // is a send — which is what the Send action promises.
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { onSend() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            // Return sends, Shift+Return breaks the line — the shape
                            // every chat app has on a hardware keyboard.
                            .onPreviewKeyEvent { event ->
                                val isReturn = event.key == Key.Enter || event.key == Key.NumPadEnter
                                if (event.type == KeyEventType.KeyDown && isReturn && !event.isShiftPressed) {
                                    onSend()
                                    true
                                } else {
                                    false
                                }
                            },
                    )
                }

                TouchTarget(
                    onClick = onToggleDictation,
                    contentDescription = if (dictationListening) {
                        "Stop dictation"
                    } else {
                        "Start dictation"
                    },
                ) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .background(
                                if (dictationListening) {
                                    Color.Red.copy(alpha = 0.2f)
                                } else {
                                    secondaryTint.copy(alpha = 0.12f)
                                },
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_mic),
                            contentDescription = null,
                            tint = if (dictationListening) Color.Red else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }

                TouchTarget(onClick = onSend, enabled = canSend) {
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .background(
                                if (canSend) BubbleColor.mine else secondaryTint.copy(alpha = 0.18f),
                                CircleShape,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Send",
                            tint = if (canSend) BubbleColor.mineText else secondaryTint,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}
