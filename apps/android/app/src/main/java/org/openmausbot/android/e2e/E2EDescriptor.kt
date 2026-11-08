package org.openmausbot.android.e2e

import org.json.JSONArray
import org.json.JSONObject

/** `{v:1,k,h?,r?,routes?}` from the pairing link or the pair response.
 *  `k` is the pinned transport key; `h` and `r` only exist together. */
data class E2EDescriptor(
    val key: ByteArray,
    val hostId: ByteArray? = null,
    val relays: List<String> = emptyList(),
    val routes: String? = null,
) {
    val keyB64u: String get() = B64u.encode(key)
    val hostIdB64u: String? get() = hostId?.let(B64u::encode)
    val localOnly: Boolean get() = routes == "local"

    fun toJson(): JSONObject = JSONObject().apply {
        put("v", 1)
        put("k", keyB64u)
        hostId?.let {
            put("h", B64u.encode(it))
            put("r", JSONArray(relays))
        }
        routes?.let { put("routes", it) }
    }

    companion object {
        const val MAX_CHARS = 1024
        const val MAX_RELAYS = 4
        private val RELAY_HOST = Regex("^relay[1-9][0-9]?\\.openmausbot\\.com$")

        /** The QR's `e2e` parameter: unpadded base64url over the descriptor JSON. */
        fun parse(text: String): E2EDescriptor? {
            if (text.length > MAX_CHARS) return null
            val bytes = B64u.decode(text) ?: return null
            val json = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrNull() ?: return null
            return parse(json)
        }

        /** The already-decoded object in a JSON response. */
        fun parse(json: JSONObject?): E2EDescriptor? {
            json ?: return null
            if (json.optInt("v", 0) != 1) return null
            val keyText = json.optString("k").takeIf { it.isNotBlank() } ?: return null
            val key = B64u.decode(keyText) ?: return null
            if (key.size != Noise.PUBLIC_KEY_BYTES || !Crypto.isValidPublicKey(key)) return null

            val hasHost = json.has("h") && !json.isNull("h")
            val hasRelays = json.has("r") && !json.isNull("r")
            if (hasHost != hasRelays) return null
            if (!hasHost) {
                val routes = readRoutes(json) ?: return null
                return E2EDescriptor(key, routes = routes)
            }

            val hostId = B64u.decode(json.optString("h")) ?: return null
            if (hostId.size != Noise.CONN_BYTES) return null
            val array = json.optJSONArray("r") ?: return null
            if (array.length() !in 1..MAX_RELAYS) return null
            val relays = ArrayList<String>(array.length())
            for (index in 0 until array.length()) {
                val host = array.optString(index)
                if (!RELAY_HOST.matches(host)) return null
                relays.add(host)
            }
            val routes = readRoutes(json) ?: return null
            return E2EDescriptor(key, hostId, relays, routes)
        }

        fun from(value: Any?): E2EDescriptor? = when (value) {
            is String -> parse(value)
            is JSONObject -> parse(value)
            else -> null
        }

        private fun readRoutes(json: JSONObject): String? {
            if (!json.has("routes") || json.isNull("routes")) return null
            return when (val value = json.optString("routes")) {
                "any", "local" -> value
                else -> null
            }
        }
    }
}
