package org.openmausbot.android.e2e

import java.util.Base64

/** Strict, unpadded base64url. Rejects non-canonical spellings, matching the
 *  desktop's `fromB64u`; a value that re-encodes differently is not accepted. */
object B64u {
    private val ALPHABET = Regex("^[A-Za-z0-9_-]*$")

    fun encode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(text: String): ByteArray? {
        if (!ALPHABET.matches(text) || text.length % 4 == 1) return null
        val bytes = try {
            Base64.getUrlDecoder().decode(text)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return if (encode(bytes) == text) bytes else null
    }
}
