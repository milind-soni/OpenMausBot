package com.astra.companion.core

import java.net.URI
import java.nio.charset.StandardCharsets
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

@Serializable
enum class CompanionEndpointKind {
    @SerialName("hosted")
    HOSTED,

    @SerialName("tailnet")
    TAILNET,

    @SerialName("lan")
    LAN,

    @SerialName("bonjour")
    BONJOUR,
}

/** Whether a route may carry a credential without another explicit local-network choice. */
enum class CompanionEndpointSecurityClass {
    PROTECTED,
    EXPLICIT_LOCAL,
}

/**
 * One validated, complete dialing authority advertised by the companion.
 *
 * Construction is intentionally fallible and the constructor is private: an endpoint cannot
 * exist without passing the scheme, authority and kind policy below. This keeps later pairing
 * and failover work from having to revalidate a value after it has already entered the domain.
 */
@ConsistentCopyVisibility
@Serializable(with = CompanionEndpointSerializer::class)
data class CompanionEndpoint private constructor(
    val url: String,
    val kind: CompanionEndpointKind,
    val priority: Int,
) {
    val baseUrl: URI
        get() = URI(url)

    val host: String
        get() {
            val parsed = baseUrl.host.orEmpty()
                // URI exposes an IPv6 zone in its encoded form. Connection's scoped-DNS path
                // needs the original '%' separator when it turns the host back into a socket.
                .replace("%25", "%", ignoreCase = true)
            return Connection.urlHost(parsed)
        }

    val port: Int
        get() = baseUrl.port.takeIf { it >= 0 } ?: if (isSecure) 443 else 80

    val isSecure: Boolean
        get() = baseUrl.scheme.equals("https", ignoreCase = true)

    val securityClass: CompanionEndpointSecurityClass
        get() = when (kind) {
            CompanionEndpointKind.HOSTED,
            CompanionEndpointKind.TAILNET,
            -> CompanionEndpointSecurityClass.PROTECTED

            CompanionEndpointKind.LAN,
            CompanionEndpointKind.BONJOUR,
            -> CompanionEndpointSecurityClass.EXPLICIT_LOCAL
        }

    val protectsCredentials: Boolean
        get() = securityClass == CompanionEndpointSecurityClass.PROTECTED

    /** Full HTTPS authority for hosted routes; familiar direct form for local routes. */
    val displayAddress: String
        get() = if (kind == CompanionEndpointKind.HOSTED || isSecure) {
            url
        } else if (port == DEFAULT_COMPANION_PORT) {
            host
        } else {
            "$host:$port"
        }

    companion object {
        const val MAX_URL_BYTES = 2_048
        const val MAX_PRIORITY = 1_000_000
        const val DEFAULT_COMPANION_PORT = 8810

        fun create(url: String, kind: CompanionEndpointKind, priority: Int): CompanionEndpoint? {
            if (priority !in 0..MAX_PRIORITY) return null
            val normalized = normalizedUrl(url, kind) ?: return null
            return CompanionEndpoint(normalized, kind, priority)
        }

        fun direct(
            host: String,
            port: Int,
            kind: CompanionEndpointKind? = null,
            priority: Int,
        ): CompanionEndpoint? {
            if (port !in 1..65_535) return null
            val normalizedHost = Connection.urlHost(host)
            if (normalizedHost.isEmpty()) return null
            val raw = runCatching {
                URI("http", null, normalizedHost, port, null, null, null).toASCIIString()
            }.getOrNull() ?: return null
            return create(raw, kind ?: inferredDirectKind(normalizedHost), priority)
        }

        fun inferredDirectKind(host: String): CompanionEndpointKind {
            val canonical = canonicalDnsHost(host)
            return when {
                validTailnetHost(canonical) -> CompanionEndpointKind.TAILNET
                canonical.endsWith(".local") -> CompanionEndpointKind.BONJOUR
                else -> CompanionEndpointKind.LAN
            }
        }

        /** Credential-safe candidates, in caller order, for the later pairing/failover passes. */
        fun automaticCandidates(candidates: List<CompanionEndpoint>): List<CompanionEndpoint> {
            val preferred = candidates.firstOrNull() ?: return emptyList()
            val seen = mutableSetOf<String>()
            return candidates.filter { candidate ->
                seen.add(candidate.url) && if (preferred.protectsCredentials) {
                    candidate.protectsCredentials
                } else {
                    candidate.url == preferred.url || candidate.protectsCredentials
                }
            }
        }

        private fun normalizedUrl(raw: String, kind: CompanionEndpointKind): String? {
            val trimmed = raw.trim()
            if (trimmed.toByteArray(StandardCharsets.UTF_8).size > MAX_URL_BYTES) return null

            val parsed = runCatching { URI(trimmed) }.getOrNull() ?: return null
            val scheme = parsed.scheme?.lowercase() ?: return null
            val host = parsed.host?.takeIf { it.isNotEmpty() } ?: return null
            if (!parsed.isAbsolute || parsed.rawAuthority == null) return null
            if (scheme != "http" && scheme != "https") return null
            if (parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) return null
            if (parsed.rawPath.isNotEmpty() && parsed.rawPath != "/") return null
            if (parsed.port != -1 && parsed.port !in 1..65_535) return null
            // java.net.URI treats an empty explicit port as if no port was supplied.
            if (parsed.rawAuthority.endsWith(':')) return null

            when (kind) {
                CompanionEndpointKind.HOSTED -> if (scheme != "https") return null
                CompanionEndpointKind.TAILNET -> {
                    if (scheme != "http" || !validTailnetHost(canonicalDnsHost(host))) return null
                }
                CompanionEndpointKind.LAN,
                CompanionEndpointKind.BONJOUR,
                -> if (scheme != "http") return null
            }

            return runCatching {
                URI(scheme, null, host.lowercase(), parsed.port, null, null, null).toASCIIString()
            }.getOrNull()
        }

        private fun canonicalDnsHost(host: String): String =
            host.lowercase().removeSurrounding("[", "]").trimEnd('.')

        private fun validTailnetHost(host: String): Boolean =
            host.length > ".ts.net".length && host.endsWith(".ts.net")
    }
}

object CompanionEndpointSerializer : KSerializer<CompanionEndpoint> {
    @Serializable
    private data class Wire(
        val url: String,
        val kind: CompanionEndpointKind,
        val priority: Int,
    )

    override val descriptor: SerialDescriptor = Wire.serializer().descriptor

    override fun deserialize(decoder: Decoder): CompanionEndpoint {
        val wire = Wire.serializer().deserialize(decoder)
        return CompanionEndpoint.create(wire.url, wire.kind, wire.priority)
            ?: throw SerializationException(
                "Companion endpoints must be absolute authorities; hosted routes require " +
                    "HTTPS and tailnet routes require an HTTP .ts.net name.",
            )
    }

    override fun serialize(encoder: Encoder, value: CompanionEndpoint) {
        Wire.serializer().serialize(encoder, Wire(value.url, value.kind, value.priority))
    }
}
