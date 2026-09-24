package com.openmausbot.companion.core

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

@Serializable
data class Connection(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int,
    val hosts: List<String>? = null,
    val activeEndpoint: CompanionEndpoint? = null,
    val endpoints: List<CompanionEndpoint>? = null,
    /**
     * Route kinds explicitly authorized when this pairing was created. Null is reserved for
     * connections saved before route consent existed and retains their legacy behavior.
     */
    val allowedRouteKinds: Set<CompanionEndpointKind>? = null,
    /** Exact normalized cleartext origins shown on the pairing confirmation. */
    val allowedLocalRouteURLs: Set<String>? = null,
    val serverEnvironmentId: String? = null,
    val serverScopes: List<String>? = null,
) {
    val pairedWithServer: Boolean get() = serverEnvironmentId != null

    val baseUrl: URI?
        get() {
            activeEndpoint?.let { endpoint ->
                return endpoint.baseUrl.takeIf { allowsEndpoint(endpoint) }
            }
            val endpoint = CompanionEndpoint.direct(host, port, priority = 0) ?: return null
            if (!allowsEndpoint(endpoint)) return null
            return runCatching {
                val normalized = urlHost(host).replace("%", "%25")
                URI("http://$normalized:$port")
            }.getOrNull()
        }

    val displayAddress: String
        get() = activeEndpoint?.displayAddress ?: if (port == CompanionEndpoint.DEFAULT_COMPANION_PORT) {
            host
        } else {
            "$host:$port"
        }

    /** The normalized origin whose authority the pairing confirmation authorizes. */
    val pairingConsentOrigin: String
        get() = activeEndpoint?.url
            ?: CompanionEndpoint.direct(host, port, priority = 0)?.url
            ?: displayAddress

    /** Hosted is the only universally allowed upgrade once an explicit policy exists. */
    fun allowsRouteKind(kind: CompanionEndpointKind): Boolean =
        allowedRouteKinds == null || kind == CompanionEndpointKind.HOSTED || kind in allowedRouteKinds

    /** Local cleartext additionally requires the exact normalized origin shown to the user. */
    fun allowsEndpoint(endpoint: CompanionEndpoint): Boolean {
        if (!allowsRouteKind(endpoint.kind)) return false
        if (endpoint.securityClass != CompanionEndpointSecurityClass.EXPLICIT_LOCAL || allowedRouteKinds == null) {
            return true
        }
        return allowedLocalRouteURLs?.contains(endpoint.url) == true
    }

    fun endpointsAllowedByRoutePolicy(candidates: List<CompanionEndpoint>): List<CompanionEndpoint> =
        candidates.filter(::allowsEndpoint)

    /** Bind a new pairing to its selected route before any probe or credential redemption. */
    fun establishingRoutePolicyFromInvite(): Connection {
        val selected = activeEndpoint
            ?: CompanionEndpoint.direct(host, port, priority = 0)
        val kinds = when (selected?.kind) {
            CompanionEndpointKind.HOSTED, null -> setOf(CompanionEndpointKind.HOSTED)
            CompanionEndpointKind.TAILNET -> setOf(
                CompanionEndpointKind.TAILNET,
                CompanionEndpointKind.HOSTED,
            )
            CompanionEndpointKind.LAN -> setOf(
                CompanionEndpointKind.LAN,
                CompanionEndpointKind.HOSTED,
            )
            CompanionEndpointKind.BONJOUR -> setOf(
                CompanionEndpointKind.BONJOUR,
                CompanionEndpointKind.HOSTED,
            )
        }
        val localURLs = if (selected?.securityClass == CompanionEndpointSecurityClass.EXPLICIT_LOCAL) {
            setOf(selected.url)
        } else {
            emptySet()
        }
        val policy = copy(allowedRouteKinds = kinds, allowedLocalRouteURLs = localURLs)
        return policy.copy(
            endpoints = endpoints?.let(policy::endpointsAllowedByRoutePolicy)?.take(MAX_ENDPOINTS),
            hosts = hosts?.let(policy::advertisedHostsAllowedByRoutePolicy)?.take(MAX_ENDPOINTS),
        )
    }

    /** Apply a pairing response without letting its full interface list widen consent. */
    fun applyingPairingAdvertisement(
        advertisedHosts: List<String>?,
        advertisedEndpoints: List<CompanionEndpoint>?,
    ): Connection {
        var updated = this
        if (!advertisedHosts.isNullOrEmpty()) {
            updated = updated.copy(
                hosts = updated.advertisedHostsAllowedByRoutePolicy(advertisedHosts).take(MAX_ENDPOINTS),
            )
        }
        if (!advertisedEndpoints.isNullOrEmpty()) {
            val accepted = updated.endpointsAllowedByRoutePolicy(advertisedEndpoints)
            if (accepted.isNotEmpty()) updated = updated.copy(endpoints = accepted.take(MAX_ENDPOINTS))
        }
        return updated
    }

    /** A hand-entered route is fresh consent and replaces, rather than widens, the old policy. */
    fun resettingRoutePolicy(selected: CompanionEndpoint): Connection {
        val previousEndpoints = orderedEndpoints
        val kinds = setOf(selected.kind, CompanionEndpointKind.HOSTED)
        val localURLs = if (selected.securityClass == CompanionEndpointSecurityClass.EXPLICIT_LOCAL) {
            setOf(selected.url)
        } else {
            emptySet()
        }
        val policy = copy(
            host = selected.host,
            port = selected.port,
            activeEndpoint = selected,
            allowedRouteKinds = kinds,
            allowedLocalRouteURLs = localURLs,
        )
        return policy.copy(
            endpoints = (listOf(selected) + policy.endpointsAllowedByRoutePolicy(previousEndpoints)
                .filterNot { it.url == selected.url }).take(MAX_ENDPOINTS),
            hosts = policy.advertisedHostsAllowedByRoutePolicy(
                listOf(selected.host) + hosts.orEmpty(),
            ).take(MAX_ENDPOINTS),
        )
    }

    val orderedHosts: List<String>
        get() = advertisedHostsAllowedByRoutePolicy(listOf(host) + hosts.orEmpty())

    /**
     * Every complete route this connection may dial, in selection order.
     *
     * When the active route protects credentials, no cleartext route leads. Among protected
     * routes, the advertised priority determines the order.
     */
    val orderedEndpoints: List<CompanionEndpoint>
        get() {
            val candidates = if (endpoints.isNullOrEmpty()) {
                orderedHosts.mapIndexedNotNull { index, candidate ->
                    CompanionEndpoint.direct(candidate, port, priority = index)
                }
            } else {
                val advertised = buildList {
                    addAll(endpoints)
                    activeEndpoint?.takeIf { active -> endpoints.none { it.url == active.url } }?.let(::add)
                }.withIndex()
                    .sortedWith(compareBy<IndexedValue<CompanionEndpoint>> { it.value.priority }.thenBy { it.index })
                    .map { it.value }
                if (activeEndpoint?.protectsCredentials == true) {
                    // A stable partition: both classes keep the advertised order they just got,
                    // so this can only move cleartext down — never reorder protected routes.
                    val (protectedRoutes, cleartextRoutes) = advertised.partition { it.protectsCredentials }
                    protectedRoutes + cleartextRoutes
                } else {
                    advertised
                }
            }
            return endpointsAllowedByRoutePolicy(candidates).distinctBy { it.url }.take(MAX_ENDPOINTS)
        }

    val automaticEndpoints: List<CompanionEndpoint>
        get() = CompanionEndpoint.automaticCandidates(orderedEndpoints)

    /**
     * Apply an authenticated endpoint snapshot, which is a replacement rather than a hint.
     *
     * The caller owns the client carrying the live stream; this value only decides what a future
     * launch, or a future route change, may dial. The advertised version of the active route is kept when it is
     * still advertised. If it disappeared, a protected route is a safe upgrade; with no protected
     * replacement the exact previous route stays first, rather than silently authorizing some
     * other cleartext address that happens to be advertised now.
     */
    fun reconciling(metadata: CompanionConnectionMetadata): Connection {
        val previousActive = activeEndpoint?.takeIf(::allowsEndpoint)
        val refreshedEndpoints = endpointsAllowedByRoutePolicy(metadata.endpoints)
        val refreshedActive = previousActive?.let { active ->
            refreshedEndpoints.firstOrNull { it.url == active.url }
        }
        val protectedReplacement = refreshedEndpoints.firstOrNull { it.protectsCredentials }
        val retained = previousActive?.let { CompanionEndpoint.create(it.url, it.kind, priority = 0) }
        val active = refreshedActive ?: protectedReplacement ?: retained ?: refreshedEndpoints.firstOrNull()
        val routes = if (refreshedActive == null && protectedReplacement == null && retained != null) {
            listOf(retained) + refreshedEndpoints.filterNot { it.url == retained.url }.take(MAX_ENDPOINTS - 1)
        } else {
            refreshedEndpoints
        }
        return copy(
            name = displayName(metadata.serverName) ?: name,
            host = active?.host ?: host,
            port = active?.port ?: port,
            hosts = metadata.hosts?.let(::advertisedHostsAllowedByRoutePolicy) ?: hosts,
            activeEndpoint = active,
            endpoints = routes,
        )
    }

    /** Legacy host failover must not turn a protected route into implicit local cleartext. */
    fun dialing(candidate: String): Connection {
        val endpoint = CompanionEndpoint.direct(candidate, port, priority = 10_000) ?: return this
        if (activeEndpoint?.protectsCredentials == true && !endpoint.protectsCredentials) return this
        return dialing(endpoint)
    }

    fun dialing(candidate: CompanionEndpoint): Connection {
        if (!allowsEndpoint(candidate)) return this
        return copy(
            host = candidate.host,
            port = candidate.port,
            activeEndpoint = candidate,
        )
    }

    fun promoting(winner: String): Connection {
        val normalized = urlHost(winner)
        val endpoint = CompanionEndpoint.direct(normalized, port, priority = 10_000) ?: return this
        if (!allowsEndpoint(endpoint)) return this
        if (activeEndpoint?.protectsCredentials == true && !endpoint.protectsCredentials) return this
        val rest = orderedHosts.filterNot { it == normalized }
        return copy(hosts = listOf(normalized) + rest).promoting(endpoint)
    }

    fun promoting(winner: CompanionEndpoint): Connection {
        if (!allowsEndpoint(winner)) return this
        val typed = endpoints?.let { existing ->
            if (existing.any { it.url == winner.url }) existing else existing + winner
        }
        val promotedHosts = if (winner.kind == CompanionEndpointKind.HOSTED) {
            hosts
        } else {
            listOf(winner.host) + orderedHosts.filterNot { it == winner.host }
        }
        return copy(
            host = winner.host,
            port = winner.port,
            hosts = promotedHosts,
            activeEndpoint = winner,
            endpoints = typed,
        )
    }

    private fun advertisedHostsAllowedByRoutePolicy(candidates: List<String>): List<String> =
        advertisedHosts(candidates).filter { candidate ->
            CompanionEndpoint.direct(candidate, port, priority = 0)?.let(::allowsEndpoint) == true
        }

    companion object {
        /** Trim a server-supplied display name to something printable; null when nothing remains. */
        fun displayName(raw: String): String? = raw.trim()
            .filter { character ->
                character != '\n' && character != '\r' &&
                    (character.code > 127 || (character.code >= 32 && character.code != 127))
            }
            .take(80)
            .takeIf { it.isNotEmpty() }

        /** Normalize, deduplicate and cap an advertised legacy host list. */
        fun advertisedHosts(advertised: List<String>): List<String> {
            val seen = mutableSetOf<String>()
            return advertised.mapNotNull { raw ->
                val candidate = raw.trim()
                if (candidate.isEmpty() ||
                    candidate.toByteArray(StandardCharsets.UTF_8).size > 253 ||
                    candidate.any { it.isWhitespace() || it in "/?#" }
                ) {
                    null
                } else {
                    urlHost(candidate).takeIf(seen::add)
                }
            }.take(MAX_ENDPOINTS)
        }

        fun urlHost(host: String): String {
            val bare = if (host.startsWith("[") && host.endsWith("]")) {
                host.substring(1, host.length - 1)
            } else {
                host
            }
            return if (':' in bare) "[$bare]" else bare.substringBefore('%')
        }

        fun parse(text: String, defaultPort: Int = 8810): Connection? {
            var trimmed = text.trim()
            val lowercased = trimmed.lowercase()
            if (lowercased.startsWith("http://") || lowercased.startsWith("https://")) {
                val parsed = runCatching { URI(trimmed) }.getOrNull() ?: return null
                val kind = if (lowercased.startsWith("https://")) {
                    CompanionEndpointKind.HOSTED
                } else {
                    CompanionEndpoint.inferredDirectKind(parsed.host.orEmpty())
                }
                val endpoint = CompanionEndpoint.create(trimmed, kind, priority = 0) ?: return null
                return Connection(
                    name = endpoint.host,
                    host = endpoint.host,
                    port = endpoint.port,
                    activeEndpoint = endpoint,
                    endpoints = listOf(endpoint),
                )
            }
            trimmed = trimmed.trimEnd('/')
            if (trimmed.isEmpty()) return null

            var parsedHost = trimmed
            var parsedPort = defaultPort
            if (trimmed.startsWith("[")) {
                val close = trimmed.indexOf(']')
                if (close < 0) return null
                parsedHost = trimmed.substring(1, close)
                val rest = trimmed.substring(close + 1)
                if (rest.isNotEmpty()) {
                    if (!rest.startsWith(":")) return null
                    parsedPort = rest.drop(1).toIntOrNull() ?: return null
                }
            } else if (trimmed.count { it == ':' } == 1) {
                val colon = trimmed.lastIndexOf(':')
                parsedHost = trimmed.substring(0, colon)
                parsedPort = trimmed.substring(colon + 1).toIntOrNull() ?: return null
            }

            if (parsedHost.isEmpty() || parsedHost.any { it.isWhitespace() || it in "/?#[]" }) return null
            if (parsedPort !in 1..65535) return null
            return Connection(name = parsedHost, host = urlHost(parsedHost), port = parsedPort)
        }

        private const val MAX_ENDPOINTS = 8
    }
}

data class PairingInvite(val connection: Connection, val credential: String) {
    companion object {
        private const val MAX_ENDPOINTS = 8

        fun parse(url: URI): PairingInvite? {
            if (url.scheme.equals("https", true) || url.scheme.equals("http", true)) {
                return parseServerLink(url)
            }
            if (!url.scheme.equals("openmausbot", ignoreCase = true) ||
                !url.host.equals("pair", ignoreCase = true)
            ) {
                return null
            }

            val values = linkedMapOf<String, String>()
            val query = url.rawQuery.orEmpty()
            if (query.isNotEmpty()) {
                for (item in query.split('&')) {
                    val equals = item.indexOf('=')
                    if (equals < 0) return null
                    val name = decodeQuery(item.substring(0, equals)) ?: return null
                    val value = decodeQuery(item.substring(equals + 1)) ?: return null
                    if (values.put(name, value) != null) return null
                }
            }

            val address = values["address"] ?: return null
            val credential = credential(values) ?: return null
            var connection = Connection.parse(address) ?: return null

            values["name"]?.trim()?.takeIf { it.isNotEmpty() }?.let { candidate ->
                val clean = candidate.filter { character ->
                    character != '\n' && character != '\r' &&
                        (character.code > 127 || (character.code >= 32 && character.code != 127))
                }
                if (clean.isNotEmpty()) connection = connection.copy(name = clean.take(80))
            }

            values["hosts"]?.let { list ->
                val candidates = list.split(',')
                    .map { it.trim(' ', '\t') }
                    .filter { candidate ->
                        candidate.isNotEmpty() &&
                            candidate.toByteArray(StandardCharsets.UTF_8).size <= 253 &&
                            candidate.none { it.isWhitespace() || it in "/?#" }
                    }
                    .take(8)
                if (candidates.isNotEmpty()) connection = connection.copy(hosts = candidates)
            }

            values["endpoints"]?.let { encoded ->
                val endpoints = decodeEndpoints(encoded) ?: return null
                connection = connection.copy(endpoints = endpoints).dialing(endpoints.first())
            }

            return PairingInvite(connection.establishingRoutePolicyFromInvite(), credential)
        }

        fun parse(url: String): PairingInvite? = runCatching { URI(url) }.getOrNull()?.let(::parse)

        /** The server's twelve-symbol code is distinct from companion codes and QR tokens. */
        fun normalizedServerCode(raw: String): String? = raw.uppercase(java.util.Locale.ROOT)
            .filter { it in 'A'..'Z' || it in '0'..'9' }
            .takeIf { it.length == 12 && it.all { symbol -> symbol in "23456789ABCDEFGHJKLMNPQRSTUVWXYZ" } }

        fun isPairingCode(raw: String): Boolean =
            (raw.length == 6 && raw.all { it in '0'..'9' }) || normalizedServerCode(raw) != null

        private fun parseServerLink(url: URI): PairingInvite? {
            if (url.host.isNullOrEmpty() || url.rawUserInfo != null || url.rawPath != "/pair" ||
                url.rawQuery != null
            ) return null
            val fragment = url.rawFragment ?: return null
            val values = linkedMapOf<String, String>()
            for (item in fragment.split('&')) {
                val equals = item.indexOf('=')
                if (equals < 1) return null
                val name = decodeQuery(item.substring(0, equals)) ?: return null
                val value = decodeQuery(item.substring(equals + 1)) ?: return null
                if (values.put(name, value) != null) return null
            }
            val code = normalizedServerCode(values["code"] ?: return null) ?: return null
            val connection = Connection.parse("${url.scheme}://${url.rawAuthority}") ?: return null
            if (!connection.serverTransportAllowed) return null
            return PairingInvite(connection.establishingRoutePolicyFromInvite(), code)
        }

        private fun credential(values: Map<String, String>): String? {
            values["token"]?.let { token ->
                val suffix = token.removePrefix("omb_pair_")
                if (!token.startsWith("omb_pair_") || token.toByteArray().size != 52 || suffix.length != 43) {
                    return null
                }
                if (suffix.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) return token
                return null
            }
            return values["code"]?.takeIf { code -> code.length == 6 && code.all { it in '0'..'9' } }
        }

        private fun decodeEndpoints(encoded: String): List<CompanionEndpoint>? {
            if (encoded.isEmpty() || encoded.toByteArray(StandardCharsets.UTF_8).size > 8_192) return null
            if (encoded.any { character ->
                    character.code !in '0'.code..'9'.code &&
                        character.code !in 'A'.code..'Z'.code &&
                        character.code !in 'a'.code..'z'.code &&
                        character != '-' && character != '_'
                }
            ) {
                return null
            }
            val decoded = runCatching { Base64.getUrlDecoder().decode(encoded) }.getOrNull() ?: return null
            val endpoints = runCatching {
                CompanionJson.decodeFromString<List<CompanionEndpoint>>(decoded.toString(StandardCharsets.UTF_8))
            }.getOrNull() ?: return null
            if (endpoints.isEmpty() || endpoints.size > MAX_ENDPOINTS) return null

            return endpoints.withIndex()
                .sortedWith(compareBy<IndexedValue<CompanionEndpoint>> { it.value.priority }.thenBy { it.index })
                .map { it.value }
                .distinctBy { it.url }
                .takeIf { it.isNotEmpty() }
        }

        /** Percent-decode a URI query component without form-url-decoding '+'. */
        private fun decodeQuery(value: String): String? = runCatching {
            val bytes = ByteArrayOutputStream(value.length)
            var index = 0
            while (index < value.length) {
                if (value[index] == '%') {
                    if (index + 2 >= value.length) return null
                    val high = value[index + 1].digitToIntOrNull(16) ?: return null
                    val low = value[index + 2].digitToIntOrNull(16) ?: return null
                    bytes.write((high shl 4) or low)
                    index += 3
                } else {
                    val codePoint = value.codePointAt(index)
                    bytes.write(String(Character.toChars(codePoint)).toByteArray(StandardCharsets.UTF_8))
                    index += Character.charCount(codePoint)
                }
            }
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray()))
                .toString()
        }.getOrNull()
    }
}

sealed class APIError(message: String, cause: Throwable? = null) : IOException(message, cause) {
    class Status(val code: Int, val serverMessage: String? = null) :
        APIError(serverMessage ?: defaultMessage(code))

    class Transport(val detail: String, cause: Throwable? = null) : APIError(detail, cause)

    data object BadUrl : APIError("That address doesn't look right.")

    val isUnauthorized: Boolean get() = this is Status && code == 401

    companion object {
        private fun defaultMessage(code: Int): String = when (code) {
            401 -> "This phone is not paired with that computer."
            403 -> "That can only be done on the computer itself."
            404 -> "That is no longer there."
            409 -> "The bot is busy — stop it first."
            else -> "The computer answered with an error ($code)."
        }
    }
}
