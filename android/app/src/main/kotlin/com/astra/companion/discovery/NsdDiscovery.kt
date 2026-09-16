package com.astra.companion.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import androidx.annotation.RequiresApi
import com.astra.companion.core.Connection
import java.net.InetAddress
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged

data class DiscoveredService(
    val name: String,
    val host: String?,
    val port: Int?,
) {
    val id: String get() = name
}

/**
 * The chosen service as a computer to pair with, or null when NSD listed a name
 * but never answered with an address.
 *
 * Top-level rather than a member of [NsdDiscovery] because this refusal is the
 * only way the discovery path can fail to produce a `host:port`, and the pairing
 * confirmation is not allowed to open without one (§6). [NsdDiscovery] needs a
 * `Context` to exist; this does not, so the refusal can be pinned by a test.
 */
fun DiscoveredService.toConnection(): Connection? {
    val resolvedHost = host ?: return null
    val resolvedPort = port ?: return null
    return Connection(name = name, host = Connection.urlHost(resolvedHost), port = resolvedPort)
}

/**
 * Discovery surface for the UI. Distinguishes "still looking", "looked and
 * found nothing", and "permission/policy failure" — NsdManager's silent empty
 * list is the Android twin of the iOS Bonjour Info.plist footgun (§19).
 */
sealed interface DiscoveryState {
    data object Idle : DiscoveryState
    data class Active(
        val browsing: Boolean,
        val found: List<DiscoveredService>,
        val failure: String? = null,
        /** True when the browser is ready and the result set is empty. */
        val emptyWhileBrowsing: Boolean = false,
    ) : DiscoveryState
}

/**
 * When a failed browse is worth starting again, and how long to wait.
 *
 * iOS recreates its DNS-SD browser on a *defunct connection* — the system
 * browser went away, which says nothing about the companion or its Tailscale
 * route — up to three times with an incremental 350ms delay, and only then goes
 * terminal. `FAILURE_MAX_LIMIT` is the Android shape of the same thing: the
 * platform is momentarily out of discovery slots, usually because another app
 * just took them. Everything else — a policy refusal, an internal error — is a
 * state that retrying cannot improve.
 *
 * Bounded on purpose: a persistent local-network problem must not become a
 * retry loop holding a multicast wake.
 */
internal object DiscoveryRetry {
    const val MAX_ATTEMPTS = 3
    const val BASE_DELAY_MILLIS = 350L

    /** Shown while a retry is actually pending, and only then. */
    const val RETRYING = "Local discovery was interrupted. Retrying…"

    fun isRecoverable(errorCode: Int): Boolean = errorCode == NsdManager.FAILURE_MAX_LIMIT

    fun canRetry(attemptsSoFar: Int, errorCode: Int): Boolean =
        isRecoverable(errorCode) && attemptsSoFar < MAX_ATTEMPTS

    /** Incremental, as iOS has it: 350ms, 700ms, 1050ms. */
    fun delayFor(attempt: Int): Long = BASE_DELAY_MILLIS * attempt
}

/**
 * A resolve that failed is a name with no address, and a name with no address is
 * a computer the pairing screen cannot offer. The platform fails these for
 * reasons that pass: on API 33 and below `NsdManager.resolveService` refuses
 * with `FAILURE_ALREADY_ACTIVE` while another resolve is in flight, and a browse
 * that finds three computers at once starts three.
 *
 * So: one more try, after a beat, and then the name is left out — the same
 * bounded shape [DiscoveryRetry] gives the browse, for the same reason. The
 * retry runs in the Flow's own scope, so leaving the screen cancels it.
 */
internal object ResolveRetry {
    const val MAX_ATTEMPTS = 2
    const val DELAY_MILLIS = 350L

    fun canRetry(attemptsSoFar: Int): Boolean = attemptsSoFar < MAX_ATTEMPTS
}

/**
 * Multicast lock held only while an NSD browse is actually active.
 * [releaseIfHeld] is idempotent so terminal failure + [awaitClose] cannot
 * double-release.
 */
internal interface MulticastLockHandle {
    val isHeld: Boolean
    fun releaseIfHeld()
}

internal fun WifiManager.MulticastLock.asHandle(): MulticastLockHandle =
    object : MulticastLockHandle {
        override val isHeld: Boolean
            get() = this@asHandle.isHeld

        override fun releaseIfHeld() {
            runCatching {
                if (this@asHandle.isHeld) release()
            }
        }
    }

/**
 * Testable browse loop: [acquireMulticastLock] runs only when the cold Flow is
 * collected (never on Flow construction), so a never-collected Flow acquires
 * nothing and each new collection gets a fresh lock handle. Released on
 * terminal start failure (and again safely from [awaitClose]).
 */
internal fun browseDiscoveryFlow(
    serviceType: String,
    acquireMulticastLock: () -> MulticastLockHandle?,
    startBrowse: (NsdManager.DiscoveryListener) -> Unit,
    stopBrowse: (NsdManager.DiscoveryListener) -> Unit,
    /**
     * Resolve one service. The callback receives the resolved info, or **null**
     * when the platform refused — a refusal the flow answers with one retry
     * rather than by silently dropping the computer from the list.
     */
    resolveService: (NsdServiceInfo, (NsdServiceInfo?) -> Unit) -> Unit,
    /**
     * Stop every resolve still listening. Called from [awaitClose] because the
     * API 34 resolve is a *registration*: it is released when the service is
     * updated, and otherwise not at all, so a browse that closes mid-resolve
     * would leave one behind for the life of the process.
     */
    stopResolves: () -> Unit = {},
    hostAddress: (NsdServiceInfo) -> String?,
    failureMessage: (Int) -> String,
): Flow<DiscoveryState> = callbackFlow {
    // Per-collection: acquire here, not at Flow construction.
    val multicastLock = acquireMulticastLock()
    val resolved = ConcurrentHashMap<String, DiscoveredService>()
    var browsing = false
    var failure: String? = null
    var lockReleased = false

    fun releaseLockOnce() {
        if (lockReleased) return
        lockReleased = true
        multicastLock?.releaseIfHeld()
    }

    fun emit() {
        val found = resolved.values.sortedBy { it.name.lowercase() }
        trySend(
            DiscoveryState.Active(
                browsing = browsing,
                found = found,
                failure = failure,
                emptyWhileBrowsing = browsing && found.isEmpty() && failure == null,
            ),
        )
    }

    trySend(DiscoveryState.Active(browsing = false, found = emptyList()))

    var attempts = 0
    var started = false
    // Assigned below; the listener needs to reach the starter to retry, and the
    // starter needs to build a listener.
    var startAttempt: (() -> Unit)? = null

    fun terminal(message: String) {
        failure = message
        emit()
        releaseLockOnce()
        close()
    }

    fun attemptResolve(service: NsdServiceInfo, attemptsSoFar: Int) {
        resolveService(service) { info ->
            if (info == null) {
                if (ResolveRetry.canRetry(attemptsSoFar)) {
                    launch {
                        delay(ResolveRetry.DELAY_MILLIS)
                        attemptResolve(service, attemptsSoFar + 1)
                    }
                }
                return@resolveService
            }
            resolved[info.serviceName] = DiscoveredService(
                name = info.serviceName,
                host = hostAddress(info),
                port = info.port.takeIf { it > 0 },
            )
            emit()
        }
    }

    fun newListener(): NsdManager.DiscoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String) {
            browsing = true
            failure = null
            emit()
        }

        override fun onServiceFound(service: NsdServiceInfo) {
            if (service.serviceType != serviceType && !service.serviceType.contains("astra")) {
                return
            }
            attemptResolve(service, attemptsSoFar = 1)
        }

        override fun onServiceLost(service: NsdServiceInfo) {
            resolved.remove(service.serviceName)
            emit()
        }

        override fun onDiscoveryStopped(regType: String) {
            browsing = false
            emit()
        }

        override fun onStartDiscoveryFailed(regType: String, errorCode: Int) {
            browsing = false
            // This listener never registered, so nothing is left to stop.
            started = false
            if (!DiscoveryRetry.canRetry(attempts, errorCode)) {
                // No active browse — drop the lock and close so the collector
                // cannot hold a multicast wake for the screen lifetime.
                terminal(failureMessage(errorCode))
                return
            }
            attempts += 1
            failure = DiscoveryRetry.RETRYING
            emit()
            launch {
                delay(DiscoveryRetry.delayFor(attempts))
                // Leaving the screen during the backoff cancels this scope, so a
                // retry never outlives the collector.
                startAttempt?.invoke()
            }
        }

        override fun onStopDiscoveryFailed(regType: String, errorCode: Int) {
            browsing = false
            failure = failureMessage(errorCode)
            emit()
        }
    }

    var activeListener: NsdManager.DiscoveryListener? = null
    startAttempt = {
        // A fresh listener per attempt, as iOS builds a fresh browser: a listener
        // the framework has already rejected must not be handed back to it.
        val listener = newListener()
        activeListener = listener
        try {
            startBrowse(listener)
            started = true
        } catch (error: SecurityException) {
            started = false
            terminal(
                "Local Network access is off. Enable nearby devices permission, " +
                    "or enter a Tailscale address below.",
            )
        } catch (error: Exception) {
            started = false
            terminal(
                error.message
                    ?: "Local discovery isn't available right now. " +
                    "Enter the address shown in Phone settings below.",
            )
        }
    }
    startAttempt.invoke()

    awaitClose {
        if (started) activeListener?.let { runCatching { stopBrowse(it) } }
        stopResolves()
        releaseLockOnce()
    }
}.distinctUntilChanged()

/**
 * The API 34 side of a resolve, with the platform as two lambdas so its release
 * rules can be *observed* rather than asserted about the source.
 *
 * `registerServiceInfoCallback` is a subscription, not a question:
 * `NsdManager` documents that `onServiceUpdated` "will only be called once the
 * service is found, so may never be called if the service is never present".
 * Releasing only there — which is what the AOSP sample shows, because the sample
 * assumes the service is there — leaves a live registration behind for every
 * announced service that then goes quiet, and for every resolve still in flight
 * when the pairing screen closes. Each one is a binder registration in the system
 * server, an mDNS subscription on the network, and a strong reference to the Flow
 * that asked for it.
 *
 * So every terminal outcome releases, and [stopAll] releases whatever a closing
 * browse left behind. A registration that never happened is not released:
 * `onServiceInfoCallbackRegistrationFailed` is documented as "exactly once ... No
 * other callback will be sent in that case", and unregistering an unknown
 * listener throws on devices below T extension 22.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class ServiceInfoResolver(
    private val unregister: (NsdManager.ServiceInfoCallback) -> Unit,
) {
    private val registered: MutableSet<NsdManager.ServiceInfoCallback> =
        Collections.newSetFromMap(ConcurrentHashMap())

    /** Test / diagnostics: registrations still listening. */
    val outstanding: Int get() = registered.size

    /**
     * Start one resolve. [register] performs the platform registration for the
     * service being resolved; [onResolved] receives the resolved info once, or
     * null when the platform refused.
     */
    fun resolve(
        register: (NsdManager.ServiceInfoCallback) -> Unit,
        onResolved: (NsdServiceInfo?) -> Unit,
    ) {
        var answered = false
        fun answer(info: NsdServiceInfo?) {
            if (answered) return
            answered = true
            onResolved(info)
        }

        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {
                registered.remove(this)
                answer(null)
            }

            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
                release(this)
                answer(serviceInfo)
            }

            override fun onServiceLost() {
                // The service may come back, but this resolve is a question with an
                // answer, not a subscription. A later announcement arrives as
                // another onServiceFound and starts a fresh one.
                release(this)
                answer(null)
            }

            override fun onServiceInfoCallbackUnregistered() {
                registered.remove(this)
            }
        }
        registered.add(callback)
        try {
            register(callback)
        } catch (error: Exception) {
            registered.remove(callback)
            answer(null)
        }
    }

    /** Release every registration still listening — the browse is closing. */
    fun stopAll() {
        val pending = registered.toList()
        registered.clear()
        pending.forEach { runCatching { unregister(it) } }
    }

    private fun release(callback: NsdManager.ServiceInfoCallback) {
        if (!registered.remove(callback)) return
        runCatching { unregister(callback) }
    }
}

/**
 * What a screen needs from discovery, and no more.
 *
 * It is an interface so that the timing rule this pass installs — nothing
 * browses the network until somebody opens the list — can be *observed* by a
 * test that mounts the screen, rather than asserted about the source. A fake
 * that records when it is collected answers the question "did entering this
 * screen start a search?"; no assertion about a boolean can.
 *
 * [NsdDiscovery] is the only production implementation.
 */
interface CompanionDiscovery {
    /**
     * A cold Flow: collecting it starts a browse and cancelling the collection
     * stops it, so *when it is collected* is the whole of the timing question.
     */
    fun discover(): Flow<DiscoveryState>
}

/**
 * NsdManager wrapper for `_astra._tcp`, exposed as a Flow of [DiscoveryState].
 */
class NsdDiscovery(
    context: Context,
    private val serviceType: String = SERVICE_TYPE,
) : CompanionDiscovery {
    private val appContext = context.applicationContext
    private val nsdManager = appContext.getSystemService(NsdManager::class.java)
    private val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    private val resolveExecutor: Executor = Executors.newSingleThreadExecutor()
    private val resolver = if (Build.VERSION.SDK_INT >= 34) {
        ServiceInfoResolver(
            unregister = { callback -> nsdManager?.unregisterServiceInfoCallback(callback) },
        )
    } else {
        null
    }

    override fun discover(): Flow<DiscoveryState> {
        if (nsdManager == null) {
            return kotlinx.coroutines.flow.flow {
                emit(
                    DiscoveryState.Active(
                        browsing = false,
                        found = emptyList(),
                        failure = "Local discovery isn't available right now. Enter the address shown in Phone settings below.",
                    ),
                )
            }
        }

        // mDNS/NSD needs the multicast lock on Android 12 and earlier, and on
        // Android 13 below T extension 7 — without it browse silently returns
        // nothing even when NEARBY_WIFI_DEVICES is granted. Acquire only when
        // the cold Flow is collected so close→reopen gets a fresh held lock.
        return browseDiscoveryFlow(
            serviceType = serviceType,
            acquireMulticastLock = ::acquireMulticastLock,
            startBrowse = { listener ->
                nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
            },
            stopBrowse = { listener ->
                nsdManager.stopServiceDiscovery(listener)
            },
            resolveService = { service, onResolved -> resolve(service, onResolved) },
            stopResolves = {
                if (Build.VERSION.SDK_INT >= 34) resolver?.stopAll()
            },
            hostAddress = ::hostAddress,
            failureMessage = ::failureMessage,
        )
    }

    private fun acquireMulticastLock(): MulticastLockHandle? =
        wifiManager
            ?.createMulticastLock(MULTICAST_LOCK_TAG)
            ?.apply {
                setReferenceCounted(false)
                acquire()
            }
            ?.asHandle()

    /**
     * One resolve attempt, reporting null when the platform refused so the browse
     * can decide whether to try again. Pre-34 `resolveService` is a one-shot call
     * with nothing to release; API 34 goes through [ServiceInfoResolver], which
     * holds the registrations `awaitClose` hands back.
     */
    private fun resolve(service: NsdServiceInfo, onResolved: (NsdServiceInfo?) -> Unit) {
        val manager = nsdManager ?: return onResolved(null)
        if (Build.VERSION.SDK_INT >= 34) {
            resolver?.resolve(
                register = { callback ->
                    manager.registerServiceInfoCallback(service, resolveExecutor, callback)
                },
                onResolved = onResolved,
            ) ?: onResolved(null)
        } else {
            @Suppress("DEPRECATION")
            manager.resolveService(
                service,
                object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) =
                        onResolved(null)
                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) = onResolved(serviceInfo)
                },
            )
        }
    }

    private fun hostAddress(info: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= 34) {
            val addresses = info.hostAddresses
            if (!addresses.isNullOrEmpty()) {
                return formatAddress(addresses.first())
            }
        }
        @Suppress("DEPRECATION")
        return info.host?.let(::formatAddress)
    }

    private fun formatAddress(address: InetAddress): String {
        val host = address.hostAddress ?: return address.hostName
        return Connection.urlHost(host)
    }

    private fun failureMessage(errorCode: Int): String = when (errorCode) {
        NsdManager.FAILURE_INTERNAL_ERROR ->
            "Local discovery isn't available right now. Enter the address shown in Phone settings below."
        NsdManager.FAILURE_MAX_LIMIT ->
            // Only reached once the retries are spent — nothing is retrying now.
            "Local discovery keeps getting interrupted on this phone. " +
                "Enter the address shown in Phone settings below."
        else ->
            "Local Network access is off. Enable nearby devices permission, or enter a Tailscale address below."
    }

    companion object {
        const val SERVICE_TYPE = "_astra._tcp."
        const val MULTICAST_LOCK_TAG = "astra-nsd"
    }
}
