package com.openmausbot.companion.core

import java.net.URI
import java.net.URLDecoder
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

/**
 * One attachment waiting in the composer — the port of
 * `ios/Sources/CompanionCore/MessageAttachments.swift`.
 *
 * The bytes are app-owned: picker URIs are copied before this value is created,
 * so a later send never depends on a content provider still granting access.
 */
class PendingMessageAttachment(
    val id: String = UUID.randomUUID().toString(),
    val data: ByteArray,
    val name: String,
    val mime: String,
    val kind: Kind,
) {
    enum class Kind { IMAGE, FILE }

    val bytes: Int get() = data.size
}

class AttachmentPolicyException(message: String) : Exception(message)

/**
 * The same limits apply to the in-app composer and the Share target. Keeping
 * the policy in `:core` prevents either entry point from accepting an
 * attachment that the authenticated upload route will reject.
 */
object AttachmentPolicy {
    const val MAXIMUM_ITEMS: Int = 4
    const val MAXIMUM_TOTAL_BYTES: Int = 50 * 1_024 * 1_024
    const val MAXIMUM_IMAGE_BYTES: Int = 10 * 1_024 * 1_024
    const val MAXIMUM_FILE_BYTES: Int = 25 * 1_024 * 1_024

    val IMAGE_MIME_TYPES: Set<String> = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

    val DOCUMENT_MIME_TYPES: Set<String> = setOf(
        "text/plain", "text/markdown", "text/csv", "text/tab-separated-values",
        "application/json", "application/pdf", "application/rtf", "text/rtf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.presentation",
    )

    const val TOO_MANY_ITEMS: String = "Attach up to 4 items at a time."
    const val TOTAL_TOO_LARGE: String = "Those attachments are larger than 50 MB together."
    const val INVALID_NAME: String = "That file doesn't have a valid filename."

    fun unsupportedType(name: String): String =
        "$name isn't a supported file. Try PDF, text, Word, Excel, or PowerPoint."

    fun itemTooLarge(name: String, limitMB: Int): String = "$name is larger than $limitMB MB."

    /** `type/subtype` only, lowercased — a `; charset=` parameter is not part of the type. */
    fun normalizedMime(value: String): String =
        value.substringBefore(';').trim().lowercase()

    fun kindForMime(value: String): PendingMessageAttachment.Kind? {
        val mime = normalizedMime(value)
        if (mime in IMAGE_MIME_TYPES) return PendingMessageAttachment.Kind.IMAGE
        if (mime in DOCUMENT_MIME_TYPES) return PendingMessageAttachment.Kind.FILE
        return null
    }

    /** Throws [AttachmentPolicyException] with the sentence the composer shows. */
    fun validate(attachments: List<PendingMessageAttachment>) {
        if (attachments.size > MAXIMUM_ITEMS) throw AttachmentPolicyException(TOO_MANY_ITEMS)
        if (attachments.sumOf { it.data.size.toLong() } > MAXIMUM_TOTAL_BYTES) {
            throw AttachmentPolicyException(TOTAL_TOO_LARGE)
        }
        for (attachment in attachments) {
            val name = attachment.name.trim()
            if (!validDisplayName(name)) throw AttachmentPolicyException(INVALID_NAME)
            val mime = normalizedMime(attachment.mime)
            when (attachment.kind) {
                PendingMessageAttachment.Kind.IMAGE -> {
                    if (mime !in IMAGE_MIME_TYPES) throw AttachmentPolicyException(unsupportedType(name))
                    if (attachment.data.size > MAXIMUM_IMAGE_BYTES) {
                        throw AttachmentPolicyException(itemTooLarge(name, 10))
                    }
                }
                PendingMessageAttachment.Kind.FILE -> {
                    if (mime !in DOCUMENT_MIME_TYPES) throw AttachmentPolicyException(unsupportedType(name))
                    if (attachment.data.size > MAXIMUM_FILE_BYTES) {
                        throw AttachmentPolicyException(itemTooLarge(name, 25))
                    }
                }
            }
        }
    }

    /** A syntactically plausible media type, so a server header cannot smuggle anything odd. */
    fun validMime(value: String): Boolean {
        val mime = normalizedMime(value)
        if (mime.isEmpty() || mime.toByteArray().size > 127 || '/' !in mime) return false
        return mime.all { it in '0'..'9' || it in 'a'..'z' || it in 'A'..'Z' || it in "!#$&+-./^_" }
    }

    private fun validDisplayName(value: String): Boolean =
        value.isNotEmpty() && value.toByteArray().size <= 255 &&
            '/' !in value && '\\' !in value && value.none(Char::isISOControl)
}

/**
 * What tapping a Markdown link in a message is allowed to do. Web links go to
 * the system. Absolute desktop paths go back through the authenticated
 * companion file route. Relative paths are resolved by that route against the
 * originating conversation's workspace. Custom schemes do nothing.
 */
sealed class LocalMessageLink {
    data class Web(val url: String) : LocalMessageLink()
    data class DesktopFile(val path: String) : LocalMessageLink()

    companion object {
        fun resolve(rawValue: String): LocalMessageLink? {
            val value = rawValue.trim()
            if (value.isEmpty() || value.toByteArray().size > 8_192 || value.any(Char::isISOControl)) return null
            if (isWindowsAbsolutePath(value) || isBackslashUncPath(value)) return DesktopFile(value)
            // //host/path is a protocol-relative web link in Markdown. A UNC
            // share must use backslashes or the explicit file://host spelling.
            if (value.startsWith("//")) {
                val uri = runCatching { URI("https:$value") }.getOrNull() ?: return null
                if (uri.host.isNullOrEmpty()) return null
                return Web(uri.toString())
            }
            if (value.startsWith("/")) return DesktopFile(value)
            if (SCHEME.containsMatchIn(value)) {
                val uri = runCatching { URI(value) }.getOrNull() ?: return null
                val scheme = uri.scheme?.lowercase() ?: return null
                if (scheme == "http" || scheme == "https") {
                    if (uri.host.isNullOrEmpty()) return null
                    return Web(value)
                }
                if (scheme == "file") {
                    if (uri.rawQuery != null || uri.rawFragment != null) return null
                    var path = uri.rawPath?.let(::decodeOrNull) ?: return null
                    if (path.startsWith("/") && isWindowsAbsolutePath(path.drop(1))) path = path.drop(1)
                    val host = uri.host
                    if (!host.isNullOrEmpty() && host.lowercase() != "localhost") {
                        path = "\\\\$host${path.replace('/', '\\')}"
                    }
                    if (!(path.startsWith("/") || isWindowsAbsolutePath(path) || isBackslashUncPath(path))) {
                        return null
                    }
                    return DesktopFile(path)
                }
                return null
            }

            val delimiter = listOf(value.indexOf('?'), value.indexOf('#'))
                .filter { it >= 0 }
                .minOrNull() ?: value.length
            if (delimiter == 0) return null
            val path = decodeOrNull(value.substring(0, delimiter)) ?: return null
            return path.takeIf(String::isNotEmpty)?.let(::DesktopFile)
        }

        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

        private fun decodeOrNull(value: String): String? =
            runCatching { URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") }.getOrNull()

        private fun isWindowsAbsolutePath(value: String): Boolean =
            value.length >= 3 && value[0].isLetter() && value[0].code < 128 && value[1] == ':' &&
                (value[2] == '/' || value[2] == '\\')

        private fun isBackslashUncPath(value: String): Boolean = value.startsWith("\\\\")
    }
}

/** A display/storage filename bounded by UTF-8 bytes without splitting a surrogate pair. */
internal fun sanitisePortableFilename(
    source: String,
    fallback: String,
    maximumUTF8Bytes: Int = 180,
): String {
    val basename = source.split('/', '\\').lastOrNull { it.isNotEmpty() } ?: fallback
    val output = StringBuilder()
    var bytes = 0
    var index = 0
    while (index < basename.length) {
        val character = basename[index]
        val (rawCodePoint, consumed) = when {
            Character.isHighSurrogate(character) &&
                index + 1 < basename.length && Character.isLowSurrogate(basename[index + 1]) ->
                Character.toCodePoint(character, basename[index + 1]) to 2
            Character.isHighSurrogate(character) || Character.isLowSurrogate(character) -> ' '.code to 1
            else -> character.code to 1
        }
        val codePoint = if (
            Character.isISOControl(rawCodePoint) ||
            rawCodePoint in 0x202A..0x202E ||
            rawCodePoint in 0x2066..0x2069
        ) {
            ' '.code
        } else {
            rawCodePoint
        }
        val piece = String(Character.toChars(codePoint))
        val pieceBytes = piece.toByteArray(Charsets.UTF_8).size
        if (bytes + pieceBytes > maximumUTF8Bytes) break
        output.append(piece)
        bytes += pieceBytes
        index += consumed
    }
    val cleaned = output.toString().trim()
    return cleaned.takeUnless { it.isEmpty() || it == "." || it == ".." } ?: fallback
}

/** Bytes returned by the authenticated file route, with the sanitised name and type to show them under. */
class DownloadedFile(
    val data: ByteArray,
    val filename: String,
    val contentType: String,
)

/** One authenticated attachment identity; connection id prevents cross-computer reuse. */
internal data class AttachmentDownloadKey(
    val connectionId: String,
    val threadId: String,
    val messageId: String,
    val path: String,
)

/**
 * Small session-owned LRU for transcript attachments. It also owns each active
 * request so two rows asking for the same image await one network transfer.
 */
internal class AttachmentDownloadCache(
    private val scope: CoroutineScope,
    private val maximumEntries: Int = 12,
    private val maximumBytes: Long = 50L * 1_024L * 1_024L,
) {
    private class Pending(val token: Any, var retainResult: Boolean) {
        lateinit var deferred: Deferred<DownloadedFile>
        var waiters: Int = 0
    }
    private sealed interface Lookup {
        data class Cached(val file: DownloadedFile) : Lookup
        data class PendingRequest(val pending: Pending, val created: Boolean) : Lookup
    }

    private val lock = Any()
    private val entries = LinkedHashMap<AttachmentDownloadKey, DownloadedFile>()
    private val inFlight = mutableMapOf<AttachmentDownloadKey, Pending>()
    private var storedBytes = 0L

    suspend fun getOrLoad(
        key: AttachmentDownloadKey,
        loader: suspend () -> DownloadedFile,
    ): DownloadedFile = getOrLoad(key, retainResult = true, loader = loader)

    suspend fun getOrLoad(
        key: AttachmentDownloadKey,
        retainResult: Boolean,
        loader: suspend () -> DownloadedFile,
    ): DownloadedFile {
        val lookup = synchronized(lock) {
            if (retainResult) {
                entries.remove(key)?.let { cached ->
                    entries[key] = cached
                    return@synchronized Lookup.Cached(cached)
                }
            }
            inFlight[key]?.let {
                it.waiters += 1
                it.retainResult = it.retainResult || retainResult
                return@synchronized Lookup.PendingRequest(it, created = false)
            }

            val token = Any()
            val pending = Pending(token, retainResult).apply { waiters = 1 }
            pending.deferred = scope.async(start = CoroutineStart.LAZY) {
                try {
                    val file = loader()
                    synchronized(lock) {
                        if (inFlight[key]?.token === token) {
                            inFlight.remove(key)
                            if (pending.retainResult) storeLocked(key, file)
                        }
                    }
                    file
                } finally {
                    synchronized(lock) {
                        if (inFlight[key]?.token === token) inFlight.remove(key)
                    }
                }
            }
            inFlight[key] = pending
            Lookup.PendingRequest(pending, created = true)
        }

        return when (lookup) {
            is Lookup.Cached -> lookup.file
            is Lookup.PendingRequest -> {
                if (lookup.created) lookup.pending.deferred.start()
                try {
                    lookup.pending.deferred.await()
                } finally {
                    releaseWaiter(key, lookup.pending)
                }
            }
        }
    }

    /** A computer switch or sign-out invalidates bytes and active transfers together. */
    fun clear() {
        val jobs = synchronized(lock) {
            entries.clear()
            storedBytes = 0
            inFlight.values.map { it.deferred }.also { inFlight.clear() }
        }
        jobs.forEach { it.cancel() }
    }

    private fun storeLocked(key: AttachmentDownloadKey, file: DownloadedFile) {
        val bytes = file.data.size.toLong()
        if (maximumEntries <= 0 || bytes > maximumBytes) return
        entries.remove(key)?.let { storedBytes -= it.data.size.toLong() }
        while (entries.isNotEmpty() && (entries.size >= maximumEntries || storedBytes + bytes > maximumBytes)) {
            val eldest = entries.entries.first()
            entries.remove(eldest.key)
            storedBytes -= eldest.value.data.size.toLong()
        }
        if (storedBytes + bytes <= maximumBytes) {
            entries[key] = file
            storedBytes += bytes
        }
    }

    private fun releaseWaiter(key: AttachmentDownloadKey, pending: Pending) {
        val orphan = synchronized(lock) {
            val current = inFlight[key]
            if (current?.token !== pending.token) return@synchronized null
            current.waiters = (current.waiters - 1).coerceAtLeast(0)
            if (current.waiters == 0) {
                inFlight.remove(key)
                current.deferred
            } else {
                null
            }
        }
        orphan?.cancel()
    }
}
