package com.astra.companion.ui

import com.astra.companion.core.ExportedTranscript

/** The two shapes a transcript can leave in — `GET /api/threads/:id/export?format=`. */
enum class ShareFormat(
    val wire: String,
    val label: String,
    val extension: String,
    val mime: String,
) {
    MARKDOWN("markdown", "Share as Markdown", "md", "text/markdown"),
    JSON("json", "Share as JSON", "json", "application/json"),
}

/**
 * Turning an exported transcript into something the Android share sheet accepts.
 *
 * The filename and content type come off the wire, so neither is trusted here.
 * A filename is used to name a file in the app's cache directory, which makes
 * `../` in it a path traversal; a content type goes into an Intent that other
 * apps read. Both are reduced to something known-safe, falling back to the
 * format's own answer.
 */
object SharePayload {
    private const val MAX_NAME = 96
    private val SAFE_NAME = Regex("[^A-Za-z0-9._-]")
    private val MIME = Regex("^[A-Za-z0-9!#\$&^_.+-]+/[A-Za-z0-9!#\$&^_.+-]+$")

    /**
     * A single path segment, always. Any directory part of the server's name is
     * dropped rather than honoured — this names a file the app is about to write.
     */
    fun fileName(export: ExportedTranscript, format: ShareFormat): String {
        val leaf = export.filename
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .trim()
        val cleaned = SAFE_NAME.replace(leaf, "_")
            .trimStart('.')
            .take(MAX_NAME)
        if (cleaned.isEmpty()) return "transcript.${format.extension}"
        return if (cleaned.endsWith(".${format.extension}", ignoreCase = true)) {
            cleaned
        } else {
            "$cleaned.${format.extension}"
        }
    }

    /** The wire's content type when it is one, the format's own when it is not. */
    fun mimeType(export: ExportedTranscript, format: ShareFormat): String {
        val declared = export.contentType.substringBefore(';').trim()
        return if (MIME.matches(declared)) declared else format.mime
    }

    /** What the chooser is titled — the filename reads better than a MIME type. */
    fun chooserTitle(format: ShareFormat): String = format.label
}
