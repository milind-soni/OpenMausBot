package com.openmausbot.chief

import android.app.Application
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.openmausbot.chief.data.ApiException
import com.openmausbot.chief.data.Bot
import com.openmausbot.chief.data.ConnectionStore
import com.openmausbot.chief.data.Fleet
import com.openmausbot.chief.data.Message
import com.openmausbot.chief.data.NotificationPayload
import com.openmausbot.chief.data.OpenMausApi
import com.openmausbot.chief.data.PairedSession
import com.openmausbot.chief.data.PairingInvite
import com.openmausbot.chief.data.PushTokenSync
import com.openmausbot.chief.data.Routine
import com.openmausbot.chief.data.RoutineRun
import com.openmausbot.chief.data.WireJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.sse.EventSource
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.UnknownHostException

data class MausUiState(
    val session: PairedSession? = null,
    val pendingInvite: PairingInvite? = null,
    val pairing: Boolean = false,
    val loading: Boolean = false,
    val live: Boolean = false,
    val error: String? = null,
    val fleet: Fleet = Fleet(),
    val routines: List<Routine> = emptyList(),
    val routineRuns: List<RoutineRun> = emptyList(),
    val selectedBotId: String? = null,
    val computerBotId: String? = null,
    val screenPng: ByteArray? = null,
    val screenError: String? = null,
)

/** Cancellation is control flow, not a failure the user can act on. */
internal fun userFacingFailureMessage(failure: Throwable): String {
    var current: Throwable? = failure
    val visited = mutableSetOf<Throwable>()
    var connectionFailure = false
    while (current != null && visited.add(current)) {
        if (current is CancellationException) throw current
        if (current is UnknownHostException || current is ConnectException || current is NoRouteToHostException) {
            connectionFailure = true
        }
        current = current.cause
    }
    if (connectionFailure) {
        return "Could not reach Agent Centipede. Make sure the computer is awake and the desktop app is running."
    }
    return failure.message?.takeIf { it.isNotBlank() }
        ?: "Could not reach Agent Centipede. Make sure the computer is awake and the app is running."
}

class MausViewModel(application: Application) : AndroidViewModel(application) {
    private val store = ConnectionStore(application)
    private val mutable = MutableStateFlow(MausUiState(session = store.load()))
    val state: StateFlow<MausUiState> = mutable.asStateFlow()
    private var api: OpenMausApi? = null
    private var events: EventSource? = null
    private var refreshJob: Job? = null
    private var screenRefreshJob: Job? = null
    private var cursor: String? = null
    init { mutable.value.session?.let(::connect) }

    fun acceptInvite(raw: String) {
        val invite = PairingInvite.parse(raw)
        mutable.update { it.copy(pendingInvite = invite, error = if (invite == null) "That is not a valid Agent Centipede pairing code." else null) }
    }

    fun manualInvite(address: String, code: String) {
        val invite = PairingInvite.manual(address, code)
        mutable.update { it.copy(pendingInvite = invite, error = if (invite == null) "Check the computer address and six-digit code." else null) }
    }

    fun cancelInvite() = mutable.update { it.copy(pendingInvite = null, error = null) }

    fun pair(deviceName: String) {
        val invite = mutable.value.pendingInvite ?: return
        if (mutable.value.pairing) return
        viewModelScope.launch {
            mutable.update { it.copy(pairing = true, error = null) }
            runCatching { OpenMausApi.pair(invite, deviceName) }
                .onSuccess { paired ->
                    store.save(paired.connection, paired.token)
                    mutable.value = MausUiState(session = paired, loading = true)
                    connect(paired)
                }
                .onFailure { failure -> mutable.update { it.copy(pairing = false, error = userFacingFailureMessage(failure)) } }
        }
    }

    fun refresh() = viewModelScope.launch { hydrate(showSpinner = true) }

    fun selectBot(id: String?) {
        mutable.update { it.copy(selectedBotId = id) }
        if (id != null) viewModelScope.launch {
            api?.markRead(id)
            mutable.update { current -> current.copy(fleet = current.fleet.copy(bots = current.fleet.bots.map { if (it.id == id) it.copy(unread = false) else it })) }
        }
    }

    fun send(botId: String, text: String) {
        if (text.isBlank()) return
        viewModelScope.launch { action { api?.send(botId, text.trim()) }; scheduleRefresh(300) }
    }

    fun interrupt(botId: String) = viewModelScope.launch { action { api?.interrupt(botId) }; scheduleRefresh(200) }

    fun answer(bot: Bot, message: Message, choice: String) {
        val card = message.card ?: return
        val requestId = card.requestId ?: return
        viewModelScope.launch {
            action { api?.respond(bot.threadId, requestId, choice, card.tool != null) }
            scheduleRefresh(150)
        }
    }

    /** Kept as a separate entry point so UI gates can authenticate first. */
    fun answerAfterAuthentication(bot: Bot, message: Message, choice: String) = answer(bot, message, choice)

    fun setRoutineEnabled(routine: Routine, enabled: Boolean) = viewModelScope.launch {
        action { api?.setRoutineEnabled(routine.id, enabled) }
        hydrate(showSpinner = false)
    }

    fun runRoutine(routine: Routine) = viewModelScope.launch {
        action { api?.runRoutine(routine.id) }
        hydrate(showSpinner = false)
    }

    fun setReportingMode(bot: Bot, mode: String) = viewModelScope.launch {
        if (mode !in setOf("all", "actionable", "silent")) return@launch
        action { api?.setReportingMode(bot.id, mode) }
        hydrate(showSpinner = false)
    }

    fun openComputer(botId: String?) {
        screenRefreshJob?.cancel()
        screenRefreshJob = null
        mutable.update { it.copy(computerBotId = botId, screenPng = null, screenError = null) }
        restartEvents(screens = botId != null)
        if (botId != null) startScreenRefresh(botId)
    }

    fun dismissError() = mutable.update { it.copy(error = null) }

    fun showError(message: String) = mutable.update { it.copy(error = message) }

    fun disconnect() {
        val active = api
        events?.cancel()
        events = null
        api = null
        viewModelScope.launch {
            runCatching { active?.revokePushToken() }
            store.clear()
            mutable.value = MausUiState()
        }
    }

    private fun connect(session: PairedSession) {
        api = OpenMausApi(session)
        PushTokenSync.register()
        viewModelScope.launch {
            hydrate(showSpinner = true)
            if (mutable.value.session != null) restartEvents(screens = false)
        }
    }

    private suspend fun hydrate(showSpinner: Boolean) {
        val active = api ?: return
        if (showSpinner) mutable.update { it.copy(loading = true, error = null) }
        runCatching {
            val fleet = active.fleet()
            val routines = active.routines()
            fleet to routines
        }.onSuccess { (fleet, routines) ->
            mutable.update { it.copy(loading = false, fleet = fleet, routines = routines.routines, routineRuns = routines.runs, error = null) }
        }.onFailure(::handleFailure)
    }

    private fun restartEvents(screens: Boolean) {
        events?.cancel()
        val active = api ?: return
        events = active.events(cursor, screens, onFrame = { kind, payload ->
            payload["seq"]?.jsonPrimitive?.content?.toIntOrNull()?.let { seq ->
                val stream = cursor?.substringBefore(':')
                if (stream != null) cursor = "$stream:$seq"
            }
            if (kind == "hello") cursor = payload["cursor"]?.jsonPrimitive?.content ?: cursor
            if (kind == "screen" && payload["botId"]?.jsonPrimitive?.content == mutable.value.computerBotId) {
                val png = payload["png"]?.jsonPrimitive?.content
                val bytes = png?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }
                if (bytes != null) mutable.update { it.copy(screenPng = bytes) }
            }
            if (kind == "notify") {
                val notification = payload["notification"]?.let { runCatching { WireJson.decodeFromJsonElement(NotificationPayload.serializer(), it) }.getOrNull() }
                if (notification != null) postNotification(notification)
            }
            if (kind != "hello" && kind != "screen") scheduleRefresh(500)
            mutable.update { it.copy(live = true) }
        }, onFailure = {
            mutable.update { it.copy(live = false) }
            viewModelScope.launch { delay(1_500); if (mutable.value.session != null) restartEvents(mutable.value.computerBotId != null) }
        })
    }

    private fun startScreenRefresh(botId: String) {
        screenRefreshJob = viewModelScope.launch {
            while (mutable.value.computerBotId == botId) {
                val active = api ?: break
                runCatching { active.computerScreenshot(botId) }
                    .onSuccess { frame ->
                        val bytes = runCatching { Base64.decode(frame.png, Base64.DEFAULT) }.getOrNull()
                        if (bytes != null && mutable.value.computerBotId == botId) {
                            mutable.update { it.copy(screenPng = bytes, screenError = null) }
                        } else if (mutable.value.computerBotId == botId) {
                            mutable.update { it.copy(screenError = "The computer sent an unreadable screen frame.") }
                        }
                    }
                    .onFailure { failure ->
                        if (failure is CancellationException) throw failure
                        if (mutable.value.computerBotId == botId) {
                            mutable.update { it.copy(screenError = userFacingFailureMessage(failure)) }
                        }
                    }
                delay(if (mutable.value.fleet.bots.find { it.id == botId }?.busy == true) 2_000 else 8_000)
            }
        }
    }

    private fun scheduleRefresh(delayMs: Long) {
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch { delay(delayMs); hydrate(showSpinner = false) }
    }

    private suspend fun action(block: suspend () -> Unit) {
        runCatching { block() }.onFailure(::handleFailure)
    }

    private fun handleFailure(failure: Throwable) {
        if (failure is ApiException && failure.status == 401) {
            store.clear()
            events?.cancel()
            api = null
            mutable.value = MausUiState(error = "This phone was revoked. Pair it again from Agent Centipede on your computer.")
        } else mutable.update { it.copy(loading = false, error = userFacingFailureMessage(failure)) }
    }

    private fun postNotification(payload: NotificationPayload) = getApplication<MausApplication>().showNotificationOnce(payload)

    override fun onCleared() {
        events?.cancel()
        screenRefreshJob?.cancel()
        super.onCleared()
    }
}
