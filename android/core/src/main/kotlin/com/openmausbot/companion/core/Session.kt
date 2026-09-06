package com.openmausbot.companion.core

import java.net.URI
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient

/**
 * Stream lifecycle, pairing restore, and actions — port of `ios/App/Session.swift`.
 *
 * Pure JVM: storage, device name, notifications, and HTTP are injected so the
 * state machine can be unit-tested with virtual time (`kotlinx-coroutines-test`).
 */
class Session(
    private val scope: CoroutineScope,
    private val connectionStore: ConnectionStore,
    private val tokenStore: TokenStore,
    /**
     * The durable first-pair education marker. Deliberately has no default: the
     * marker is only useful if it outlives the process, and a default would let
     * a wiring slip in `OpenMausApp` silently swap durability for an in-memory
     * boolean that dies with the app — the exact failure the marker exists to
     * prevent, and one no runtime assertion would ever notice.
     */
    private val onboardingStore: OnboardingStore,
    private val deviceNameProvider: () -> String,
    private val notificationSink: NotificationSink = NoOpNotificationSink,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val clientFactory: (Connection, String?) -> CompanionClient = { connection, token ->
        CompanionClient(connection, token, httpClient)
    },
    private val pairFn: suspend (Connection, String, String, String) -> PairingOutcome =
        { connection, credential, deviceName, pairRequestId ->
            CompanionClient.pairFirstReachable(
                connection = connection,
                credential = credential,
                deviceName = deviceName,
                pairRequestId = pairRequestId,
                client = httpClient,
            )
        },
    /** Test seam: override the SSE Flow without subclassing [CompanionClient]. */
    private val eventsFn: (CompanionClient, String?, Boolean) -> Flow<StreamFrame> = { client, since, screens ->
        client.events(since, screens)
    },
    /** Test seam: override fleet hydrate. */
    private val hydrateFn: suspend (CompanionClient, Int?) -> Fleet = { client, messages ->
        client.fleet(messages)
    },
    /** Test seam: override the engine list read for composer wording. */
    private val instancesFn: suspend (CompanionClient) -> List<Instance> = { client ->
        client.instances()
    },
    /** Test seam: override the authenticated endpoint snapshot. */
    private val metadataFn: suspend (CompanionClient) -> CompanionConnectionMetadata = { client ->
        client.connectionMetadata()
    },
    /** Test seam for the handoff between a completed transfer and its caller. */
    private val afterAttachmentDownload: suspend () -> Unit = {},
) {
    sealed interface Status {
        data object Unpaired : Status
        data object Connecting : Status
        data object Live : Status
        data object Unauthorized : Status
        data class Offline(val message: String) : Status
    }

    sealed interface RestoreState {
        data object Pending : RestoreState
        data object Ready : RestoreState
        data object Unpaired : RestoreState
    }

    private val _state = MutableStateFlow(CompanionState())
    val state: StateFlow<CompanionState> = _state.asStateFlow()

    /**
     * Engines that can take a message INTO a turn that is already running.
     * Loaded once per hydrate and only ever used to word the composer: an
     * empty set means "we do not know", and the wording falls back to the
     * weaker promise, which is the one that is always true.
     */
    private val _steeringInstanceIds = MutableStateFlow<Set<String>>(emptySet())
    val steeringInstanceIds: StateFlow<Set<String>> = _steeringInstanceIds.asStateFlow()

    private val _connection = MutableStateFlow<Connection?>(null)
    val connection: StateFlow<Connection?> = _connection.asStateFlow()

    private val _connections = MutableStateFlow<List<Connection>>(emptyList())
    /** All locally paired computers. Only [connection] has an active runtime. */
    val connections: StateFlow<List<Connection>> = _connections.asStateFlow()

    private val _status = MutableStateFlow<Status>(Status.Unpaired)
    val status: StateFlow<Status> = _status.asStateFlow()

    private val _restoreState = MutableStateFlow<RestoreState>(RestoreState.Pending)
    val restoreState: StateFlow<RestoreState> = _restoreState.asStateFlow()

    private val _actionError = MutableStateFlow<String?>(null)
    var actionError: String?
        get() = _actionError.value
        set(value) { _actionError.value = value }
    val actionErrorFlow: StateFlow<String?> = _actionError.asStateFlow()

    private val _focusedMessageId = MutableStateFlow<String?>(null)
    val focusedMessageId: StateFlow<String?> = _focusedMessageId.asStateFlow()

    private val _pairingInvite = MutableStateFlow<PairingInvite?>(null)
    val pairingInvite: StateFlow<PairingInvite?> = _pairingInvite.asStateFlow()

    private val _pairingRequested = MutableStateFlow(false)
    /** Pairing may be opened while the current computer stays live. */
    val pairingRequested: StateFlow<Boolean> = _pairingRequested.asStateFlow()

    private var registry = ConnectionRegistry()
    private var client: CompanionClient? = null
    private var token: String? = null
    private var rotation = CandidateRotation(emptyList())
    private var streamJob: Job? = null
    private var endpointRefreshJob: Job? = null
    private var streamGeneration = 0
    private var reconnectDelaySeconds: Long = 0
    private var screenWatchers = 0
    private val gate = Mutex()
    private val notificationGate = Mutex()
    private val attachmentDownloads = AttachmentDownloadCache(scope)
    private val restored = CompletableDeferred<Unit>()
    /** QR credentials authoritatively rejected or redeemed — never start a new request (§6). */
    private val spentQrCredentials = mutableSetOf<String>()

    /**
     * One pairing attempt at a time, plus the invite that arrived during it.
     *
     * [gate] already serialises the redemption, but it is a suspending Mutex and
     * a deep link lands synchronously on whatever thread delivered the Intent.
     * This monitor is the one both sides can hold, so "an attempt is in flight",
     * "an invite is waiting", and the published invite are read and written as a
     * single decision.
     */
    private val inviteLock = Any()
    private var pairingInFlight = false
    private var deferredInvite: PairingInvite? = null

    init {
        // No Exception other than cancellation leaves this launch: it is a root
        // coroutine with no caller to catch for it, so [restoreLocked] reports a
        // failed read instead of throwing it. An Error still propagates, on
        // purpose — a fatal one is not this boundary's to swallow.
        scope.launch {
            try {
                restore()
            } finally {
                restored.complete(Unit)
            }
        }
    }

    /** Wait until the launch-time restore attempt has finished (tests / connect). */
    suspend fun awaitRestored() {
        restored.await()
    }

    /** Rebuild the last connection at launch — three outcomes match iOS Keychain restore. */
    private suspend fun restore() = gate.withLock {
        restoreLocked()
    }

    /**
     * Redeem a one-time pairing credential. Persists only the long-lived device
     * token + connection — never the QR credential/code.
     *
     * A paired phone may add another computer. The active runtime is only
     * replaced after the new credential has committed; another [pair] still
     * cannot overlap this redeem+persist critical section.
     *
     * A route failure is retryable with the same in-memory request id because
     * it is either preflight-only or an ambiguous replay of the same logical
     * redemption. An authoritative response, or receiving the durable token,
     * burns a high-entropy QR before any local save. Six-digit codes remain
     * retryable for compatibility with manual pairing.
     *
     * This is also the one active attempt: from the moment it is marked in
     * flight until [settlePairingAttempt], a deep link waits in memory rather
     * than replacing the credential being redeemed.
     */
    suspend fun pair(
        connection: Connection,
        credential: String,
        pairRequestId: String = UUID.randomUUID().toString(),
    ) {
        awaitRestored()
        gate.withLock {
            if (pairingInFlight) throw PairingInProgressException()
            if (isQrCredential(credential) && credential in spentQrCredentials) {
                _actionError.value = SPENT_QR_MESSAGE
                clearInviteIfCredential(credential)
                throw SpentPairingCredentialException()
            }

            // From here this is *the* active attempt. A deep link that arrives
            // now waits in memory instead of taking over the credential slot.
            synchronized(inviteLock) { pairingInFlight = true }
            try {
                val qr = isQrCredential(credential)
                val deviceName = deviceNameProvider()
                // A parsed QR already carries this policy. Manual/discovered entry establishes the
                // same boundary here, before pairFirstReachable can probe or redeem on any route.
                val invited = if (connection.allowedRouteKinds == null) {
                    connection.establishingRoutePolicyFromInvite()
                } else {
                    connection
                }
                val outcome = try {
                    pairFn(invited, credential, deviceName, pairRequestId)
                } catch (error: Throwable) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    val routeFailure = error is PairingRouteError
                    if (qr && !routeFailure) burnQrCredential(credential)
                    _actionError.value = if (qr && !routeFailure) qrFailureMessage(error) else error.message
                    throw error
                }
                if (qr) burnQrCredential(credential)

                val paired = outcome.response
                // Route dialing may change the active endpoint, but neither it nor the response may
                // replace the policy captured from the user's original selection.
                var stored = outcome.connection.copy(
                    allowedRouteKinds = invited.allowedRouteKinds,
                    allowedLocalRouteURLs = invited.allowedLocalRouteURLs,
                )
                if (paired.serverName.isNotEmpty()) stored = stored.copy(name = paired.serverName)
                stored = stored.applyingPairingAdvertisement(paired.hosts, paired.endpoints)
                val winner = outcome.connection.activeEndpoint
                    ?: CompanionEndpoint.direct(outcome.connection.host, outcome.connection.port, priority = 10_000)
                stored = winner?.let(stored::promoting) ?: stored.promoting(stored.host)
                registry.matchingConnection(stored)?.let { existing -> stored = stored.copy(id = existing.id) }
                val firstPairing = registry.connections.isEmpty()
                val updatedRegistry = registry.upsert(stored)

                try {
                    tokenStore.save(stored.id, paired.token)
                    // The education marker goes down before the connection
                    // becomes restorable. A process that stops between the two
                    // leaves an orphan marker, which the router ignores while
                    // unpaired; the reverse order would leave a restorable
                    // pairing that skips first-pair education for good.
                    PairingCommitSequence.persist(
                        markNotificationOnboardingPending = {
                            if (firstPairing) onboardingStore.setNotificationOnboardingPending(true)
                        },
                        saveConnection = { connectionStore.saveRegistry(updatedRegistry) },
                    )
                } catch (error: Throwable) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    _actionError.value = if (qr) qrFailureMessage(error) else error.message
                    throw error
                }

                stopActiveRuntimeLocked()
                registry = updatedRegistry
                _connections.value = registry.connections
                _connection.value = stored
                token = paired.token
                // The route that just redeemed leads this session; later launches return to the
                // desktop's security-prioritized typed order.
                rotation = CandidateRotation(liveRoutes(stored, winner))
                client = clientFactory(stored, paired.token)
                _state.value = CompanionState()
                _restoreState.value = RestoreState.Ready
                _pairingRequested.value = false
            } finally {
                settlePairingAttempt()
            }
        }
        connect()
    }

    suspend fun pair(
        invite: PairingInvite,
        pairRequestId: String = UUID.randomUUID().toString(),
    ) = pair(invite.connection, invite.credential, pairRequestId)

    /**
     * Accept a deep-link invite after restore has settled. A paired phone can
     * add another computer; the current runtime remains intact until that
     * invitation commits successfully.
     */
    fun receivePairingURL(url: String) {
        if (restored.isCompleted) {
            acceptPairingURL(url)
            return
        }
        scope.launch {
            restored.await()
            acceptPairingURL(url)
        }
    }

    fun receivePairingURI(uri: URI) = receivePairingURL(uri.toString())

    /** The screen took the published invite. A waiting one is not touched. */
    fun consumePairingInvite() = synchronized(inviteLock) {
        _pairingInvite.value = null
    }

    fun beginPairing() {
        _pairingRequested.value = true
    }

    fun endPairing() {
        _pairingRequested.value = false
        consumePairingInvite()
    }

    private fun acceptPairingURL(url: String) {
        synchronized(inviteLock) {
            val invite = PairingInvite.parse(url)
            if (invite == null) {
                _actionError.value =
                    "That pairing invitation is not valid. Start pairing again on your computer."
                return
            }
            if (isQrCredential(invite.credential) && invite.credential in spentQrCredentials) {
                _actionError.value = SPENT_QR_MESSAGE
                return
            }
            // An attempt already in flight owns the screen and the credential
            // slot. This invite waits in memory until that attempt settles;
            // publishing it now would let the finishing attempt erase a
            // credential it never redeemed, and the user would be sent back to
            // the computer for a third QR code (§6).
            if (pairingInFlight) {
                deferredInvite = invite
                return
            }
            _pairingInvite.value = invite
            _pairingRequested.value = true
        }
    }

    /**
     * Close the single active attempt and answer for any invite that arrived
     * while it was in flight.
     *
     * Port of the `defer` block of `submit(_:credential:)` in
     * `ios/App/PairingView.swift`: the waiting invite is presented only while
     * pairing is still requested (`pairingRequested`); a successful pairing
     * clears that flag first and therefore consumes the waiting invite, because
     * §6 gives a one-time credential no second life.
     */
    private fun settlePairingAttempt() {
        synchronized(inviteLock) {
            pairingInFlight = false
            val waiting = deferredInvite
            deferredInvite = null
            if (_pairingRequested.value.not()) {
                _pairingInvite.value = null
                return
            }
            val invite = waiting ?: return
            if (isQrCredential(invite.credential) && invite.credential in spentQrCredentials) return
            _pairingInvite.value = invite
        }
    }

    /** Hold the paired-but-unproven state and say why the phone is offline. */
    private fun markRestoreInconclusive(error: Throwable) {
        _restoreState.value = RestoreState.Pending
        _status.value = Status.Offline(storeFailureMessage(error))
    }

    private fun storeFailureMessage(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: STORAGE_UNAVAILABLE_MESSAGE

    /**
     * Held under [inviteLock] so adding to the spent set and dropping the invite
     * are one step: an accept that had already read the set must not publish an
     * invite this call is in the middle of burning.
     */
    private fun burnQrCredential(credential: String) = synchronized(inviteLock) {
        spentQrCredentials += credential
        clearInviteIfCredential(credential)
    }

    private fun clearInviteIfCredential(credential: String) = synchronized(inviteLock) {
        val current = _pairingInvite.value
        if (current?.credential == credential) {
            _pairingInvite.value = null
        }
    }

    private fun qrFailureMessage(error: Throwable): String {
        val base = error.message?.takeIf { it.isNotBlank() } ?: "Pairing failed."
        return "$base Start pairing again on your computer and rescan the new QR code."
    }

    fun signOut() {
        attachmentSendIds.clear()
        streamJob?.cancel()
        streamJob = null
        scope.launch {
            gate.withLock { unpairLocked() }
            connect()
        }
    }

    /** Suspending unpair for tests / callers that need completion. */
    suspend fun signOutAndAwait() {
        streamJob?.cancel()
        streamJob = null
        gate.withLock { unpairLocked() }
        connect()
    }

    /** Remove only the selected computer. Other saved computers remain usable. */
    private suspend fun unpairLocked() {
        val id = _connection.value?.id ?: registry.activeConnectionId
        stopActiveRuntimeLocked()
        if (id != null) tokenStore.remove(id)
        registry = id?.let(registry::remove) ?: ConnectionRegistry()
        _connections.value = registry.connections
        connectionStore.saveRegistry(registry)
        if (registry.connections.isEmpty()) {
            // The pairing that earned the education step is gone, so its marker
            // goes too. Removing one of several computers must not consume the
            // first-pair marker for the others.
            onboardingStore.setNotificationOnboardingPending(false)
        }
        _connection.value = null
        _status.value = Status.Unpaired
        _restoreState.value = RestoreState.Unpaired
        restoreSelectedConnectionLocked()
        emptyInviteQueue()
        // Two branches, matching iOS signOut:
        // - Had a computer (id != null): forgetConnection — leave pairingRequested
        //   alone. Pair again does signOut() then beginPairing(); a late clear
        //   here would overwrite the new true after the first suspension above.
        // - Nothing to forget (id == null): clearActiveConnection — zero the flag.
        if (id == null) {
            _pairingRequested.value = false
        }
    }

    /** Switches active runtime only after the chosen computer's token is readable. */
    fun switchComputer(id: String) {
        scope.launch {
            awaitRestored()
            gate.withLock {
                val saved = registry.connection(id) ?: return@withLock
                if (_connection.value?.id == id) {
                    restartStreamLocked()
                    return@withLock
                }
                when (val stored = tokenStore.read(id)) {
                    is TokenStore.ReadResult.Found -> {
                        stopActiveRuntimeLocked()
                        registry = registry.select(id) ?: registry
                        _connections.value = registry.connections
                        connectionStore.saveRegistry(registry)
                        configureActiveConnectionLocked(saved, stored.token)
                    }
                    is TokenStore.ReadResult.Unavailable -> {
                        _actionError.value = if (stored.locked) {
                            "Unlock this phone, then try switching computers again."
                        } else {
                            stored.message
                        }
                    }
                    TokenStore.ReadResult.Missing -> {
                        _actionError.value =
                            "This saved connection is no longer available on this phone. Remove it and pair again."
                    }
                }
            }
            connect()
        }
    }

    fun forgetConnection(id: String) {
        scope.launch {
            awaitRestored()
            gate.withLock {
                if (registry.connection(id) == null) return@withLock
                val wasActive = registry.activeConnectionId == id
                if (wasActive) stopActiveRuntimeLocked()
                tokenStore.remove(id)
                registry = registry.remove(id)
                _connections.value = registry.connections
                connectionStore.saveRegistry(registry)
                if (registry.connections.isEmpty()) onboardingStore.setNotificationOnboardingPending(false)
                if (wasActive) {
                    _connection.value = null
                    _status.value = Status.Unpaired
                    _restoreState.value = RestoreState.Unpaired
                    restoreSelectedConnectionLocked()
                }
            }
            connect()
        }
    }

    private fun stopActiveRuntimeLocked() {
        attachmentDownloads.clear()
        streamGeneration += 1
        streamJob?.cancel()
        streamJob = null
        endpointRefreshJob?.cancel()
        endpointRefreshJob = null
        reconnectDelaySeconds = 0
        screenWatchers = 0
        client = null
        token = null
        rotation = CandidateRotation(emptyList())
        _state.value = CompanionState()
        notificationSink.setBadge(0)
    }

    /**
     * Unpairing takes the invite queue with it. An invite that outlived the
     * binding it was meant for comes back on a later pairing screen and
     * redeems a credential the computer retired long ago.
     *
     * There is never a waiting invite left to clear here: [settlePairingAttempt]
     * releases or drops it inside the same [gate] section sign-out is waiting on.
     */
    private fun emptyInviteQueue() = synchronized(inviteLock) {
        _pairingInvite.value = null
    }

    /** Called when the app comes to the front, and once at launch. */
    fun connect() {
        scope.launch {
            restored.await()
            gate.withLock {
                if (client == null && _restoreState.value is RestoreState.Pending) {
                    restoreLocked()
                }
                if (client == null || streamJob != null) return@withLock
                reconnectDelaySeconds = 0
                streamGeneration += 1
                val generation = streamGeneration
                // Publish the handle while still holding `gate`, exactly as
                // restartStreamLocked() does. On a scope that starts children
                // eagerly or on another thread, a stream that fails without ever
                // suspending can reach its `finally` before the launching
                // coroutine's next line: it would clear a streamJob still null
                // and the finished job would then be published behind it, after
                // which connect() — which only tests `streamJob != null` — never
                // reopens the stream. Holding the lock makes that `finally` wait.
                streamJob = scope.launch {
                    try {
                        runStream()
                    } finally {
                        gate.withLock {
                            if (streamGeneration == generation) {
                                streamJob = null
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Rebuild the saved pairing, reporting a failed read instead of throwing it.
     *
     * Cancellation still propagates, and so does anything that is not an
     * `Exception`: an `Error` is left to the handler it was always headed for.
     *
     * Two of the three callers are fire-and-forget launches, where a thrown
     * failure has no one to catch it and reaches the uncaught handler. A read
     * that could not complete is also inconclusive: it did not establish that
     * this phone is unpaired, so the pairing is left standing (`Pending` keeps
     * the session in a protected pending state) and the phone reads offline. That extends the
     * answer `ios/App/Session.swift` already gives for a Keychain it cannot
     * open, and that a locked token already gets here, to a store that throws.
     */
    private suspend fun restoreLocked() {
        try {
            restoreFromStoresLocked()
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            markRestoreInconclusive(error)
        }
    }

    private suspend fun restoreFromStoresLocked() {
        val restoredRegistry = connectionStore.loadRegistry()
        registry = restoredRegistry.registry.normalized()
        _connections.value = registry.connections
        if (restoredRegistry.migratedLegacyConnection) {
            // The old record is still intact until a v1 write succeeds. A
            // read-only/transiently failing store must not turn an otherwise
            // usable legacy pairing into an offline state merely because this
            // optional migration could not be committed today.
            try {
                connectionStore.saveRegistry(registry)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Keep the in-memory registry; the next launch retries the
                // one-way migration from the untouched legacy record.
            }
        }
        restoreSelectedConnectionLocked()
    }

    /** Restore the selected record, dropping only records whose token is truly missing. */
    private suspend fun restoreSelectedConnectionLocked() {
        while (true) {
            val saved = registry.activeConnection
            if (saved == null) {
                _connection.value = null
                _restoreState.value = RestoreState.Unpaired
                _status.value = Status.Unpaired
                return
            }
            val stored = try {
                tokenStore.read(saved.id)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                TokenStore.ReadResult.Unavailable(locked = false, message = storeFailureMessage(error))
            }
            when (stored) {
                is TokenStore.ReadResult.Unavailable -> {
                    _connection.value = saved
                    _restoreState.value = RestoreState.Pending
                    _status.value = Status.Offline(
                        if (stored.locked) "Unlock this phone to reach your computer." else stored.message,
                    )
                    return
                }
                TokenStore.ReadResult.Missing -> {
                    registry = registry.remove(saved.id)
                    _connections.value = registry.connections
                    connectionStore.saveRegistry(registry)
                }
                is TokenStore.ReadResult.Found -> {
                    configureActiveConnectionLocked(saved, stored.token)
                    return
                }
            }
        }
    }

    private fun configureActiveConnectionLocked(saved: Connection, storedToken: String) {
        _connection.value = saved
        token = storedToken
        // A restored pairing walks the desktop's advertised priority, and it walks
        // it credential-safely: a connection already on a protected route never
        // reaches for a local one. Surviving a failover is not a promotion — the
        // computer still decides which protected route leads.
        rotation = CandidateRotation(saved.orderedEndpoints)
        val first = rotation.currentEndpoint?.let(saved::dialing) ?: saved
        client = clientFactory(first, storedToken)
        _restoreState.value = RestoreState.Ready
        _status.value = Status.Connecting
    }

    /** Update only the active record; never overwrite the other saved computers. */
    private suspend fun persistActiveConnectionLocked(updated: Connection) {
        registry = registry.upsert(updated, makeActive = false)
        _connections.value = registry.connections
        _connection.value = updated
        connectionStore.saveRegistry(registry)
    }

    /**
     * Pull-to-refresh: reopen the stream and wait until status leaves connecting
     * or 10s — so the spinner means what it appears to mean.
     *
     * Restarts under the session mutex (not a fire-and-forget enqueue) so a
     * caller on any dispatcher observes Connecting before the wait loop runs.
     */
    suspend fun refresh() {
        awaitRestored()
        gate.withLock {
            if (client == null && _restoreState.value is RestoreState.Pending) {
                restoreLocked()
            }
            if (client == null) return@withLock
            streamJob?.cancel()
            streamJob = null
            reconnectDelaySeconds = 0
            streamGeneration += 1
            val generation = streamGeneration
            _status.value = Status.Connecting
            val job = scope.launch {
                try {
                    runStream()
                } finally {
                    gate.withLock {
                        if (streamGeneration == generation) {
                            streamJob = null
                        }
                    }
                }
            }
            streamJob = job
        }
        withTimeoutOrNull(10_000) {
            while (_status.value is Status.Connecting && currentCoroutineContext().isActive) {
                delay(120)
            }
        }
    }

    fun watchScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers += 1
                if (screenWatchers == 1) restartStreamLocked()
            }
        }
    }

    fun stopWatchingScreen(ofBotId: String) {
        scope.launch {
            gate.withLock {
                screenWatchers = maxOf(0, screenWatchers - 1)
                if (screenWatchers == 0) {
                    _state.update { it.clearScreen(ofBotId) }
                    restartStreamLocked()
                }
            }
        }
    }

    private fun restartStream() {
        scope.launch {
            gate.withLock { restartStreamLocked() }
        }
    }

    private fun restartStreamLocked() {
        if (streamJob == null) return
        streamJob?.cancel()
        streamJob = null
        if (client == null) return
        reconnectDelaySeconds = 0
        streamGeneration += 1
        val generation = streamGeneration
        // Launch without holding the mutex across runStream — the job handle is
        // published immediately so a concurrent connect() sees it.
        val job = scope.launch {
            try {
                runStream()
            } finally {
                gate.withLock {
                    if (streamGeneration == generation) {
                        streamJob = null
                    }
                }
            }
        }
        streamJob = job
    }

    /** Called when the app leaves the screen — deliberate disconnect so the cursor is known. */
    fun disconnect() {
        streamJob?.cancel()
        streamJob = null
        endpointRefreshJob?.cancel()
        endpointRefreshJob = null
    }

    private suspend fun runStream() {
        while (currentCoroutineContext().isActive) {
            val activeClient = client ?: return
            _status.value = Status.Connecting
            try {
                eventsFn(activeClient, _state.value.cursor, screenWatchers > 0)
                    .collect { frame ->
                        currentCoroutineContext().ensureActive()
                        reconnectDelaySeconds = 0

                        when (val payload = frame.frame) {
                            is Frame.Hello -> {
                                if (!payload.resumed) {
                                    hydrate()
                                    _state.update { it.resetCursor(payload.cursor) }
                                }
                                _status.value = Status.Live
                                promoteWorkingRoute()
                                refreshConnectionMetadata(activeClient)
                            }
                            else -> {
                                _state.update { it.apply(frame) }
                                if (payload is Frame.Notify) {
                                    notificationSink.deliver(payload.notification, frame.seq)
                                }
                                notificationSink.setBadge(_state.value.unreadCount)
                                _state.update { it.advance(frame.seq) }
                            }
                        }
                    }
                // Clean stream end — harness went away
                _status.value = Status.Offline("Lost the connection.")
            } catch (error: Throwable) {
                if (!currentCoroutineContext().isActive || error is kotlinx.coroutines.CancellationException) {
                    return
                }
                val apiError = error as? APIError
                if (apiError?.isUnauthorized == true) {
                    _status.value = Status.Unauthorized
                    return
                }
                _status.value = Status.Offline(failureMessage(error))
            }

            if (!currentCoroutineContext().isActive) return
            reconnectDelaySeconds = if (reconnectDelaySeconds == 0L) 1L else minOf(reconnectDelaySeconds * 2, 15L)
            delay(reconnectDelaySeconds * 1_000)
        }
    }

    private suspend fun hydrate() {
        val activeClient = client ?: return
        val fleet = hydrateFn(activeClient, 50)
        _state.update { it.hydrate(fleet) }
        notificationSink.setBadge(_state.value.unreadCount)
        // Deliberately off hydrate's critical path: this only words the
        // composer, and the cursor commit — and with it the whole stream —
        // must not wait on a request that says nothing about the transcript.
        // An older harness omits the flag and every engine reads as
        // non-steering, which is the conservative wording.
        scope.launch {
            _steeringInstanceIds.value = try {
                instancesFn(activeClient)
                    .filter { it.capabilities?.queueing == true }
                    .map { it.instanceId }
                    .toSet()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                emptySet()
            }
        }
    }

    /**
     * Turn a stream failure into advice a person can act on and, when the failure belongs to the
     * route rather than to the pairing, move the dial so the retry that follows tries somewhere
     * new. The trust ratchet in [CandidateRotation] decides what "somewhere new" may be, so the
     * banner only names a route the client was actually rebuilt for — it can no longer promise a
     * switch a policy guard then refuses.
     *
     * A 401 never reaches here: the unauthorized path returns before this is called.
     */
    private suspend fun failureMessage(error: Throwable): String {
        val moved = gate.withLock { advanceRouteLocked(error) }
            ?: return error.message?.takeIf { it.isNotBlank() } ?: "Could not reach the computer."
        ConnectionAdvice.gatewayStatus(error)?.let { status ->
            return ConnectionAdvice.message(status, moved.failedAddress, moved.next)
        }
        val failure = ConnectionAdvice.classify(error)
        return if (failure == ConnectionFailure.OTHER) {
            error.message?.takeIf { it.isNotBlank() }
                ?: ConnectionAdvice.message(failure, moved.failedAddress, moved.failedPort, moved.next)
        } else {
            ConnectionAdvice.message(failure, moved.failedAddress, moved.failedPort, moved.next)
        }
    }

    /**
     * Advance the walk and rebuild the client for the route it landed on, as one
     * step under [gate]. Null when there is no pairing to move.
     *
     * `rotation` and `client` are one fact in two fields — which route the next
     * attempt uses, and the client that will make it. Every other writer of that
     * pair ([updateAddress], [refreshConnectionMetadata], [unpairLocked]) already
     * changes them under [gate], and each of those writers *suspends* on a store
     * in the middle. `Dispatchers.Main.immediate` does not help there: a
     * suspension is exactly where another coroutine on the same thread runs. A
     * failure that advanced the walk in that window used to be overwritten a line
     * later by a refresh that had read the old rotation, leaving `client` dialing
     * one route while `rotation.currentEndpoint` named another — and
     * [promoteWorkingRoute] then persists the one that did not carry the stream.
     */
    private fun advanceRouteLocked(error: Throwable): RouteMove? {
        val connection = _connection.value ?: return null
        val failed = rotation.currentEndpoint
            ?: connection.activeEndpoint
            ?: CompanionEndpoint.direct(connection.host, connection.port, priority = 10_000)
        var next: String? = null
        val candidate = rotation.advanceEndpoint(error)
        val activeToken = token
        if (candidate != null && activeToken != null) {
            client = clientFactory(connection.dialing(candidate), activeToken)
            next = candidate.displayAddress
        }
        return RouteMove(
            failedAddress = failed?.displayAddress ?: connection.host,
            failedPort = failed?.port ?: connection.port,
            next = next,
        )
    }

    /** What [advanceRouteLocked] decided, for the banner to describe. */
    private data class RouteMove(
        val failedAddress: String,
        val failedPort: Int,
        val next: String?,
    )

    /**
     * Persist the route that carried a live stream.
     *
     * A legacy host list promotes the winner for the next launch. A typed list is *not*
     * reordered: the desktop's advertised priority keeps deciding which protected route leads,
     * so a route that merely survived a failover does not outrank a hosted route the computer
     * put first. The one thing recording a protected winner changes is that cleartext routes it
     * superseded stop leading — see [Connection.orderedEndpoints].
     *
     * Under [gate], and that is the point rather than decoration. This used to read `_connection`,
     * write it, and *then* suspend in [ConnectionStore.save] with nothing held. Every other writer
     * of the stored connection — a manual address edit, a metadata refresh, a sign-out — runs
     * inside [gate], so one of them could take the whole section during that suspension and save
     * its own connection first; the promotion's older save then landed on top of it. The measured
     * case is the address edit: the phone came back on the address the user had just replaced,
     * because memory and disk disagreed and the next launch believes the disk.
     *
     * [gate] is safe to hold here: [runStream] is always its own coroutine and never enters this
     * function holding the mutex.
     */
    private suspend fun promoteWorkingRoute() = gate.withLock {
        val winner = rotation.currentEndpoint ?: return@withLock
        val updated = _connection.value ?: return@withLock
        if (updated.activeEndpoint?.url == winner.url) return@withLock
        val promoted = updated.promoting(winner)
        persistActiveConnectionLocked(promoted)
    }

    /**
     * Learn routes the computer enabled after this phone paired. The snapshot is authenticated
     * with the device token already in hand and carries no account or pairing credential, so an
     * already-paired phone can discover hosted HTTPS without another QR code.
     *
     * Failure is deliberately non-fatal: an older sidecar answers 404 and a transient refresh
     * error must not tear down a healthy event stream.
     *
     * The live route is not swapped underneath the stream either, and that is worth being exact
     * about: the replacement order takes effect **on the next launch and on the next route
     * change** — not on every reconnect. [runStream] re-reads `client` each lap but nothing here
     * rebuilds it, so a stream that simply ends and reopens comes back on the same authority it
     * was already using. That is deliberate. The live route is at the head of the walk precisely
     * because the advertised head just failed; re-preferring it after every clean reconnect would
     * pay that failure's timeout again and again, and would move a working session onto another
     * authority for no reason. A route change — a real failure that advances the walk — reads the
     * refreshed list, and a launch reads the persisted order, which is where the new policy lands.
     *
     * And it is the computer's order that lands there. This request is how the desktop restates
     * its transport policy, so nothing local may quietly outrank it; if it could, the refresh
     * would be decorative.
     */
    private fun refreshConnectionMetadata(source: CompanionClient) {
        val connectionId = _connection.value?.id ?: return
        val workingEndpoint = rotation.currentEndpoint ?: source.connection.activeEndpoint
        endpointRefreshJob?.cancel()
        endpointRefreshJob = scope.launch {
            // Best-effort from end to end, and this is a root coroutine: a store that cannot
            // write is as survivable here as a sidecar that answers 404, and neither has a
            // caller left to catch for it.
            try {
                val metadata = metadataFn(source)
                gate.withLock {
                    val current = _connection.value ?: return@withLock
                    // The stream that asked for this snapshot may already have been replaced by
                    // a sign-out, a manual address edit or a route advance. Applying it then
                    // would reorder a walk that no longer belongs to this client.
                    if (current.id != connectionId) return@withLock
                    if (client?.connection?.baseUrl != source.connection.baseUrl) return@withLock
                    val updated = current.reconciling(metadata)
                    persistActiveConnectionLocked(updated)
                    rotation = CandidateRotation(liveRoutes(updated, workingEndpoint))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                return@launch
            }
        }
    }

    /**
     * [winner] first, then the stored policy order — the walk a live session may take without
     * abandoning the route that is already carrying it.
     *
     * The head here is a transient cursor for one session, not a stored preference: what gets
     * written down is [Connection.orderedEndpoints], where the desktop's priority governs.
     */
    private fun liveRoutes(
        connection: Connection,
        winner: CompanionEndpoint?,
    ): List<CompanionEndpoint> {
        val routes = connection.orderedEndpoints
        return if (winner == null) routes else listOf(winner) + routes.filterNot { it.url == winner.url }
    }

    /** Replace the stored address by hand, keeping the pairing and its token. */
    fun updateAddress(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val endpoint = parsed.activeEndpoint
            ?: CompanionEndpoint.direct(parsed.host, parsed.port, priority = 0)
            ?: return false
        val updated = current.resettingRoutePolicy(endpoint)
        scope.launch {
            gate.withLock {
                persistActiveConnectionLocked(updated)
                rotation = CandidateRotation(liveRoutes(updated, endpoint))
                val activeToken = token
                if (activeToken != null) {
                    client = clientFactory(updated, activeToken)
                }
                restartStreamLocked()
            }
        }
        return true
    }

    suspend fun updateAddressAndAwait(text: String): Boolean {
        val parsed = Connection.parse(text) ?: return false
        val current = _connection.value ?: return false
        val endpoint = parsed.activeEndpoint
            ?: CompanionEndpoint.direct(parsed.host, parsed.port, priority = 0)
            ?: return false
        val updated = current.resettingRoutePolicy(endpoint)
        gate.withLock {
            persistActiveConnectionLocked(updated)
            rotation = CandidateRotation(liveRoutes(updated, endpoint))
            val activeToken = token
            if (activeToken != null) {
                client = clientFactory(updated, activeToken)
            }
            restartStreamLocked()
        }
        return true
    }

    // MARK: - Actions

    suspend fun send(text: String, to: Chat) {
        perform {
            val receipt = when (to) {
                is Chat.BotChat -> it.sendToBot(to.bot.id, text)
                is Chat.RoomChat -> it.sendToRoom(to.room.id, text)
            }
            record(receipt, text, to.threadId)
        }
    }

    /**
     * A send the harness held rather than ran has to stay on screen, or the
     * words simply vanish from the phone until the turn settles. [text] is
     * what the person typed; the harness echoes back only an id.
     */
    private fun record(receipt: SendReceipt, text: String, fallbackThreadId: String) {
        val queued = receipt as? SendReceipt.Queued ?: return
        val threadId = queued.threadId.ifEmpty { fallbackThreadId }
        _state.update { it.rememberQueued(QueuedSend(queued.queueId, text), threadId) }
    }

    /**
     * Take back a held message before its turn settles. The row goes only
     * once the harness confirms, so a failed cancel leaves the words on
     * screen still waiting — which is what is actually true.
     */
    suspend fun cancelQueued(send: QueuedSend, chat: Chat) {
        val activeClient = client ?: return
        val destination = when (chat) {
            is Chat.BotChat -> MessageDestination.Bot(chat.bot.id, chat.threadId)
            is Chat.RoomChat -> MessageDestination.Room(chat.room.id, chat.threadId)
        }
        try {
            activeClient.cancelQueued(send.queueId, destination)
            _state.update { it.forgetQueued(send.queueId, chat.threadId) }
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) _status.value = Status.Unauthorized
            _actionError.value = error.message
        }
    }

    /**
     * An ambiguous network failure may happen after the server accepted a
     * message. Reusing the id for the exact same retained draft makes Retry
     * idempotent instead of sending the attachment twice.
     */
    private data class AttachmentDraftKey(
        val destination: MessageDestination,
        val text: String,
        val attachmentIds: List<String>,
    )

    private val attachmentSendIds = LinkedHashMap<AttachmentDraftKey, String>()

    /**
     * Send a composer draft with app-owned attachments — the port of
     * `Session.send(text:attachments:to:)`. The destination includes the exact
     * active thread at tap time, so neither a desktop task switch nor an upload
     * delay can move the message elsewhere. Callers only clear their draft when
     * this returns true.
     */
    suspend fun send(text: String, attachments: List<PendingMessageAttachment>, to: Chat): Boolean {
        val activeClient = client ?: run {
            _actionError.value = "This computer is offline."
            return false
        }
        val connectionId = _connection.value?.id
        _actionError.value = null
        return try {
            AttachmentPolicy.validate(attachments)
            if (text.isBlank() && attachments.isEmpty()) {
                _actionError.value = "Write a message or attach a file first."
                return false
            }
            if (attachments.any { it.kind == PendingMessageAttachment.Kind.IMAGE }) {
                val capable = try {
                    activeClient.imageCapableInstanceIds()
                } catch (error: APIError.Status) {
                    if (error.code != 404) throw error
                    _actionError.value = "Update OpenMausBot on this computer before sending images."
                    return false
                }
                if (!imageSupported(to, capable)) {
                    _actionError.value = imageCompatibilityMessage(to)
                    return false
                }
            }
            val destination = when (to) {
                is Chat.BotChat -> MessageDestination.Bot(to.bot.id, to.bot.threadId)
                is Chat.RoomChat -> MessageDestination.Room(to.room.id, to.room.threadId)
            }
            val key = AttachmentDraftKey(destination, text, attachments.map { it.id })
            if (attachmentSendIds.size >= 20 && key !in attachmentSendIds) attachmentSendIds.clear()
            val sendId = attachmentSendIds.getOrPut(key) { UUID.randomUUID().toString() }

            val uploaded = attachments.map { attachment ->
                currentCoroutineContext().ensureActive()
                val mime = AttachmentPolicy.normalizedMime(attachment.mime)
                when (attachment.kind) {
                    PendingMessageAttachment.Kind.IMAGE -> SharedAttachmentReference(
                        path = activeClient.uploadImage(attachment.data, mime, attachment.id),
                        kind = SharedAttachmentKind.IMAGE,
                        displayName = attachment.name,
                    )
                    PendingMessageAttachment.Kind.FILE -> {
                        val file = activeClient.uploadFile(attachment.data, attachment.name, mime, attachment.id)
                        SharedAttachmentReference(file.path, SharedAttachmentKind.FILE, file.name)
                    }
                }
            }
            val message = SharedMessageComposer.compose(
                instruction = text,
                text = emptyList(),
                urls = emptyList(),
                attachments = uploaded,
            )
            val receipt = activeClient.send(message, destination, sendId)
            // The row shows what was typed, not what was sent: `message`
            // carries the <attached-file …> tags the harness reads, and a
            // held message is a person's own words waiting, not transport.
            // An attachment-only send has no words, so it falls back.
            record(receipt, text.trim().ifEmpty { message }, to.threadId)
            attachmentSendIds.remove(key)
            _actionError.value = null
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            _actionError.value = error.message
            false
        } catch (error: Throwable) {
            _actionError.value = error.message
            false
        }
    }

    private fun imageSupported(chat: Chat, capableInstances: Set<String>): Boolean = when (chat) {
        is Chat.BotChat -> chat.bot.modelSelection.instanceId in capableInstances
        is Chat.RoomChat -> chat.room.memberIds.isNotEmpty() && chat.room.memberIds.all { id ->
            val bot = _state.value.bot(id) ?: return@all false
            bot.modelSelection.instanceId in capableInstances
        }
    }

    private fun imageCompatibilityMessage(chat: Chat): String = when (chat) {
        is Chat.BotChat ->
            "${chat.bot.name}'s current model doesn't support images. Choose another model or remove the image."
        is Chat.RoomChat ->
            "Every bot that may answer in this channel must use a model that supports images."
    }

    /**
     * Download one desktop path through its originating transcript message.
     * Where the bytes are kept for viewing is the app's business (it owns a
     * cache directory); this only fetches and reports.
     */
    suspend fun downloadFile(
        threadId: String,
        messageId: String,
        path: String,
        reportError: Boolean = true,
        cacheResult: Boolean = false,
    ): DownloadedFile? {
        val activeClient = client ?: run {
            if (reportError) _actionError.value = "This computer is offline."
            return null
        }
        val connectionId = _connection.value?.id
        if (reportError) _actionError.value = null
        return try {
            val id = connectionId ?: throw APIError.Transport("This computer is offline.")
            val download = attachmentDownloads.getOrLoad(
                AttachmentDownloadKey(id, threadId, messageId, path),
                retainResult = cacheResult,
            ) {
                activeClient.downloadFile(threadId, messageId, path)
            }
            afterAttachmentDownload()
            currentCoroutineContext().ensureActive()
            // A computer switch invalidates the meaning of every local path.
            // The cache is cleared during the switch, but a transfer that won
            // the completion race must still never surface old-computer bytes.
            if (_connection.value?.id != id) return null
            download
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            if (reportError) _actionError.value = error.message
            null
        } catch (error: Throwable) {
            if (reportError) _actionError.value = error.message
            null
        }
    }

    /**
     * Executes one idempotent share operation against the selected computer.
     * A network/gateway failure may advance only through [CandidateRotation],
     * which retains the HTTPS trust ratchet. Callers supply stable upload/send
     * ids, so replaying this lambda cannot create duplicate server objects.
     */
    suspend fun <T> withShareClient(connectionId: String, action: suspend (CompanionClient) -> T): T {
        val first = client ?: throw IllegalStateException("Connect to the selected computer before sharing.")
        if (_connection.value?.id != connectionId) {
            throw IllegalStateException("The selected computer changed. Choose the destination again.")
        }
        try {
            return action(first)
        } catch (error: CancellationException) {
            throw error
        } catch (error: APIError) {
            val retry = gate.withLock {
                if (_connection.value?.id != connectionId) null else {
                    // Only the live computer's 401 may mark this session revoked.
                    if (error.isUnauthorized) _status.value = Status.Unauthorized
                    advanceRouteLocked(error)
                    client
                }
            }
            if (retry != null && retry !== first && _connection.value?.id == connectionId) {
                return action(retry)
            }
            throw error
        } catch (error: Throwable) {
            val retry = gate.withLock {
                if (_connection.value?.id != connectionId) null else {
                    advanceRouteLocked(error)
                    client
                }
            }
            if (retry != null && retry !== first && _connection.value?.id == connectionId) {
                return action(retry)
            }
            throw error
        }
    }

    /**
     * One share/upload against a saved computer without moving the live stream.
     *
     * The active pairing keeps its HTTPS ratchet via [withShareClient]. A share
     * aimed at another saved computer walks only that computer's credential-
     * approved routes and must not mark this session unauthorized: a 401 there
     * is about that pairing, not the one currently on screen.
     */
    suspend fun <T> withPairedShareClient(
        connectionId: String,
        action: suspend (CompanionClient) -> T,
    ): T {
        awaitRestored()
        if (_connection.value?.id == connectionId) {
            return withShareClient(connectionId, action)
        }
        val saved = registry.connection(connectionId)
            ?: throw APIError.Transport("This saved connection is no longer available on this phone. Remove it and pair again.")
        val pairedToken = when (val stored = tokenStore.read(connectionId)) {
            is TokenStore.ReadResult.Found -> stored.token
            is TokenStore.ReadResult.Unavailable -> throw APIError.Transport(
                if (stored.locked) {
                    "Unlock this phone, then try sharing again."
                } else {
                    stored.message
                },
            )
            TokenStore.ReadResult.Missing -> throw APIError.Transport(
                "This saved connection is no longer available on this phone. Remove it and pair again.",
            )
        }
        val endpoints = saved.automaticEndpoints
        if (endpoints.isEmpty()) {
            throw APIError.Transport(
                "Couldn't reach ${saved.name}. Keep OpenMausBot open and Phone access on, then try again.",
            )
        }
        var lastError: Throwable? = null
        for (endpoint in endpoints) {
            val candidate = clientFactory(saved.dialing(endpoint), pairedToken)
            try {
                return action(candidate)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                lastError = error
                if (!canRetryShareOnAnotherRoute(error)) throw error
            }
        }
        throw lastError ?: APIError.Transport(
            "Couldn't reach ${saved.name}. Keep OpenMausBot open and Phone access on, then try again.",
        )
    }

    private fun canRetryShareOnAnotherRoute(error: Throwable): Boolean {
        val api = generateSequence(error) { it.cause }.filterIsInstance<APIError>().firstOrNull()
        return if (api != null) {
            ConnectionAdvice.shouldRetryPairingOnAnotherRoute(api)
        } else {
            ConnectionAdvice.shouldTryAnotherHost(error)
        }
    }

    suspend fun answer(
        chat: Chat,
        card: OptionCard,
        choice: String,
        rememberingPermission: Boolean = true,
    ) {
        val requestId = card.requestId ?: return
        if (
            rememberingPermission &&
            card.shouldRememberPermission(choice) &&
            chat is Chat.BotChat
        ) {
            alwaysAllow(chat.bot, card)
        }
        answer(
            threadId = chat.threadId,
            requestId = requestId,
            choice = choice,
            isPermission = card.isPermission,
            reviewedSha256 = card.skillRequest?.reviewedSha256,
        )
    }

    suspend fun answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Boolean,
        reviewedSha256: String? = null,
    ) {
        perform {
            val behavior = OptionCard.responseBehavior(choice, isPermission)
            it.respond(
                threadId = threadId,
                requestId = requestId,
                behavior = behavior,
                message = choice.takeIf { behavior == "answer" },
                reviewedSha256 = reviewedSha256.takeIf { behavior == "allow" },
            )
        }
    }

    suspend fun alwaysAllow(bot: Bot, card: OptionCard) {
        val key = card.allowKey ?: return
        perform { it.alwaysAllow(bot.id, key) }
    }

    suspend fun createBot(): Bot? {
        val activeClient = client ?: return null
        return try {
            val bot = activeClient.createBot()
            _state.update { it.apply(Frame.Bot(bot)) }
            bot
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun createRoom(name: String?, memberIds: List<String>): Room? {
        val activeClient = client ?: return null
        return try {
            val room = activeClient.createRoom(name, memberIds)
            _state.update { it.apply(Frame.Room(room)) }
            room
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    /**
     * Create or extend a derived sidebar section in one server transaction.
     * The desktop has no standalone section resource yet, so we merge the
     * returned bot snapshots and let SSE reconcile later desktop-side changes.
     */
    suspend fun assignSection(name: String, botIds: List<String>): List<Bot>? {
        val activeClient = client ?: return null
        return try {
            activeClient.assignSection(name, botIds).also { updatedBots ->
                _state.update { state ->
                    updatedBots.fold(state) { current, bot -> current.apply(Frame.Bot(bot)) }
                }
            }
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun interrupt(bot: Bot) {
        perform { it.interrupt(bot.id) }
    }

    suspend fun cloudDesktop(forBot: Bot): URI {
        val activeClient = client ?: throw APIError.Transport("This computer is offline.")
        val connectionId = _connection.value?.id
        return try {
            activeClient.cloudDesktop(forBot.id).url
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    // Only the live computer's 401 may mark this session revoked.
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            }
            throw error
        }
    }

    suspend fun markRead(chat: Chat) {
        perform(quietly = true) {
            when (chat) {
                is Chat.BotChat -> it.markBotRead(chat.bot.id)
                is Chat.RoomChat -> it.markRoomRead(chat.room.id)
            }
        }
    }

    suspend fun loadOlder(threadId: String) {
        val activeClient = client ?: return
        val oldest = _state.value.transcript(threadId).firstOrNull() ?: return
        try {
            val page = activeClient.messages(threadId, before = oldest.id, limit = 50)
            _state.update { it.prepend(page, threadId) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun image(threadId: String, messageId: String): ByteArray? =
        try {
            client?.image(threadId, messageId)
        } catch (_: Throwable) {
            null
        }

    suspend fun search(query: String): List<SearchHit> {
        val trimmed = query.trim()
        if (trimmed.length < 2) return emptyList()
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.search(trimmed)
        } catch (error: Throwable) {
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun open(hit: SearchHit): Chat? {
        val activeClient = client ?: return null
        return try {
            val botId = hit.botId
            if (botId != null) {
                var bot = _state.value.bot(botId) ?: return null
                if (bot.threadId != hit.threadId) {
                    bot = activeClient.switchTask(bot.id, hit.threadId)
                    _state.update { it.apply(Frame.Bot(bot)) }
                }
                if (!hit.onActivePath) {
                    val leaf = activeClient.setActiveBranch(bot.id, hit.messageId)
                    _state.update { it.apply(Frame.Thread(hit.threadId, leaf)) }
                }
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return _state.value.bot(bot.id)?.let { Chat.BotChat(it) }
            }
            val groupId = hit.groupId
            if (groupId != null) {
                var room = _state.value.rooms.firstOrNull { it.id == groupId } ?: return null
                if (room.threadId != hit.threadId) {
                    room = activeClient.switchRoomTask(room.id, hit.threadId)
                    _state.update { it.apply(Frame.Room(room)) }
                }
                val page = activeClient.messagesAround(hit.threadId, hit.messageId)
                _state.update { it.merge(page, hit.threadId) }
                _focusedMessageId.value = hit.messageId
                return _state.value.rooms.firstOrNull { it.id == groupId }?.let { Chat.RoomChat(it) }
            }
            null
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    suspend fun openNotification(target: NotificationTarget): Chat? {
        awaitRestored()
        return notificationGate.withLock {
            val activeClient = client
            if (activeClient == null) {
                _actionError.value = "Pair this phone with your computer to open that task."
                return@withLock null
            }

            try {
                _state.value.roomOwningTask(target.threadId)?.let { room ->
                    return@withLock openRoomNotification(activeClient, room, target.threadId)
                }

                var bot = _state.value.bot(target.botId)
                if (bot == null) {
                    val fleet = hydrateFn(activeClient, 50)
                    _state.update { it.hydrate(fleet) }
                    notificationSink.setBadge(_state.value.unreadCount)
                    _state.value.roomOwningTask(target.threadId)?.let { room ->
                        return@withLock openRoomNotification(activeClient, room, target.threadId)
                    }
                    bot = _state.value.bot(target.botId)
                }

                var selected = bot
                    ?: throw APIError.Status(404, "That agent no longer exists.")
                if (target.requiresTaskSwitch(selected.threadId)) {
                    try {
                        selected = activeClient.switchTask(selected.id, target.threadId)
                        _state.update { it.apply(Frame.Bot(selected)) }
                    } catch (error: Throwable) {
                        if (error is kotlinx.coroutines.CancellationException) throw error
                        // The requested task can disappear between notification delivery and the tap.
                    }
                }
                Chat.BotChat(selected)
            } catch (error: Throwable) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                _actionError.value = error.message
                null
            }
        }
    }

    /** A room notification can name any channel task, not just the active one. */
    private suspend fun openRoomNotification(
        activeClient: CompanionClient,
        room: Room,
        threadId: String,
    ): Chat.RoomChat {
        if (room.threadId == threadId) return Chat.RoomChat(room)
        return try {
            val switched = activeClient.switchRoomTask(room.id, threadId)
            _state.update { it.apply(Frame.Room(switched)) }
            Chat.RoomChat(_state.value.rooms.firstOrNull { it.id == room.id } ?: switched)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            // Notifications can outlive their task. Open the channel's current
            // task rather than leaving the person with nowhere to go.
            Chat.RoomChat(room)
        }
    }

    fun consumeFocus(messageId: String) {
        if (_focusedMessageId.value == messageId) _focusedMessageId.value = null
    }

    suspend fun createTask(forBot: Bot, title: String?) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.createTask(forBot.id, title))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun switchTask(task: BotTask, forBot: Bot) {
        if (task.threadId == forBot.threadId) return
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.switchTask(forBot.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun renameTask(task: BotTask, forBot: Bot, title: String) {
        val activeClient = client ?: return
        try {
            activeClient.renameTask(forBot.id, task.threadId, title)
            refresh()
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun deleteTask(task: BotTask, forBot: Bot) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Bot(activeClient.deleteTask(forBot.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun createTask(forRoom: Room, title: String?) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Room(activeClient.createRoomTask(forRoom.id, title))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun switchTask(task: BotTask, forRoom: Room) {
        if (task.threadId == forRoom.threadId) return
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Room(activeClient.switchRoomTask(forRoom.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun renameTask(task: BotTask, forRoom: Room, title: String) {
        val activeClient = client ?: return
        try {
            activeClient.renameRoomTask(forRoom.id, task.threadId, title)
            refresh()
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun deleteTask(task: BotTask, forRoom: Room) {
        val activeClient = client ?: return
        try {
            _state.update { it.apply(Frame.Room(activeClient.deleteRoomTask(forRoom.id, task.threadId))) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun updateProfile(patch: BotProfilePatch, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.updateProfile(forBot.id, patch)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    /**
     * The model catalog lives on the paired computer because availability
     * depends on which engines are installed and signed in there.
     */
    suspend fun modelInstances(): List<Instance> {
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.instances()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun updateModel(selection: ModelSelection, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.updateModel(forBot.id, selection)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun uploadAvatar(
        data: ByteArray,
        mime: String,
        forBot: Bot,
        crop: AvatarCrop,
    ): Bot? {
        val activeClient = client ?: return null
        return try {
            val avatarUrl = activeClient.uploadAvatar(data, mime)
            currentCoroutineContext().ensureActive()
            val current = _state.value.bot(forBot.id) ?: forBot
            updateProfile(
                BotProfilePatch(
                    avatarUrl = BotProfilePatch.AvatarURL.Set(avatarUrl),
                    avatarCrop = crop,
                ),
                current,
            )
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun generateAvatar(prompt: String, forBot: Bot): Bot? {
        val activeClient = client ?: return null
        return try {
            val updated = activeClient.generateAvatar(forBot.id, prompt)
            currentCoroutineContext().ensureActive()
            _state.update { it.apply(Frame.Bot(updated)) }
            updated
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun avatarData(forBot: Bot): ByteArray? {
        val path = forBot.avatarUrl ?: return null
        return try {
            client?.avatar(path)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            null
        }
    }

    suspend fun voiceOptions(): List<Voice> {
        val activeClient = client ?: return emptyList()
        return try {
            activeClient.voices()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            emptyList()
        }
    }

    suspend fun previewVoice(voiceId: String, forBot: Bot): ByteArray? {
        val activeClient = client ?: return null
        return try {
            activeClient.previewVoice("Hello, I'm ${forBot.name}.", voiceId)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun configStatus(): ConfigStatus? = try {
        client?.config()
    } catch (error: Throwable) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        null
    }

    suspend fun loadConnectorCatalog(): ConnectorCatalog? {
        val activeClient = client ?: return null
        return try {
            activeClient.connectorCatalog()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun loadAllConnectorStatuses(): ConnectorStatuses? {
        val activeClient = client ?: return null
        return try {
            activeClient.allConnectorStatuses()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun authorizeConnector(slug: String, alias: String?): URI? {
        val activeClient = client ?: return null
        return try {
            activeClient.authorizeConnector(slug, alias)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun loadRoutines(): RoutinesResponse {
        val activeClient = client ?: return RoutinesResponse(emptyList(), emptyList())
        return try {
            activeClient.routines()
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            RoutinesResponse(emptyList(), emptyList())
        }
    }

    suspend fun loadOverview(botId: String): BotOverview? {
        val activeClient = client ?: return null
        val connectionId = _connection.value?.id
        return try {
            val overview = activeClient.overview(botId)
            currentCoroutineContext().ensureActive()
            overview.takeIf { _connection.value?.id == connectionId }
        } catch (error: Throwable) {
            if (error is CancellationException) throw error
            if (_connection.value?.id == connectionId) _actionError.value = error.message
            null
        }
    }

    suspend fun loadRoutineRunAvailability(): RoutineRunAvailability? {
        val activeClient = client ?: return null
        return try {
            coroutineScope {
                val config = async { activeClient.config() }
                val instances = async { activeClient.instances() }
                RoutineRunAvailability(config.await(), instances.await())
            }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun saveRoutine(input: RoutineInput, id: String?): Routine? {
        val activeClient = client ?: return null
        return try {
            if (id == null) activeClient.createRoutine(input) else activeClient.updateRoutine(id, input)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun setRoutineEnabled(routine: Routine, enabled: Boolean): Routine? {
        val activeClient = client ?: return null
        return try {
            activeClient.setRoutineEnabled(routine.id, enabled)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun runRoutine(routine: Routine): RoutineRun? {
        val activeClient = client ?: return null
        return try {
            activeClient.runRoutine(routine.id)
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            null
        }
    }

    suspend fun deleteRoutine(routine: Routine): Boolean {
        val activeClient = client ?: return false
        return try {
            activeClient.deleteRoutine(routine.id)
            true
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            _actionError.value = error.message
            false
        }
    }

    suspend fun react(to: Message, inThreadId: String, emoji: String) {
        val activeClient = client ?: return
        try {
            val patched = activeClient.toggleReaction(inThreadId, to.id, emoji)
            _state.update { it.apply(Frame.MessagePatch(inThreadId, patched)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun edit(message: Message, forBot: Bot, text: String) {
        perform { it.edit(forBot.id, message.id, text) }
    }

    suspend fun switchVersion(to: Message, forBot: Bot) {
        val activeClient = client ?: return
        try {
            val leaf = activeClient.setActiveBranch(forBot.id, to.id)
            _state.update { it.apply(Frame.Thread(forBot.threadId, leaf)) }
        } catch (error: Throwable) {
            _actionError.value = error.message
        }
    }

    suspend fun export(threadId: String, format: String): ExportedTranscript? {
        val activeClient = client ?: return null
        return try {
            val exported = activeClient.export(threadId, format)
            ExportedTranscript(exported.data, exported.filename, exported.contentType)
        } catch (error: Throwable) {
            _actionError.value = error.message
            null
        }
    }

    private suspend fun perform(quietly: Boolean = false, body: suspend (CompanionClient) -> Unit) {
        val activeClient = client ?: return
        val connectionId = _connection.value?.id
        try {
            body(activeClient)
        } catch (error: APIError) {
            if (error.isUnauthorized) {
                gate.withLock {
                    // Only the live computer's 401 may mark this session revoked.
                    if (connectionId != null && _connection.value?.id == connectionId) {
                        _status.value = Status.Unauthorized
                    }
                }
            } else if (!quietly) {
                _actionError.value = error.message
            }
        } catch (error: Throwable) {
            if (!quietly) _actionError.value = error.message
        }
    }

    companion object {
        const val STORAGE_UNAVAILABLE_MESSAGE =
            "This phone couldn't read its saved connection just now."
        const val SPENT_QR_MESSAGE =
            "That pairing code was already used. Start pairing again on your computer and rescan the new QR code."

        /** High-entropy QR token — distinct from a retryable six-digit code. */
        fun isQrCredential(credential: String): Boolean =
            credential.startsWith("omb_pair_") ||
                !(credential.length == 6 && credential.all { it in '0'..'9' })
    }
}

/** Thrown only when another pairing redemption is already running. */
class PairingInProgressException : IllegalStateException("Another pairing attempt is already in progress.")

/** Thrown when a burned QR credential is presented again. */
class SpentPairingCredentialException : IllegalStateException(Session.SPENT_QR_MESSAGE)
