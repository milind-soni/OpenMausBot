package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.openmausbot.companion.R
import com.openmausbot.companion.audio.CallSpeaker
import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.Chat
import com.openmausbot.companion.core.Message
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Call mode — the bot on the line, on the phone. The port of
 * `ios/App/CallView.swift`, and deliberately HALF-DUPLEX for the same reason:
 * the microphone is live only while the bot is not speaking. Interrupting is
 * a tap instead.
 *
 * Turn-taking is the silence endpointer in [com.openmausbot.companion.dictation.SpeechDictation.listenForTurn]:
 * the turn ends [CallRules.ENDPOINT_GAP_MILLIS] after the transcript last
 * changed. Waiting is narrated — every activity chip the harness phrases for
 * a voice is read as it lands — so an agent turn of tool calls sounds like
 * someone working rather than a dropped call. Approvals and questions are
 * announced, not answered by voice; answering them happens in the chat.
 */
@Composable
internal fun CallScreen(bot: Bot, onDismiss: () -> Unit) {
    val environment = LocalCompanion.current
    val session = environment.session
    val microphone = environment.dictation
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val speaker = remember { CallSpeaker(context) }
    val state by session.state.collectAsState()
    val current = state.bot(bot.id) ?: bot
    val messages = remember(state, current.threadId) { state.visibleTranscript(current.threadId) }
    val transcript by microphone.transcript.collectAsState()
    val microphoneError by microphone.error.collectAsState()
    val speaking by speaker.isSpeaking.collectAsState()

    var phase by remember { mutableStateOf(CallPhase.LISTENING) }
    var note by remember { mutableStateOf<String?>(null) }
    // Everything already on screen when the call starts has been read or
    // ignored — a call must not open by reciting the backlog.
    val spokenIds = remember { mutableSetOf<String>() }
    val announcedRequests = remember { mutableSetOf<String>() }
    var started by remember { mutableStateOf(false) }
    var sayGeneration by remember { mutableStateOf(0) }

    fun listen() {
        phase = CallPhase.LISTENING
        note = null
        microphone.listenForTurn(CallRules.ENDPOINT_GAP_MILLIS) { heard ->
            val said = heard.trim()
            if (said.isEmpty()) {
                listen()
            } else {
                phase = CallPhase.SENDING
                scope.launch { session.send(said, Chat.BotChat(current)) }
            }
        }
    }

    /**
     * Speak with the microphone closed, then return whether this call is
     * still the one that asked (an interrupt or hang-up bumps the generation).
     */
    suspend fun say(text: String): Boolean {
        sayGeneration += 1
        val mine = sayGeneration
        phase = CallPhase.SPEAKING
        microphone.stop()
        return try {
            val prepared = session.prepareSpeech(text, current.voice)
            if (!prepared.ready) {
                note = CallRules.noVoiceNote(current.name)
                return sayGeneration == mine
            }
            val clips = ArrayList<ByteArray>(prepared.utterances.size)
            for (utterance in prepared.utterances) {
                if (sayGeneration != mine) return false
                clips += session.speak(utterance, current.voice)
            }
            if (sayGeneration != mine) return false
            speaker.speak(clips) && sayGeneration == mine
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            note = error.message ?: "Couldn't speak that."
            sayGeneration == mine
        }
    }

    fun sayThenListen(text: String) {
        scope.launch {
            val stillMine = say(text)
            if (stillMine && phase == CallPhase.SPEAKING) listen()
        }
    }

    LaunchedEffect(Unit) {
        if (started) return@LaunchedEffect
        started = true
        spokenIds += messages.map { it.id }
        if (current.busy == true) phase = CallPhase.WORKING else listen()
    }

    LaunchedEffect(messages, current.busy) {
        if (!started) return@LaunchedEffect
        val fresh = messages.filter { it.id !in spokenIds }
        spokenIds += fresh.map { it.id }
        val pendingCard = messages.lastOrNull { it.card?.isPending == true }
        when (val action = CallRules.react(
            name = current.name,
            fresh = fresh,
            pendingCard = pendingCard,
            announced = announcedRequests,
            phase = phase,
            busy = current.busy == true,
            speakerSpeaking = speaking,
        )) {
            is CallAction.Announce -> {
                pendingCard?.card?.requestId?.let { announcedRequests += it }
                sayThenListen(action.text)
            }
            is CallAction.SayReply -> sayThenListen(action.text)
            is CallAction.SayChip -> scope.launch {
                val stillMine = say(action.text)
                if (stillMine && phase == CallPhase.SPEAKING) phase = CallPhase.WORKING
            }
            CallAction.StopListeningAndWork -> {
                microphone.stop()
                phase = CallPhase.WORKING
            }
            CallAction.Listen -> listen()
            CallAction.None -> Unit
        }
    }

    LaunchedEffect(microphoneError) { microphoneError?.let { note = it } }

    fun hangUp() {
        sayGeneration += 1
        microphone.stop()
        speaker.stop()
        onDismiss()
    }

    fun interrupt() {
        if (phase != CallPhase.SPEAKING) return
        sayGeneration += 1
        speaker.stop()
        listen()
    }

    DisposableEffect(Unit) {
        onDispose {
            microphone.stop()
            speaker.stop()
        }
    }

    Dialog(
        onDismissRequest = ::hangUp,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        BackHandler { hangUp() }
        val tint = Color(MausPalette.argb(current.color))
        val pulse = rememberInfiniteTransition(label = "speaking")
        val breathe by pulse.animateFloat(
            initialValue = 1f,
            targetValue = 1.06f,
            animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
            label = "breathe",
        )
        val (leftIcon, leftLabel, leftEnabled) = Triple(R.drawable.ic_pan_tool, "Interrupt and speak", phase == CallPhase.SPEAKING)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .background(tint.copy(alpha = 0.18f))
                .systemBarsPadding(),
        ) {
            Column(
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Spacer(Modifier.weight(1f))
                BotAvatar(
                    bot = current,
                    size = 160.dp,
                    state = if (phase == CallPhase.SPEAKING) MausState.HAPPY else MausState.forChat(Chat.BotChat(current), messages.lastOrNull()),
                    contentDescription = "${current.name} avatar",
                    modifier = Modifier.graphicsLayer {
                        val scale = if (phase == CallPhase.SPEAKING) breathe else 1f
                        scaleX = scale
                        scaleY = scale
                    },
                )
                Text(text = current.name, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
                Text(text = CallRules.phaseText(phase, current.name), fontSize = 17.sp, color = secondaryTint)
                if (transcript.isNotEmpty() && phase == CallPhase.LISTENING) {
                    Text(
                        text = transcript,
                        fontSize = 17.sp,
                        textAlign = TextAlign.Center,
                        maxLines = 4,
                        modifier = Modifier.padding(horizontal = 28.dp),
                    )
                }
                note?.let {
                    Text(
                        text = it,
                        fontSize = 14.sp,
                        color = Color(0xFFFF9800),
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 28.dp),
                    )
                }
                Spacer(Modifier.weight(1f))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(40.dp),
                    modifier = Modifier.padding(bottom = 36.dp),
                ) {
                    TouchTarget(
                        onClick = ::interrupt,
                        enabled = leftEnabled,
                        size = 68.dp,
                        contentDescription = leftLabel,
                        modifier = Modifier.graphicsLayer { alpha = if (leftEnabled) 1f else 0.35f },
                    ) {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(secondaryTint.copy(alpha = 0.18f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(leftIcon),
                                contentDescription = null,
                                modifier = Modifier.size(26.dp),
                            )
                        }
                    }
                    TouchTarget(onClick = ::hangUp, size = 68.dp, contentDescription = "End call") {
                        Box(
                            modifier = Modifier
                                .size(68.dp)
                                .background(Color(0xFFD94B52), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.ic_call_end),
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(28.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
