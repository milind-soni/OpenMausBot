package com.openmausbot.companion.core

/** The exact conversation a retry-safe shared message belongs to. */
sealed interface MessageDestination {
    val id: String
    val threadId: String

    data class Bot(override val id: String, override val threadId: String) : MessageDestination
    data class Room(override val id: String, override val threadId: String) : MessageDestination
}

enum class SharedAttachmentKind { IMAGE, FILE }

/** A Mac-local path returned by the computer, never a phone content URI. */
data class SharedAttachmentReference(
    val path: String,
    val kind: SharedAttachmentKind,
    val displayName: String? = null,
)

data class UploadedFile(val path: String, val name: String)

/** Pure prompt composer shared by Android's incoming-share UI and client tests. */
object SharedMessageComposer {
    fun compose(
        instruction: String,
        text: List<String>,
        urls: List<String>,
        attachments: List<SharedAttachmentReference>,
    ): String {
        val parts = mutableListOf<String>()
        appendNonEmpty(instruction, parts)
        val seenText = mutableSetOf<String>()
        text.forEach { value ->
            val trimmed = value.trim()
            if (trimmed.isNotEmpty() && seenText.add(trimmed)) parts += trimmed
        }
        val seenUrls = mutableSetOf<String>()
        urls.forEach { value ->
            if (seenUrls.add(value)) appendNonEmpty(value, parts)
        }
        attachments.forEach { attachment ->
            val path = escapeAttribute(attachment.path)
            val name = attachment.displayName?.trim().orEmpty()
            val tag = if (attachment.kind == SharedAttachmentKind.IMAGE) "attached-image" else "attached-file"
            val nameAttribute = if (name.isEmpty()) "" else " name=\"${escapeAttribute(name)}\""
            parts += "<$tag path=\"$path\"$nameAttribute />"
        }
        return parts.joinToString("\n\n")
    }

    private fun appendNonEmpty(value: String, parts: MutableList<String>) {
        value.trim().takeIf(String::isNotEmpty)?.let(parts::add)
    }

    private fun escapeAttribute(value: String): String = value
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\t", "&#9;")
        .replace("\r", "&#13;")
        .replace("\n", "&#10;")
}
