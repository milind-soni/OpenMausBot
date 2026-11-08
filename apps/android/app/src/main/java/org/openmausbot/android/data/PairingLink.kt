package org.openmausbot.android.data

import android.net.Uri
import org.openmausbot.android.e2e.E2EDescriptor
import java.net.URI
import java.net.URLDecoder

/** The `openmausbot://pair?...` invitation built by the desktop. Fields:
 *  address (host[:port] or origin), port, token (omb_pair_…), code (6 digits),
 *  name, hosts (comma-joined), endpoints (encoded), secretKey, e2e. */
data class PairingInvite(
    val baseUrl: String,
    val token: String?,
    val code: String?,
    val serverName: String,
    val endpoints: List<String>,
    val secretKey: String?,
    val e2e: E2EDescriptor? = null,
) {
    companion object {
        private val TOKEN = Regex("^omb_pair_[A-Za-z0-9_-]{43}$")

        /** Accepts a full `openmausbot://pair?...` link, a raw query string, or
         *  an https/http base URL that the user pasted. */
        fun parse(raw: String): PairingInvite? {
            val text = raw.trim()
            if (text.isEmpty()) return null
            val query: Map<String, String> = when {
                text.startsWith("openmausbot://", ignoreCase = true) ->
                    parseQuery(text.substringAfter('?', ""))
                text.contains("?") && (text.startsWith("http://") || text.startsWith("https://")) ->
                    parseQuery(text.substringAfter('?', ""))
                text.startsWith("http://") || text.startsWith("https://") -> emptyMap()
                else -> parseQuery(text)
            }
            val address = query["address"]?.takeIf { it.isNotBlank() }
            val pastedOrigin = text.takeIf { it.startsWith("http://") || it.startsWith("https://") }
                ?.substringBefore('?')?.trimEnd('/')
            val base = when {
                pastedOrigin != null -> clampOrigin(pastedOrigin)
                address != null -> clampOrigin(
                    if (address.startsWith("http")) address
                    else "http://" + address + (query["port"]?.let { p -> ":" + p } ?: "")
                )
                else -> null
            } ?: return null
            val token = query["token"]?.takeIf { TOKEN.matches(it) }
            val code = query["code"]?.takeIf { Regex("^\\d{6}$").matches(it) }
            val endpoints = buildList {
                query["hosts"]?.split(',')?.forEach { host ->
                    if (host.isNotBlank()) add("http://" + host.trim())
                }
                query["endpoints"]?.let { addAll(decodeEndpoints(it)) }
            }.mapNotNull { clampOrigin(it) }.distinct()
            val e2eText = query["e2e"]?.takeIf { it.isNotBlank() }
            val e2e = if (e2eText != null) E2EDescriptor.parse(e2eText) ?: return null else null
            return PairingInvite(
                baseUrl = base,
                token = token,
                code = code,
                serverName = query["name"]?.takeIf { it.isNotBlank() } ?: hostOf(base),
                endpoints = endpoints,
                secretKey = query["secretKey"],
                e2e = e2e,
            )
        }

        fun hostOf(url: String): String = runCatching { URI(url).host ?: url }.getOrDefault(url)

        fun clampOrigin(value: String): String? {
            val trimmed = value.trim().trimEnd('/')
            if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
            return runCatching {
                val uri = URI(trimmed)
                if (uri.host.isNullOrBlank()) return null
                val port = if (uri.port > 0) ":${uri.port}" else ""
                "${uri.scheme}://${uri.host}$port"
            }.getOrNull()
        }

        private fun parseQuery(query: String): Map<String, String> =
            query.split('&').mapNotNull { part ->
                if (part.isBlank()) return@mapNotNull null
                val key = part.substringBefore('=')
                val value = part.substringAfter('=', "")
                URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
            }.toMap()

        /** The desktop sends either comma-joined origins or a compact base64url
         *  JSON array. Both are handled so an unfamiliar form degrades to the
         *  primary address instead of failing the pairing. */
        private fun decodeEndpoints(encoded: String): List<String> {
            if (encoded.isBlank()) return emptyList()
            if (encoded.contains("://")) return encoded.split(',').map { it.trim() }
            val json = runCatching {
                val padded = encoded.replace('-', '+').replace('_', '/')
                String(android.util.Base64.decode(padded, android.util.Base64.DEFAULT))
            }.getOrNull() ?: return emptyList()
            return runCatching {
                val array = org.json.JSONArray(json)
                (0 until array.length()).mapNotNull { index ->
                    val item = array.opt(index)
                    when (item) {
                        is String -> item
                        is org.json.JSONObject -> item.optString("url").takeIf { it.isNotBlank() }
                        else -> null
                    }
                }
            }.getOrDefault(emptyList())
        }

        /** The app's own deep link: the same shape as the QR, so one parser
         *  serves camera, clipboard and `adb shell am start -d …`. */
        fun fromUri(uri: Uri): PairingInvite? = parse(uri.toString())
    }
}
