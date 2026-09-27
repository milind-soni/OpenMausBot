package com.openmausbot.companion.audio

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.openmausbot.companion.core.LiveCallStart
import com.openmausbot.companion.core.LiveCallState
import com.openmausbot.companion.core.LiveCallStatus
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.ui.LiveCallRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Asks for the microphone; `MicPermissionController.ensure` in production. */
fun interface MicrophoneAccess {
    fun ensure(onResult: (Boolean) -> Unit)
}

/**
 * This phone's side of a Live call, app-scoped like [VoiceNotePlayer]: the
 * chat screen is disposed when Computer is pushed or the roster returns, and
 * a call must survive both. The computer owns the conversation (delegation,
 * approvals, the idle hang-up); this owns media, captions and the local
 * controls, and it is the one thing that sends `session.close` to OpenAI.
 *
 * The bar says "Connecting…" until the computer reports the call attached
 * and this phone's data channel is open; the clock counts from that moment,
 * on this phone's clock. After Hang up it says "Hanging up…" until the
 * computer confirms the end. An ended call keeps its reason in the bar, with
 * Try again only after a drop or a failed start. Losing the pairing hangs the
 * call up at once; switching to another computer leaves it behind.
 *
 * Ends on process `ON_STOP` ([androidx.lifecycle.ProcessLifecycleOwner],
 * 700 ms debounced), never the Activity's: rotation recreates MainActivity
 * (the manifest declares no `configChanges`) and must not hang up.
 *
 * **Main-thread confined.** Lifecycle callbacks and the computer's frames
 * arrive on [scope] (`Dispatchers.Main.immediate` in production); WebRTC's
 * own threads deliver [LiveCallTransport.Listener] callbacks, which hop onto
 * [scope] before touching anything. So the fields below need no locking, and
 * a test drives the whole machine on a TestScope.
 */
class LiveCallManager internal constructor(
    private val api: LiveCallApi,
    private val scope: CoroutineScope,
    private val transports: LiveCallTransportFactory,
    private val audio: LiveCallAudioRoute,
    private val preferences: LiveCallPreferences,
    /** This phone's clock, epoch ms: the bar's clock counts from the moment the call went live on it. */
    private val clock: () -> Long = System::currentTimeMillis,
) : DefaultLifecycleObserver {

    constructor(context: Context, session: Session, scope: CoroutineScope) : this(
        api = SessionLiveCallApi(session),
        scope = scope,
        transports = LiveCallTransportFactory { WebRtcLiveCallTransport(context) },
        audio = AndroidLiveCallAudioRoute(context),
        preferences = SharedLiveCallPreferences(context),
    )

    private val _state = MutableStateFlow(LiveCallSnapshot(speaker = preferences.speaker))
    val state: StateFlow<LiveCallSnapshot> = _state.asStateFlow()

    /** The media of the call in progress; null between calls. Identity doubles as "is this attempt still wanted". */
    private var transport: LiveCallTransport? = null

    /** The computer has reported our call at least once; from then on "no call" means it is gone. */
    private var seenOnServer = false

    /** The computer has said its side of our call reached OpenAI: `live`, or any later word short of `ended`. */
    private var attached = false

    /** Our `oai-events` data channel is open. */
    private var channelOpen = false

    /** Bumped by every [start]: the generation guard for a microphone answer that outlives its attempt. */
    private var attempts = 0

    /**
     * The computer's latest report, whatever it was about. A frame about this
     * phone's call can beat the 201 that names it; [connect] reads it again
     * once the id is known.
     */
    private var lastServerCall: LiveCallState? = null

    /** The id of the last call the computer created for this phone, kept across attempts: a 409 naming it is our own call winding down. */
    private var lastCallId: String? = null

    /** Ends the call if its audio never connects ([armConnectDeadline]); null when no call is waiting on its audio. */
    private var connectDeadline: Job? = null

    /** Stops "Hanging up…" waiting for a computer that never answers ([END_TIMEOUT_MS]). */
    private var endDeadline: Job? = null

    /** The computer this phone follows and whether its pairing stands; null before the first report. */
    private var link: LiveCallLink? = null

    init {
        scope.launch { api.serverCall.collect { onServerCall(it) } }
        scope.launch { api.link.collect { onLink(it) } }
    }

    /**
     * Before this phone's first Live call the chat says what a call sends to
     * OpenAI, with Start call and Cancel: a phone has no Live switch, so its
     * first call is where Live is turned on. Due until [acceptDisclosure].
     */
    val disclosureDue: Boolean get() = !preferences.disclosureShown

    /** The person chose Start call on the disclosure: not shown on this phone again. Cancel records nothing. */
    fun acceptDisclosure() {
        preferences.disclosureShown = true
    }

    /** Start a call on [threadId]. Ignored while one is starting, running or hanging up. */
    fun start(botId: String, threadId: String, botName: String, microphone: MicrophoneAccess) {
        if (_state.value.active) return
        val attempt = ++attempts
        _state.value = LiveCallSnapshot(
            phase = LiveCallPhase.STARTING,
            botId = botId,
            threadId = threadId,
            botName = botName,
            speaker = preferences.speaker,
        )
        microphone.ensure { granted ->
            // The system sheet can outlast the attempt: leaving the app under
            // it ends the call, and a late answer must not start it again
            // (Try again asks anew) nor connect a later attempt a second time.
            if (attempt != attempts || _state.value.phase != LiveCallPhase.STARTING) return@ensure
            if (!granted) {
                // Settings has to change first: no Try again.
                settle(LiveCallRules.MIC_DENIED_MESSAGE, canRetry = false)
                return@ensure
            }
            scope.launch { connect() }
        }
    }

    /** Start again on the chat the last call was on, where the bar offers Try again. */
    fun retry(microphone: MicrophoneAccess) {
        val last = _state.value
        if (last.phase != LiveCallPhase.ENDED || !last.canRetry) return
        val botId = last.botId ?: return
        val threadId = last.threadId ?: return
        _state.value = LiveCallSnapshot(speaker = preferences.speaker)
        start(botId, threadId, last.botName, microphone)
    }

    /**
     * The person hangs up. OpenAI is told and the media released at once. If
     * the computer has named the call, the bar says "Hanging up…" until it
     * confirms the end (its answer, an `ended` frame, or [END_TIMEOUT_MS]),
     * then goes; the call's id stays so the computer's `ending` echo of it
     * still reads as this phone's call, not another device's. Before the
     * computer named it there is nothing to wait for, and the bar goes now.
     */
    fun hangUp() {
        val current = _state.value
        if (!current.holdsMedia) return
        releaseMedia(tellOpenAi = true)
        val callId = current.callId
        if (callId == null) {
            // A 201 that lands later is ended by [connect].
            _state.value = LiveCallSnapshot(speaker = preferences.speaker)
            return
        }
        _state.value = current.copy(phase = LiveCallPhase.ENDING, caption = "", heard = "")
        endDeadline = scope.launch {
            delay(END_TIMEOUT_MS)
            finishEnding(callId)
        }
        scope.launch {
            api.end(callId)
            finishEnding(callId)
        }
    }

    fun setMuted(muted: Boolean) {
        transport?.setMuted(muted)
        _state.update { it.copy(muted = muted) }
    }

    /** Speaker or earpiece: this phone's own choice, remembered for the next call and the next launch. */
    fun setSpeaker(speaker: Boolean) {
        preferences.speaker = speaker
        if (_state.value.holdsMedia) audio.setSpeaker(speaker)
        _state.update { it.copy(speaker = speaker) }
    }

    /** Clear the notice of a call that ended, keeping its id for the same reason [hangUp] does. */
    fun dismiss() {
        val current = _state.value
        if (current.phase == LiveCallPhase.ENDED) {
            _state.value = LiveCallSnapshot(callId = current.callId, speaker = preferences.speaker)
        }
    }

    /** The app left the foreground or the screen locked: the call ends (background calls are a later feature). Not a drop: no Try again. */
    override fun onStop(owner: LifecycleOwner) {
        if (!_state.value.holdsMedia) return
        endLocally(LiveCallRules.CALL_ENDED, tellComputer = true, canRetry = false)
    }

    private suspend fun connect() {
        val target = _state.value
        val botId = target.botId ?: return
        val threadId = target.threadId ?: return
        val media = transports.create()
        transport = media
        seenOnServer = false
        attached = false
        channelOpen = false
        audio.begin(speaker = target.speaker) {
            // Another app took the audio: the call ended, it did not drop.
            scope.launch { if (transport === media) endLocally(LiveCallRules.FOCUS_LOST_MESSAGE, tellComputer = true, canRetry = false) }
        }
        val offer = try {
            media.offer(listenerFor(media))
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            // A hang-up closes the transport under a pending offer, which then
            // fails on purpose: that attempt is already over, quietly. Anything
            // else is this phone's media, worded like a rejected answer.
            if (transport === media) settle(LiveCallRules.AUDIO_FAILED_MESSAGE)
            return
        }
        // Hung up while the offer was being built: nothing reached the computer.
        if (transport !== media) return
        val started = try {
            api.start(botId, threadId, offer)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (transport === media) settle(error.message?.takeIf { it.isNotBlank() } ?: LiveCallRules.START_FAILED_MESSAGE)
            return
        }
        if (started is LiveCallStart.Started) lastCallId = started.call.callId
        if (transport !== media) {
            // Hung up, backgrounded or signed out while the computer was
            // creating the session: release what it created, and leave the
            // bar as that left it. The id is recorded first so the
            // computer's echo of it reads as ours.
            if (started is LiveCallStart.Started) {
                _state.update { if (!it.active && it.callId == null) it.copy(callId = started.call.callId) else it }
                scope.launch { api.end(started.call.callId) }
            }
            return
        }
        when (started) {
            // Only the computer can take a key: no Try again.
            is LiveCallStart.NeedsKey -> settle(LiveCallRules.NEEDS_KEY_MESSAGE, canRetry = false)
            is LiveCallStart.Busy -> if (started.activeCall.callId == lastCallId) {
                // This phone's previous call, which the computer is still
                // winding down: not another device's, and in a moment Try
                // again works. Its id goes back on the snapshot so the bar
                // does not show it as a call on another phone either.
                settle(LiveCallRules.LAST_CALL_ENDING)
                _state.update { it.copy(callId = lastCallId) }
            } else {
                // Another device holds the line: it has to hang up first.
                settle(LiveCallRules.busyMessage(started.activeCall), canRetry = false)
            }
            is LiveCallStart.Started -> {
                _state.update { it.copy(callId = started.call.callId) }
                // The computer created the session but could not attach its
                // side, and says so in the 201 itself: there is no call to join.
                if (started.call.status == LiveCallStatus.ENDED) {
                    settle(noticeFor(started.call), canRetry = started.call.dropped)
                    return
                }
                if (started.call.attached) attached = true
                // A frame about this call that beat the 201 was passed over
                // (no id yet); read the latest one again now that there is.
                applyServerCall(lastServerCall)
                if (transport !== media) return
                // Armed as the answer goes in rather than after: CONNECTED can
                // only follow the answer, so its report always finds the deadline.
                armConnectDeadline(media)
                try {
                    media.accept(started.answerSdp)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    if (transport === media) {
                        // The computer holds a session this phone can never use: release it.
                        scope.launch { api.end(started.call.callId) }
                        settle(LiveCallRules.AUDIO_FAILED_MESSAGE)
                    }
                    return
                }
                if (transport !== media) return
                media.setMuted(_state.value.muted)
                goLiveIfReady()
            }
        }
    }

    /**
     * [media]'s callbacks. A WebRTC thread delivers them and [scope] runs them
     * later, when a hang-up may have closed [media] and a new call begun: each
     * acts only while [media] is still this phone's transport.
     */
    private fun listenerFor(media: LiveCallTransport): LiveCallTransport.Listener = object : LiveCallTransport.Listener {
        override fun onMessage(text: String) {
            val event = LiveCaptions.parse(text) ?: return
            scope.launch {
                if (transport !== media) return@launch
                if (event.type == "session.closed") {
                    // The computer's `ended` frame usually follows with its own
                    // reason; see the ENDED branch of [applyServerCall].
                    val end = LiveCallRules.endNotice(event.reason)
                    endLocally(end.text, tellComputer = true, canRetry = end.dropped)
                    return@launch
                }
                val current = _state.value
                val (caption, heard) = LiveCaptions.apply(current.caption, current.heard, event)
                _state.update { it.copy(caption = caption, heard = heard) }
            }
        }

        override fun onConnected() {
            scope.launch { if (transport === media) clearConnectDeadline() }
        }

        override fun onChannelOpen() {
            scope.launch {
                if (transport !== media) return@launch
                channelOpen = true
                // The channel rides the call's own connection: its audio got through.
                clearConnectDeadline()
                goLiveIfReady()
            }
        }

        override fun onDropped() {
            scope.launch { if (transport === media) endLocally(LiveCallRules.CALL_DROPPED, tellComputer = true, canRetry = true) }
        }
    }

    /**
     * Ends the call as dropped unless [media] reports CONNECTED (or its
     * channel opens) within [MEDIA_CONNECT_TIMEOUT_MS]. Every other end
     * cancels it ([releaseMedia]), and it acts only while [media] is still
     * this phone's transport, so it can end no call but the one it was armed for.
     */
    private fun armConnectDeadline(media: LiveCallTransport) {
        clearConnectDeadline()
        connectDeadline = scope.launch {
            delay(MEDIA_CONNECT_TIMEOUT_MS)
            connectDeadline = null
            if (transport === media) endLocally(LiveCallRules.AUDIO_TIMEOUT_MESSAGE, tellComputer = true, canRetry = true)
        }
    }

    private fun clearConnectDeadline() {
        connectDeadline?.cancel()
        connectDeadline = null
    }

    private fun onServerCall(call: LiveCallState?) {
        lastServerCall = call
        applyServerCall(call)
    }

    /** What the computer's word about the line means for this phone's call, phase by phase. */
    private fun applyServerCall(call: LiveCallState?) {
        val current = _state.value
        val ours = current.callId ?: return
        when (current.phase) {
            LiveCallPhase.STARTING, LiveCallPhase.LIVE -> when {
                call?.callId == ours -> {
                    seenOnServer = true
                    if (call.status == LiveCallStatus.ENDED) {
                        endLocally(noticeFor(call), tellComputer = false, canRetry = call.dropped)
                    } else {
                        if (call.attached) attached = true
                        goLiveIfReady()
                    }
                }
                // The computer restarted, or forgot the call, while this phone
                // was on the line. The desktop and the iPhone say "Call ended."
                // too, and it is not a drop.
                call == null && seenOnServer -> endLocally(LiveCallRules.CALL_ENDED, tellComputer = false, canRetry = false)
                // Another call altogether: not ours to act on.
            }
            LiveCallPhase.ENDING ->
                if (call == null || (call.callId == ours && call.status == LiveCallStatus.ENDED)) finishEnding(ours)
            LiveCallPhase.ENDED ->
                // Why the computer ended it, after this phone's data channel had
                // already stopped it with a plain "Call ended." (the idle
                // hang-up, say): the computer's reason replaces it, and says
                // whether it was a drop. A drop the phone saw itself stays a
                // drop, whatever its own end request made the computer record.
                if (current.notice == LiveCallRules.CALL_ENDED && call?.callId == ours && call.status == LiveCallStatus.ENDED) {
                    _state.update { it.copy(notice = noticeFor(call), canRetry = call.dropped) }
                }
            LiveCallPhase.IDLE -> Unit
        }
    }

    /** Live once the computer's side is attached and the data channel is open; the clock starts now. */
    private fun goLiveIfReady() {
        val current = _state.value
        if (current.phase != LiveCallPhase.STARTING || current.callId == null || !attached || !channelOpen) return
        _state.value = current.copy(phase = LiveCallPhase.LIVE, liveSince = clock())
    }

    /** The computer confirmed the hang-up of [callId] (or never answered): the bar goes. */
    private fun finishEnding(callId: String) {
        val current = _state.value
        if (current.phase != LiveCallPhase.ENDING || current.callId != callId) return
        endDeadline?.cancel()
        endDeadline = null
        _state.value = LiveCallSnapshot(callId = callId, speaker = preferences.speaker)
    }

    /**
     * A call belongs to the computer and the pairing it started under. When
     * the pairing goes (unpaired, signed out, the token refused), the call is
     * hung up at once and the bar says why, with no Try again: the computer
     * may no longer hear this phone, and a new call would be refused. When
     * the phone moves to another computer, the call, or its notice, stays
     * behind with the last one.
     */
    private fun onLink(next: LiveCallLink) {
        val previous = link
        link = next
        if (previous == null) return
        when {
            previous.signedIn && !next.signedIn ->
                if (_state.value.holdsMedia) endLocally(LiveCallRules.SIGNED_OUT_MESSAGE, tellComputer = true, canRetry = false)
            next.computerId != null && next.computerId != previous.computerId -> leaveComputer()
        }
    }

    /** Quietly, as a deliberate switch should: OpenAI is told, the new computer is not asked about the old one's call. */
    private fun leaveComputer() {
        val current = _state.value
        if (current.phase == LiveCallPhase.IDLE && current.callId == null) return
        if (current.holdsMedia) releaseMedia(tellOpenAi = true)
        endDeadline?.cancel()
        endDeadline = null
        _state.value = LiveCallSnapshot(speaker = preferences.speaker)
    }

    /** The attempt is over before media flowed; keep the bar up with the reason. A failed start offers Try again unless [canRetry] says otherwise. */
    private fun settle(notice: String, canRetry: Boolean = true) {
        releaseMedia(tellOpenAi = false)
        _state.update { it.copy(phase = LiveCallPhase.ENDED, notice = notice, canRetry = canRetry, caption = "", heard = "") }
    }

    /**
     * The call is over: close the media, tell OpenAI, tell the computer unless
     * it told us, keep the bar up with the reason. [canRetry]: only a drop
     * offers Try again (the desktop's `canRetry: notice.dropped`).
     */
    private fun endLocally(notice: String, tellComputer: Boolean, canRetry: Boolean) {
        val callId = _state.value.callId
        releaseMedia(tellOpenAi = true)
        if (tellComputer && callId != null) scope.launch { api.end(callId) }
        _state.update { it.copy(phase = LiveCallPhase.ENDED, notice = notice, canRetry = canRetry) }
    }

    private fun releaseMedia(tellOpenAi: Boolean) {
        clearConnectDeadline()
        val media = transport
        transport = null
        if (media != null) {
            if (tellOpenAi) media.sendClose()
            media.close()
        }
        audio.end()
    }

    /** The computer's own words when it sent some, its reason's words otherwise. */
    private fun noticeFor(call: LiveCallState): String =
        call.error?.takeIf { it.isNotBlank() } ?: LiveCallRules.endNotice(call.endReason).text

    companion object {
        /**
         * How long the call's audio has to connect once the answer goes in. A
         * reachable path connects within seconds; past this the call ends as
         * dropped rather than staying up, and billing on the computer's
         * OpenAI key, until the computer's idle hang-up minutes later.
         */
        const val MEDIA_CONNECT_TIMEOUT_MS = 20_000L

        /**
         * How long "Hanging up…" waits for the computer's word, as on the
         * iPhone: longer than the harness's own close window (it gives OpenAI
         * 5 s to confirm the close) plus a round trip, so a slow close still
         * ends on the computer's answer and a lost one still clears the bar.
         */
        const val END_TIMEOUT_MS = 8_000L
    }
}

/**
 * The computer's side reached OpenAI: `live`, or any later word short of
 * `ended` — `ending`, or a status this build does not know, which counts as
 * a call still running.
 */
private val LiveCallState.attached: Boolean
    get() = status != LiveCallStatus.CONNECTING && status != LiveCallStatus.ENDED

/** The computer ended the call as a drop (its reason, as the desktop reads it): only then does the bar offer Try again. */
private val LiveCallState.dropped: Boolean
    get() = LiveCallRules.endNotice(endReason).dropped
