package com.openmausbot.companion.core

import java.net.InetAddress

/** Server credentials require HTTPS, a tailnet route, or an explicitly local HTTP authority. */
internal val Connection.serverTransportAllowed: Boolean
    get() {
        val origin = baseUrl ?: return false
        if (origin.scheme.equals("https", ignoreCase = true)) return true
        val host = origin.host.orEmpty().removeSurrounding("[", "]").lowercase().trimEnd('.')
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) return true
        // Only parse literals: never perform DNS to decide whether a public name is safe.
        val literal = host.substringBefore('%')
        if (':' !in literal && !literal.matches(Regex("[0-9]+(?:\\.[0-9]+){3}"))) return false
        val address = runCatching { InetAddress.getByName(literal) }.getOrNull() ?: return false
        return address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress ||
            (address.address.size == 16 && (address.address[0].toInt() and 0xfe) == 0xfc)
    }

internal fun Connection.requireServerTransport() {
    if (!serverTransportAllowed) {
        throw APIError.Transport("Use HTTPS or a Tailscale address for a remote server. HTTP is only supported for local addresses.")
    }
}
