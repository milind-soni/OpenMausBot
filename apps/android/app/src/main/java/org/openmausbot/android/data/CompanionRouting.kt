package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.Base64

/** Why an address exists. The kind is display and policy metadata; the URL
 *  remains the complete dialing authority, so hosted HTTPS and local HTTP can
 *  live in the same fallback list without guessing a scheme from a hostname. */
enum class EndpointKind(val wire: String) {
    HOSTED("hosted"),
    TAILNET("tailnet"),
    LAN("lan"),
    BONJOUR("bonjour");

    companion object {
        fun fromWire(value: String): EndpointKind? = entries.firstOrNull { it.wire == value }
    }
}

enum class EndpointSecurity { PROTECTED, EXPLICIT_LOCAL }

/** One validated route to the desktop companion. Mirrors the iOS
 *  `CompanionEndpoint`: a route carries its own scheme, host and port. */
data class CompanionEndpoint(
    val url: String,
    val kind: EndpointKind,
    val priority: Int,
) {
    val securityClass: EndpointSecurity
        get() = if (kind == EndpointKind.HOSTED || kind == EndpointKind.TAILNET) {
            EndpointSecurity.PROTECTED
        } else {
            EndpointSecurity.EXPLICIT_LOCAL
        }

    val protectsCredentials: Boolean get() = securityClass == EndpointSecurity.PROTECTED
    val isSecure: Boolean get() = url.startsWith("https://")
    val host: String get() = hostOf(url)
    val port: Int get() = portOf(url)

    /** Host-only for direct routes, full HTTPS authority for hosted routes.
     *  Used in status copy, never for dialing. */
    val displayAddress: String
        get() = if (kind == EndpointKind.HOSTED || isSecure) url else if (port == 8810) host else "$host:$port"

    fun toJson(): JSONObject = JSONObject().apply {
        put("url", url)
        put("kind", kind.wire)
        put("priority", priority)
    }

    override fun toString(): String = url

    companion object {
        private const val MAX_PRIORITY = 1_000_000
        private const val MAX_ROUTE_BYTES = 8_192
        private const val MAX_ROUTES = 8
        private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

        /** Validate and canonicalise one route. Hosted routes require HTTPS;
         *  tailnet routes require an HTTP `.ts.net` name; direct routes use
         *  HTTP. A public URL with credentials, a path, a query or a fragment
         *  is never a companion base URL. */
        fun create(rawUrl: String, kind: EndpointKind, priority: Int): CompanionEndpoint? {
            if (priority !in 0..MAX_PRIORITY) return null
            val trimmed = rawUrl.trim()
            if (trimmed.isEmpty() || trimmed.toByteArray(Charsets.UTF_8).size > 2_048) return null
            val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val path = uri.rawPath
            if (!(path.isNullOrEmpty() || path == "/")) return null
            val host = canonicalHost(uri.host ?: return null)
            if (!validHost(host)) return null
            when (kind) {
                EndpointKind.HOSTED -> if (scheme != "https") return null
                EndpointKind.TAILNET -> if (scheme != "http" || !isTailnetHost(host)) return null
                EndpointKind.LAN, EndpointKind.BONJOUR -> if (scheme != "http") return null
            }
            val port = if (uri.port == -1) defaultPort(scheme) else uri.port
            if (port !in 1..65_535) return null
            return CompanionEndpoint(buildUrl(scheme, host, port), kind, priority)
        }

        fun fromJson(json: JSONObject): CompanionEndpoint? {
            val url = json.optString("url").takeIf { it.isNotBlank() } ?: return null
            val kind = EndpointKind.fromWire(json.optString("kind")) ?: return null
            if (!json.has("priority") || json.isNull("priority")) return null
            return create(url, kind, json.optInt("priority", Int.MIN_VALUE))
        }

        /** Unpadded base64url JSON typed array. A present-but-invalid value
         *  rejects the whole invite instead of quietly downgrading a hosted
         *  HTTPS QR to its legacy HTTP address. */
        fun decodeEndpoints(encoded: String): List<CompanionEndpoint>? {
            if (encoded.isEmpty() || encoded.toByteArray(Charsets.UTF_8).size > MAX_ROUTE_BYTES) return null
            if (!BASE64URL.matches(encoded)) return null
            val bytes = runCatching { Base64.getUrlDecoder().decode(encoded) }.getOrNull() ?: return null
            val array = runCatching { JSONArray(String(bytes, Charsets.UTF_8)) }.getOrNull() ?: return null
            if (array.length() !in 1..MAX_ROUTES) return null
            val parsed = (0 until array.length()).map { index ->
                array.optJSONObject(index)?.let(::fromJson) ?: return null
            }
            val stable = parsed.withIndex()
                .sortedWith(compareBy({ it.value.priority }, { it.index }))
                .map { it.value }
            val seen = HashSet<String>()
            return stable.filter { seen.add(it.url) }.ifEmpty { null }
        }

        fun direct(
            host: String,
            port: Int,
            kind: EndpointKind? = null,
            priority: Int,
        ): CompanionEndpoint? {
            val normalized = canonicalHost(host)
            if (normalized.isEmpty() || port !in 1..65_535) return null
            val resolved = kind ?: inferredDirectKind(normalized)
            return create(buildUrl("http", normalized, port), resolved, priority)
        }

        fun inferredDirectKind(host: String): EndpointKind {
            val canonical = canonicalHost(host)
            return when {
                isTailnetHost(canonical) -> EndpointKind.TAILNET
                canonical.endsWith(".local") -> EndpointKind.BONJOUR
                else -> EndpointKind.LAN
            }
        }

        /** The candidates a credential may walk automatically, in caller
         *  order. When the preferred route is protected, every cleartext
         *  candidate is removed. When it is local, that one exact route is
         *  the user's explicit choice and may be tried, followed only by
         *  routes which strengthen the transport. */
        fun automaticCandidates(candidates: List<CompanionEndpoint>): List<CompanionEndpoint> {
            val preferred = candidates.firstOrNull() ?: return emptyList()
            val seen = HashSet<String>()
            return candidates.filter { candidate ->
                if (!seen.add(candidate.url)) return@filter false
                if (preferred.protectsCredentials) {
                    candidate.protectsCredentials
                } else {
                    candidate.url == preferred.url || candidate.protectsCredentials
                }
            }
        }

        fun hostOf(url: String): String {
            val host = runCatching { URI(url).host }.getOrNull() ?: return ""
            return canonicalHost(host)
        }

        fun portOf(url: String): Int {
            val uri = runCatching { URI(url) }.getOrNull() ?: return 0
            return if (uri.port != -1) uri.port else defaultPort(uri.scheme?.lowercase() ?: "")
        }

        fun kindForOrigin(url: String): EndpointKind {
            val scheme = runCatching { URI(url).scheme?.lowercase() }.getOrNull()
            if (scheme == "https") return EndpointKind.HOSTED
            return inferredDirectKind(hostOf(url))
        }

        fun canonicalHost(raw: String): String {
            var host = raw.trim().lowercase()
            if (host.startsWith("[") && host.endsWith("]")) {
                host = host.substring(1, host.length - 1)
            }
            while (host.endsWith(".")) host = host.dropLast(1)
            return host
        }

        fun validHost(host: String): Boolean {
            if (host.isEmpty() || host.length > 253) return false
            if (host.contains(":")) return host.all { it.isLetterOrDigit() || it == ':' || it == '.' || it == '%' }
            if (host.any { it.isWhitespace() || it in "/?#[]@" }) return false
            val labels = host.split('.')
            return labels.isNotEmpty() && labels.all { label ->
                label.isNotEmpty() && label.all { it.isLetterOrDigit() || it == '-' || it == '_' }
            }
        }

        private fun isTailnetHost(host: String): Boolean =
            host.length > ".ts.net".length && host.endsWith(".ts.net")

        private fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80

        private fun buildUrl(scheme: String, host: String, port: Int): String {
            val authority = if (host.contains(":")) "[$host]" else host
            val suffix = if (port == defaultPort(scheme)) "" else ":$port"
            return "$scheme://$authority$suffix"
        }
    }
}

/** The ordered walk through a connection's stored routes. Advance on an
 *  address-shaped failure, promote on success. Advancing wraps rather than
 *  giving up; the reconnect loop already backs off. */
class CandidateRotation(endpoints: List<CompanionEndpoint>) {
    private val ordered = CompanionEndpoint.automaticCandidates(endpoints).toMutableList()
    private var index = 0

    val endpoints: List<CompanionEndpoint> get() = ordered
    val currentEndpoint: CompanionEndpoint? get() = ordered.getOrNull(index)
    val current: String get() = currentEndpoint?.url.orEmpty()
    val count: Int get() = ordered.size

    fun advance(): CompanionEndpoint? {
        if (ordered.isEmpty()) return null
        index = (index + 1) % ordered.size
        val next = currentEndpoint ?: return null
        // An explicit local route may upgrade to a protected route, but that
        // upgrade is one-way. Pruning the local route prevents a later wrap
        // from silently downgrading the bearer transport again.
        if (next.protectsCredentials && ordered.any { !it.protectsCredentials }) {
            val selectedUrl = next.url
            ordered.removeAll { !it.protectsCredentials }
            index = ordered.indexOfFirst { it.url == selectedUrl }.coerceAtLeast(0)
        }
        return currentEndpoint
    }

    /** Move only when the failure belongs to this route rather than to the
     *  pairing or the phone as a whole. */
    fun advanceAfter(error: Throwable): CompanionEndpoint? {
        if (ordered.size <= 1 || !ConnectionAdvice.shouldTryAnotherRoute(error)) return null
        return advance()
    }

    fun promotedEndpoints(): List<CompanionEndpoint> {
        if (!ordered.indices.contains(index)) return ordered
        return listOf(ordered[index]) + ordered.filterIndexed { i, _ -> i != index }
    }
}

/** None of the addresses advertised for a computer answered the companion
 *  health check. Kept distinct from a pairing rejection: the invite is still
 *  valid and the UI can offer Retry without scanning again. */
class PairingRouteError(
    val attemptedHosts: List<String>,
    val computerName: String? = null,
) : Exception() {
    override val message: String
        get() {
            val name = computerName?.trim().orEmpty()
            val computer = name.ifEmpty { "这台电脑" }
            val hosts = attemptedHosts.map { CompanionEndpoint.hostOf(it) }
            val advice = when {
                attemptedHosts.any { it.startsWith("https://") } ->
                    "无法连接到 $computer。请确认电脑已唤醒并打开 OpenMausBot，然后重试。"
                hosts.isNotEmpty() && hosts.all { it.endsWith(".ts.net") } ->
                    "手机无法通过 Tailscale 连接到 $computer。请确认手机已开启 Tailscale 并登录同一 tailnet，然后重试。"
                else ->
                    "手机无法在当前网络连接到 $computer。请把手机连接到与电脑相同的 Wi-Fi；" +
                        "如果已经连接，电脑防火墙可能拦截了 OpenMausBot；" +
                        "或者在电脑的“设置 → 远程访问”中登录，让手机从任何网络连接。"
            }
            return if (attemptedHosts.isEmpty()) advice else advice + "\n尝试过：" + attemptedHosts.joinToString(", ")
        }
}

/** An event stream that answered 200 and then ended before its `hello`. A
 *  live stream that later closes is the computer going away and reopens on
 *  the same route; one that never said hello never connected at all. */
class MissingStreamHelloException : IOException("Lost the connection.")

/** What to do with a connection failure: whether another stored address is
 *  worth trying, and whether the failure is authoritative. */
object ConnectionAdvice {
    fun shouldTryAnotherRoute(error: Throwable): Boolean {
        if (error is MissingStreamHelloException) return true
        if (error is ApiException) {
            return error.status in 502..504 || error.status in 520..530
        }
        return error is IOException
    }

    fun isAuthenticationFailure(error: Throwable): Boolean =
        error is ApiException && error.status == 401
}

// ---------------------------------------------------------------- connection

/** A copy dialing one complete route without changing its stored policy order
 *  or identity. */
fun PairedComputer.dialing(endpoint: CompanionEndpoint): PairedComputer {
    if (!allowsEndpoint(endpoint)) return this
    return copy(activeEndpoint = endpoint)
}

fun PairedComputer.currentBaseUrl(): String = activeEndpoint?.url ?: baseUrl

val PairedComputer.primaryEndpoint: CompanionEndpoint?
    get() = activeEndpoint ?: CompanionEndpoint.create(
        baseUrl,
        CompanionEndpoint.kindForOrigin(baseUrl),
        0,
    )

fun PairedComputer.primaryPort(): Int = activeEndpoint?.port ?: CompanionEndpoint.portOf(baseUrl).takeIf { it > 0 } ?: 8810

fun PairedComputer.allowsRouteKind(kind: EndpointKind): Boolean {
    val kinds = allowedRouteKinds ?: return true
    return kind == EndpointKind.HOSTED || kinds.contains(kind)
}

fun PairedComputer.allowsEndpoint(endpoint: CompanionEndpoint): Boolean {
    if (!allowsRouteKind(endpoint.kind)) return false
    if (endpoint.securityClass == EndpointSecurity.EXPLICIT_LOCAL && allowedRouteKinds != null) {
        return allowedLocalRouteUrls?.contains(endpoint.url) == true
    }
    return true
}

private fun endpointAllowed(
    endpoint: CompanionEndpoint,
    kinds: Set<EndpointKind>,
    localUrls: Set<String>,
): Boolean {
    if (!(endpoint.kind == EndpointKind.HOSTED || kinds.contains(endpoint.kind))) return false
    if (endpoint.securityClass == EndpointSecurity.EXPLICIT_LOCAL) return localUrls.contains(endpoint.url)
    return true
}

fun PairedComputer.endpointsAllowedByRoutePolicy(
    candidates: List<CompanionEndpoint>,
): List<CompanionEndpoint> = candidates.filter { allowsEndpoint(it) }

/** Every complete route in policy order. Typed endpoints win over the legacy
 *  fields because they can represent hosted HTTPS. A protected route that
 *  already carried the bearer leads when the priority sort would otherwise
 *  hand the rotation to a cleartext route. */
fun PairedComputer.orderedEndpoints(): List<CompanionEndpoint> {
    val typed = endpointRoutes.toMutableList()
    val candidates: List<CompanionEndpoint>
    if (typed.isNotEmpty()) {
        activeEndpoint?.let { active ->
            if (typed.none { it.url == active.url }) typed.add(active)
        }
        var sorted = typed.withIndex()
            .sortedWith(compareBy({ it.value.priority }, { it.index }))
            .map { it.value }
        val active = activeEndpoint?.let { a -> sorted.firstOrNull { it.url == a.url } }
        if (active != null && active.protectsCredentials && sorted.firstOrNull()?.protectsCredentials == false) {
            sorted = listOf(active) + sorted.filter { it.url != active.url }
        }
        candidates = sorted
    } else {
        val out = mutableListOf<CompanionEndpoint>()
        val seen = HashSet<String>()
        (listOf(baseUrl) + endpoints).forEach { raw ->
            val route = CompanionEndpoint.create(raw, CompanionEndpoint.kindForOrigin(raw), 0) ?: return@forEach
            if (seen.add(route.url)) out.add(route)
        }
        val port = primaryPort()
        hosts.forEachIndexed { index, host ->
            val route = CompanionEndpoint.direct(host, port, null, out.size + index) ?: return@forEachIndexed
            if (seen.add(route.url)) out.add(route)
        }
        candidates = out
    }
    return candidates.filter { allowsEndpoint(it) }.distinctBy { it.url }.take(8)
}

/** The subset an automatic reconnect may try. A policy-bound connection first
 *  removes route kinds the person did not select; the transport ratchet then
 *  removes unsafe cleartext fallbacks. */
fun PairedComputer.automaticEndpoints(): List<CompanionEndpoint> =
    CompanionEndpoint.automaticCandidates(orderedEndpoints())

/** The routes the one-time pairing walk may try. Every consented local
 *  address is tried, not only the first; when a protected route leads,
 *  cleartext still never follows it. */
fun PairedComputer.pairingEndpoints(): List<CompanionEndpoint> {
    val routes = orderedEndpoints()
    return if (allowedRouteKinds != null && routes.firstOrNull()?.protectsCredentials == false) {
        routes
    } else {
        automaticEndpoints()
    }
}

/** Bind a new pairing to the route the QR/manual choice actually selected.
 *  Hosted HTTPS is always retained as a safe future upgrade. */
fun PairedComputer.establishRoutePolicyFromInvite(everyLocalRoute: Boolean = false): PairedComputer {
    val selected = activeEndpoint ?: primaryEndpoint
    val port = primaryPort()
    val invited = if (everyLocalRoute) {
        endpointRoutes + hosts.mapNotNull { CompanionEndpoint.direct(it, port, null, 0) }
    } else {
        emptyList()
    }
    return consent(selected, invited)
}

/** After a pairing walk, bind consent to one route again: the local address
 *  that redeemed the credential, or the invite's selected route when a
 *  protected route redeemed it. */
fun PairedComputer.pinRouteConsent(
    winner: CompanionEndpoint?,
    invite: PairedComputer,
): PairedComputer {
    val local = winner?.takeIf { !it.protectsCredentials }
    return consent(local ?: invite.activeEndpoint ?: invite.primaryEndpoint, emptyList())
}

private fun PairedComputer.consent(
    selected: CompanionEndpoint?,
    alsoLocal: List<CompanionEndpoint>,
): PairedComputer {
    val local = if (selected?.securityClass == EndpointSecurity.EXPLICIT_LOCAL) {
        (listOf(selected) + alsoLocal).filter { it.securityClass == EndpointSecurity.EXPLICIT_LOCAL }
    } else {
        emptyList()
    }
    val kinds: Set<EndpointKind> = when (selected?.kind) {
        null, EndpointKind.HOSTED -> setOf(EndpointKind.HOSTED)
        else -> (setOf(selected.kind, EndpointKind.HOSTED) + local.map { it.kind }).toSet()
    }
    val localUrls = local.map { it.url }.toSet()
    val keptRoutes = endpointRoutes
        .filter { endpointAllowed(it, kinds, localUrls) }
        .distinctBy { it.url }
        .take(8)
    val keptHosts = hosts
        .filter { host ->
            CompanionEndpoint.direct(host, primaryPort(), null, 0)
                ?.let { endpointAllowed(it, kinds, localUrls) } == true
        }
        .distinct()
        .take(8)
    return copy(
        allowedRouteKinds = kinds,
        allowedLocalRouteUrls = localUrls,
        endpointRoutes = keptRoutes,
        hosts = keptHosts,
        endpoints = keptRoutes.map { it.url },
    )
}

/** Apply the routes returned when a pairing credential is redeemed. The
 *  response may advertise every interface on the Mac, but it cannot widen the
 *  consent recorded from the invite which carried that credential. */
fun PairedComputer.applyPairingAdvertisement(
    advertisedHosts: List<String>?,
    advertisedEndpoints: List<CompanionEndpoint>?,
): PairedComputer {
    var next = this
    if (!advertisedHosts.isNullOrEmpty()) {
        val kept = advertisedHosts
            .filter { host ->
                val route = CompanionEndpoint.direct(host, primaryPort(), null, 0) ?: return@filter false
                allowsEndpoint(route)
            }
            .distinct()
            .take(8)
        next = next.copy(hosts = kept)
    }
    if (!advertisedEndpoints.isNullOrEmpty()) {
        val accepted = advertisedEndpoints.filter { allowsEndpoint(it) }
        if (accepted.isNotEmpty()) {
            next = next.copy(
                endpointRoutes = accepted.distinctBy { it.url }.take(8),
                endpoints = accepted.distinctBy { it.url }.take(8).map { it.url },
            )
        }
    }
    return next
}

/** Apply an authenticated endpoint snapshot. The caller owns the exact client
 *  carrying the current live stream; this value chooses what a future
 *  reconnect or launch may dial. */
fun PairedComputer.reconcile(metadata: ConnectionMetadata): PairedComputer {
    val cleanedName = metadata.serverName
        .trim()
        .filter { !it.isISOControl() }
        .take(80)
    val previousActive = activeEndpoint?.takeIf { allowsEndpoint(it) }
    val refreshed = metadata.endpoints.filter { allowsEndpoint(it) }.distinctBy { it.url }.take(8)
    val nextActive = when {
        previousActive != null && refreshed.any { it.url == previousActive.url } ->
            refreshed.first { it.url == previousActive.url }
        refreshed.any { it.protectsCredentials } ->
            refreshed.first { it.protectsCredentials }
        previousActive != null ->
            CompanionEndpoint.create(previousActive.url, previousActive.kind, 0)
        else ->
            refreshed.firstOrNull()
    }
    var nextRoutes = refreshed
    if (nextActive != null && refreshed.none { it.url == nextActive.url }) {
        nextRoutes = (listOf(nextActive) + refreshed).take(8)
    }
    val keptHosts = metadata.hosts
        ?.filter { host ->
            val route = CompanionEndpoint.direct(host, nextActive?.port ?: primaryPort(), null, 0)
                ?: return@filter false
            if (allowedRouteKinds == null) return@filter nextRoutes.any { it.url == route.url } || allowsEndpoint(route)
            endpointAllowed(route, allowedRouteKinds, allowedLocalRouteUrls ?: emptySet())
        }
        ?.distinct()
        ?.take(8)
        ?: hosts
    return copy(
        serverName = cleanedName.ifEmpty { serverName },
        hosts = keptHosts,
        endpointRoutes = nextRoutes,
        endpoints = nextRoutes.map { it.url },
        activeEndpoint = nextActive,
        baseUrl = nextActive?.url ?: baseUrl,
    )
}

/** `winner` becomes the route dialed first from now on. */
fun PairedComputer.promote(winner: CompanionEndpoint): PairedComputer {
    if (!allowsEndpoint(winner)) return this
    val routes = (endpointRoutes + winner).distinctBy { it.url }.take(8)
    val nextHosts = if (winner.kind != EndpointKind.HOSTED) {
        (listOf(winner.host) + hosts).distinct().take(8)
    } else {
        hosts
    }
    return copy(
        activeEndpoint = winner,
        baseUrl = winner.url,
        endpointRoutes = routes,
        endpoints = routes.map { it.url },
        hosts = nextHosts,
    )
}
