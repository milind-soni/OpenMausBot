package com.openmausbot.companion.core

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertificateException
import javax.net.ssl.SSLException
import kotlin.coroutines.cancellation.CancellationException

/** A successful HTTP response ended before the event stream established the session. */
internal class MissingStreamHelloException : IOException("Lost the connection.")

/**
 * Walks candidates without weakening credential protection: a cleartext route may upgrade to a
 * protected route, but once protected, rotation never returns to cleartext.
 *
 * See `FailoverTest.explicitLocalRouteCanUpgradeButNeverDowngradeAgain` and
 * `FailoverTest.walksProtectedCandidatesInOrderAndWraps`.
 */
class CandidateRotation(endpoints: List<CompanionEndpoint>) {
    var endpoints: List<CompanionEndpoint> = CompanionEndpoint.automaticCandidates(endpoints)
        private set

    private var index = 0

    val currentEndpoint: CompanionEndpoint? get() = endpoints.getOrNull(index)

    /**
     * Compatibility view for callers that only understand the old host list. Dialing code uses
     * [currentEndpoint] so it never loses a route's HTTPS scheme or distinct port.
     */
    val hosts: List<String> get() = endpoints.map { it.displayAddress }

    val current: String get() = currentEndpoint?.displayAddress.orEmpty()

    val count: Int get() = endpoints.size

    fun advance(): String = advanceEndpoint()?.displayAddress.orEmpty()

    /** Move to the next candidate and return it, wrapping past the end. */
    fun advanceEndpoint(): CompanionEndpoint? {
        if (endpoints.isEmpty()) return null
        index = (index + 1) % endpoints.size
        val next = currentEndpoint ?: return null
        // An explicit local route may upgrade to a protected route, but that upgrade is one-way.
        // Pruning the local route prevents a later wrap from downgrading the transport again.
        if (next.protectsCredentials && endpoints.any { !it.protectsCredentials }) {
            endpoints = endpoints.filter { it.protectsCredentials }
            index = endpoints.indexOfFirst { it.url == next.url }.takeIf { it >= 0 } ?: 0
        }
        return currentEndpoint
    }

    /**
     * Move only when the failure belongs to this route rather than to the pairing or to the
     * phone as a whole. Keeping that decision beside the rotation makes reconnects handle
     * address failures and HTTP gateway failures alike.
     *
     * A single remaining candidate never advances: the caller's retry loop simply dials that
     * same authority again after its backoff.
     */
    fun advanceEndpoint(after: Throwable): CompanionEndpoint? {
        if (endpoints.size <= 1 || !ConnectionAdvice.shouldTryAnotherRoute(after)) return null
        return advanceEndpoint()
    }

    fun promotedEndpoints(): List<CompanionEndpoint> {
        val winner = endpoints.getOrNull(index) ?: return endpoints
        return listOf(winner) + endpoints.filterIndexed { candidateIndex, _ -> candidateIndex != index }
    }

    fun promoted(): List<String> = promotedEndpoints().map { it.displayAddress }

    companion object {
        /**
         * Migration for bare host lists that carry no port of their own: a `.ts.net` name is
         * protected, `.local` and everything else are explicit-local cleartext, and every route
         * is assumed to answer on [CompanionEndpoint.DEFAULT_COMPANION_PORT].
         *
         * A saved [Connection] knows its own port and its own schemes, so it walks
         * `orderedEndpoints` instead — dialing through here would silently rewrite both.
         */
        fun ofHosts(hosts: List<String>): CandidateRotation = CandidateRotation(
            hosts.mapIndexedNotNull { position, host ->
                CompanionEndpoint.direct(host, CompanionEndpoint.DEFAULT_COMPANION_PORT, priority = position)
            },
        )
    }
}

enum class ConnectionFailure {
    CANNOT_FIND_HOST,
    CANNOT_CONNECT_TO_HOST,
    TIMED_OUT,
    SECURE_CONNECTION_FAILED,
    NOT_CONNECTED_TO_INTERNET,
    CANCELLED,
    NETWORK_CONNECTION_LOST,
    OTHER,
}

object ConnectionAdvice {
    /** Ordinary reverse-proxy failures. */
    private val PROXY_GATEWAY_STATUSES = 502..504

    /** The gateway family Cloudflare returns when a tunnel or its origin is unhealthy. */
    private val TUNNEL_GATEWAY_STATUSES = 520..530

    fun shouldTryAnotherHost(failure: ConnectionFailure): Boolean = failure in setOf(
        ConnectionFailure.CANNOT_FIND_HOST,
        ConnectionFailure.CANNOT_CONNECT_TO_HOST,
        ConnectionFailure.TIMED_OUT,
        ConnectionFailure.SECURE_CONNECTION_FAILED,
    )

    fun shouldTryAnotherHost(error: Throwable): Boolean =
        shouldTryAnotherHost(classify(error))

    /**
     * Pairing may replay the same idempotent request on another identified route after an
     * ambiguous transport result or a gateway failure. This is deliberately broader than
     * [shouldTryAnotherRoute]: an unreadable or lost pairing response is not proof that the
     * one-time credential was rejected, even when it is not an address failure.
     */
    fun shouldRetryPairingOnAnotherRoute(error: APIError): Boolean = when (error) {
        is APIError.Transport -> true
        is APIError.Status -> isGatewayStatus(error.code)
        APIError.BadUrl -> false
    }

    /**
     * Classify the errors another advertised route can actually repair: address and
     * TLS/certificate failures, plus the gateway statuses a tunnel returns when its origin is
     * unreachable. Application errors such as 400/401/404/500 deliberately stay on the route —
     * every other address would answer them identically.
     */
    fun shouldTryAnotherRoute(error: Throwable): Boolean {
        val status = statusCode(error)
        if (status != null) return isGatewayStatus(status)
        // Only a close before hello is a route failure; a truncated live stream retries in place.
        return generateSequence(error) { it.cause }.any { it is MissingStreamHelloException } ||
            shouldTryAnotherHost(classify(error))
    }

    /** The HTTP status this failure should be reported as, when a gateway produced it. */
    fun gatewayStatus(error: Throwable): Int? = statusCode(error)?.takeIf(::isGatewayStatus)

    private fun statusCode(error: Throwable): Int? =
        generateSequence(error) { it.cause }
            .filterIsInstance<APIError.Status>()
            .firstOrNull()
            ?.code

    private fun isGatewayStatus(status: Int): Boolean =
        status in PROXY_GATEWAY_STATUSES || status in TUNNEL_GATEWAY_STATUSES

    /** Map a transport failure to the URLError-shaped categories Session walks on. */
    fun classify(error: Throwable): ConnectionFailure {
        val chain = generateSequence(error) { it.cause }.toList()
        for (candidate in chain) {
            when (candidate) {
                is CancellationException -> return ConnectionFailure.CANCELLED
                is UnknownHostException -> return ConnectionFailure.CANNOT_FIND_HOST
                is ConnectException -> return ConnectionFailure.CANNOT_CONNECT_TO_HOST
                is SocketTimeoutException -> return ConnectionFailure.TIMED_OUT
                is SSLException -> return ConnectionFailure.SECURE_CONNECTION_FAILED
                // A rejected or untrusted certificate is a property of this route, not of the
                // pairing: another advertised route can repair it.
                is CertificateException -> return ConnectionFailure.SECURE_CONNECTION_FAILED
                is java.net.NoRouteToHostException -> return ConnectionFailure.TIMED_OUT
                is java.net.SocketException -> {
                    val detail = candidate.message.orEmpty().lowercase()
                    if ("network is unreachable" in detail || "no route" in detail) {
                        return ConnectionFailure.TIMED_OUT
                    }
                    if ("connection refused" in detail) {
                        return ConnectionFailure.CANNOT_CONNECT_TO_HOST
                    }
                    if ("reset" in detail || "broken pipe" in detail || "connection abort" in detail) {
                        return ConnectionFailure.NETWORK_CONNECTION_LOST
                    }
                }
            }
        }
        val detail = chain.joinToString(" ") { it.message.orEmpty() }.lowercase()
        return when {
            "unable to resolve host" in detail || "unknown host" in detail ->
                ConnectionFailure.CANNOT_FIND_HOST
            "failed to connect" in detail || "connection refused" in detail ->
                ConnectionFailure.CANNOT_CONNECT_TO_HOST
            "timeout" in detail || "timed out" in detail ->
                ConnectionFailure.TIMED_OUT
            "cleartext" in detail || "ssl" in detail || "tls" in detail ->
                ConnectionFailure.SECURE_CONNECTION_FAILED
            "offline" in detail || "no address associated" in detail ->
                ConnectionFailure.NOT_CONNECTED_TO_INTERNET
            else -> ConnectionFailure.OTHER
        }
    }

    fun message(
        failure: ConnectionFailure,
        host: String,
        port: Int,
        tryingNext: String? = null,
    ): String {
        val advice = when (failure) {
            ConnectionFailure.CANNOT_FIND_HOST ->
                "“$host” didn't resolve. If that's a Tailscale name, this phone may not be on the tailnet."
            ConnectionFailure.CANNOT_CONNECT_TO_HOST ->
                "Reached your computer, but Phone access isn't answering on port $port — open OpenMausBot → Settings → Phone."
            ConnectionFailure.TIMED_OUT ->
                "No route to your computer at $host — different network, or a firewall."
            ConnectionFailure.NOT_CONNECTED_TO_INTERNET -> "You're offline."
            else -> "Could not reach $host."
        }
        return advice + fallbackAdvice(tryingNext)
    }

    /** A tunnel or reverse proxy answered for the computer, and the computer did not. */
    fun message(
        gatewayStatus: Int,
        host: String,
        tryingNext: String? = null,
    ): String = "The route through $host is temporarily unavailable (HTTP $gatewayStatus)." +
        fallbackAdvice(tryingNext)

    fun message(
        error: Throwable,
        host: String,
        port: Int,
        tryingNext: String? = null,
    ): String {
        gatewayStatus(error)?.let { return message(it, host, tryingNext) }
        val failure = classify(error)
        return if (failure == ConnectionFailure.OTHER) {
            error.message?.takeIf { it.isNotBlank() } ?: message(failure, host, port, tryingNext)
        } else {
            message(failure, host, port, tryingNext)
        }
    }

    private fun fallbackAdvice(tryingNext: String?): String =
        tryingNext?.let { " Trying $it next." }.orEmpty() + " The app keeps retrying automatically."
}
