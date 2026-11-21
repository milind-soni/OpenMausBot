package org.openmausbot.android.data

import android.net.Uri
import java.net.URI
import java.net.URLDecoder
import java.util.Base64

/** A pairing window handed from the desktop to the app as a QR/deep link.
 *  It contains only the address and a short-lived, single-use credential.
 *  New desktop builds put a high-entropy token in the QR; older builds carry
 *  the same six-digit code shown on screen. The long-lived device token is
 *  created later by pairing and never appears in the link. */
data class PairingInvite(
    val baseUrl: String,
    val token: String?,
    val code: String?,
    val serverName: String,
    val endpoints: List<CompanionEndpoint> = emptyList(),
    val hosts: List<String> = emptyList(),
    val secretKey: String? = null,
) {
    val credential: String? get() = token ?: code

    /** The route-policy seed for the one-time pairing walk. It has no device
     *  token; the redeemed token is written only after a route answers. */
    fun seedConnection(): PairedComputer {
        val primary = endpoints.firstOrNull()
            ?: CompanionEndpoint.create(baseUrl, CompanionEndpoint.kindForOrigin(baseUrl), 0)
        val routes = endpoints.ifEmpty { listOfNotNull(primary) }
        return PairedComputer(
            id = "invite",
            serverName = serverName,
            baseUrl = primary?.url ?: baseUrl,
            token = "",
            endpoints = routes.map { it.url },
            hosts = hosts,
            endpointRoutes = routes,
            activeEndpoint = primary,
            secretPublicKey = secretKey,
        )
    }

    companion object {
        private val TOKEN = Regex("^omb_pair_[A-Za-z0-9_-]{43}$")
        private val CODE = Regex("^\\d{6}$")
        private val SECRET_KEY = Regex("^[A-Za-z0-9_-]{87}$")
        private val HOST = Regex("^[^\\s/?#]+$")

        /** Accepts a full `openmausbot://pair?...` link, a raw query string, or
         *  an https/http origin the user pasted. A present-but-invalid typed
         *  endpoint or secret key rejects the whole link, matching the iOS
         *  client: silently downgrading a hosted QR is worse than saying no. */
        fun parse(raw: String): PairingInvite? {
            val text = raw.trim()
            if (text.isEmpty()) return null
            val uri = runCatching { URI(text) }.getOrNull()
            val isHttp = uri != null &&
                (uri.scheme.equals("http", true) || uri.scheme.equals("https", true))
            if (isHttp && uri?.rawQuery == null) {
                // A plain origin, as typed into the "computer address" field.
                if (uri?.rawPath.isNullOrEmpty() || uri?.rawPath == "/") {
                    val origin = endpointFromOrigin(text) ?: return null
                    return buildInvite(origin, emptyList(), emptyMap())
                }
            }
            val query = when {
                text.startsWith("openmausbot://", ignoreCase = true) ->
                    parseQuery(text.substringAfter('?', ""))
                text.contains("?") -> parseQuery(text.substringAfter('?', ""))
                else -> parseQuery(text)
            }
            val address = query["address"]?.takeIf { it.isNotBlank() }
            val pastedOrigin = if (text.startsWith("http://") || text.startsWith("https://")) {
                text.substringBefore('?').trimEnd('/')
            } else {
                null
            }
            val addressEndpoint = when {
                address != null -> endpointFromAddress(address, query["port"]?.toIntOrNull()) ?: return null
                pastedOrigin != null -> endpointFromOrigin(pastedOrigin) ?: return null
                else -> return null
            }
            if (query.containsKey("endpoints")) {
                val encoded = query["endpoints"] ?: return null
                val typed = CompanionEndpoint.decodeEndpoints(encoded) ?: return null
                return buildInvite(typed.first(), typed, query)
            }
            return buildInvite(addressEndpoint, emptyList(), query)
        }

        private fun buildInvite(
            primary: CompanionEndpoint,
            typedEndpoints: List<CompanionEndpoint>,
            query: Map<String, String>,
        ): PairingInvite? {
            val token = query["token"]?.let { value ->
                if (!TOKEN.matches(value)) return null
                value
            }
            val code = query["code"]?.let { value ->
                if (!CODE.matches(value)) return null
                value
            }
            if (token == null && code == null) return null
            val routes = typedEndpoints.ifEmpty { listOf(primary) }
            val hosts = query["hosts"]?.split(',')?.mapNotNull { rawHost ->
                val host = rawHost.trim()
                if (host.isEmpty() || host.length > 253 || !HOST.matches(host)) null else host
            }?.take(8) ?: emptyList()
            val secretKey = query["secretKey"]?.let { value ->
                normalizedSecretKey(value) ?: return null
            }
            val name = sanitizeName(query["name"]) ?: primary.host
            return PairingInvite(
                baseUrl = routes.first().url,
                token = token,
                code = code,
                serverName = name,
                endpoints = routes,
                hosts = hosts,
                secretKey = secretKey,
            )
        }

        private fun endpointFromOrigin(raw: String): CompanionEndpoint? {
            val trimmed = raw.trim().trimEnd('/')
            val kind = CompanionEndpoint.kindForOrigin(trimmed)
            return CompanionEndpoint.create(trimmed, kind, 0)
        }

        private fun endpointFromAddress(address: String, queryPort: Int?): CompanionEndpoint? {
            val value = address.trim()
            if (value.startsWith("http://") || value.startsWith("https://")) {
                return endpointFromOrigin(value)
            }
            var host = value
            var port = queryPort
            if (value.startsWith("[")) {
                val close = value.indexOf(']')
                if (close <= 1) return null
                host = value.substring(1, close)
                val rest = value.substring(close + 1)
                if (rest.isNotEmpty()) {
                    if (!rest.startsWith(":")) return null
                    port = rest.drop(1).toIntOrNull() ?: return null
                }
            } else if (value.count { it == ':' } == 1) {
                host = value.substringBeforeLast(':')
                port = value.substringAfterLast(':').toIntOrNull() ?: return null
            }
            return CompanionEndpoint.direct(host, port ?: 8810, null, 0)
        }

        private fun sanitizeName(raw: String?): String? {
            val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val cleaned = value.filter { !it.isISOControl() }.take(80)
            return cleaned.ifEmpty { null }
        }

        /** Validate and return the canonical unpadded base64url P-256 point
         *  used in a QR. The private half never leaves the computer. */
        fun normalizedSecretKey(encoded: String): String? {
            if (!SECRET_KEY.matches(encoded)) return null
            val bytes = runCatching { Base64.getUrlDecoder().decode(encoded) }.getOrNull() ?: return null
            if (bytes.size != 65 || bytes[0] != 0x04.toByte()) return null
            val canonical = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            return canonical.takeIf { it == encoded }
        }

        fun hostOf(url: String): String =
            CompanionEndpoint.hostOf(url).ifEmpty { url }

        fun clampOrigin(value: String): String? = endpointFromOrigin(value)?.url

        private fun parseQuery(query: String): Map<String, String> =
            query.split('&').mapNotNull { part ->
                if (part.isBlank()) return@mapNotNull null
                val key = part.substringBefore('=')
                val value = part.substringAfter('=', "")
                URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
            }.toMap()

        /** The app's own deep link: the same shape as the QR, so one parser
         *  serves camera, clipboard and `adb shell am start -d …`. */
        fun fromUri(uri: Uri): PairingInvite? = parse(uri.toString())
    }
}
