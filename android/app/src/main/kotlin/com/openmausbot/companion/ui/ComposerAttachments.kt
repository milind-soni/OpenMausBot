package com.openmausbot.companion.ui

import androidx.compose.ui.res.stringResource

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.AttachmentPolicy
import com.openmausbot.companion.core.PendingMessageAttachment
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * What the composer decides about attachments, with no Android in it — the
 * rules half of the attachment code `ios/App/ChatView.swift` gained in #695.
 */
object AttachmentImportRules {
    const val TOO_MANY: String = "Send up to ${AttachmentPolicy.MAXIMUM_ITEMS} items at a time."

    fun unreadable(name: String): String = "OpenMausBot couldn't read $name. Try exporting it to Files first."

    fun unsupported(name: String): String =
        "$name isn't a supported attachment. Try an image, PDF, text, Word, Excel, or PowerPoint file."

    fun tooLarge(name: String, limitBytes: Int): String =
        "$name is larger than the ${formatBytes(limitBytes.toLong())} remaining attachment limit."

    /** `Photo.jpg` for one, `Photo 2.jpg` for the second of several. */
    fun photoName(index: Int, count: Int, extension: String): String =
        if (count == 1) "Photo.$extension" else "Photo ${index + 1}.$extension"

    fun extensionForImageMime(mime: String): String = when (AttachmentPolicy.normalizedMime(mime)) {
        "image/png" -> "png"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        else -> "jpg"
    }

    /** Whatever the 50 MB total has left after what is already attached. */
    fun remainingBytes(attached: List<PendingMessageAttachment>): Int =
        max(0, AttachmentPolicy.MAXIMUM_TOTAL_BYTES - attached.sumOf { it.data.size })

    /** The most one more item of this kind may read: its own cap, or the total's remainder. */
    fun readLimit(kind: PendingMessageAttachment.Kind, remainingBytes: Int): Int {
        val itemLimit = when (kind) {
            PendingMessageAttachment.Kind.IMAGE -> AttachmentPolicy.MAXIMUM_IMAGE_BYTES
            PendingMessageAttachment.Kind.FILE -> AttachmentPolicy.MAXIMUM_FILE_BYTES
        }
        return min(itemLimit, remainingBytes)
    }

    fun canAdd(attached: Int, preparing: Boolean, sending: Boolean): Boolean =
        attached < AttachmentPolicy.MAXIMUM_ITEMS && !preparing && !sending

    /** `canSend` in the Swift: text or an attachment, and nothing in flight. */
    fun canSend(draft: String, attached: Int, preparing: Boolean, sending: Boolean): Boolean =
        (draft.isNotBlank() || attached > 0) && !preparing && !sending

    /** `ByteCountFormatter` with `.file`: KB/MB with one decimal, bytes below a kilobyte. */
    fun formatBytes(bytes: Long): String = when {
        bytes < 1_000 -> "$bytes bytes"
        bytes < 1_000_000 -> String.format(Locale.ROOT, "%.0f KB", bytes / 1_000.0)
        bytes < 1_000_000_000 -> String.format(Locale.ROOT, "%.1f MB", bytes / 1_000_000.0)
        else -> String.format(Locale.ROOT, "%.2f GB", bytes / 1_000_000_000.0)
    }
}

class AttachmentImportException(message: String) : Exception(message)

/**
 * Reading what the pickers hand back into app-owned bytes. Every read is
 * bounded by what the policy has room for: a provider can lie about a size, so
 * the stream is read one byte past the allowance and refused, never trusted.
 */
object AttachmentImport {
    private const val PHOTO_MAX_PIXELS = 3_072

    /** A document (or an image) from the system file picker. */
    fun readDocument(resolver: ContentResolver, uri: Uri, remainingBytes: Int): PendingMessageAttachment {
        val name = safeName(displayName(resolver, uri) ?: "that file")
        val mime = AttachmentPolicy.normalizedMime(
            resolver.getType(uri)?.takeIf { it.isNotBlank() && it != "*/*" }
                ?: mimeForName(name)
                ?: "application/octet-stream",
        )
        val kind = AttachmentPolicy.kindForMime(mime) ?: throw AttachmentImportException(AttachmentImportRules.unsupported(name))
        val limit = AttachmentImportRules.readLimit(kind, remainingBytes)
        val data = readBounded(resolver, uri, limit)
            ?: throw AttachmentImportException(AttachmentImportRules.tooLarge(name, limit))
        if (data.isEmpty()) throw AttachmentImportException(AttachmentImportRules.unreadable(name))
        return PendingMessageAttachment(data = data, name = name, mime = mime, kind = kind)
    }

    /**
     * A picture from the photo picker. A supported type within its limit
     * travels as it is; anything else — HEIC, a 40 MB PNG — is re-encoded as
     * JPEG the way the Share target does, so the picker never refuses a photo
     * the computer could have shown.
     */
    fun readPhoto(
        resolver: ContentResolver,
        uri: Uri,
        index: Int,
        count: Int,
        remainingBytes: Int,
    ): PendingMessageAttachment {
        val label = if (count == 1) "that photo" else "photo ${index + 1}"
        val declared = AttachmentPolicy.normalizedMime(resolver.getType(uri).orEmpty())
        val limit = AttachmentImportRules.readLimit(PendingMessageAttachment.Kind.IMAGE, remainingBytes)
        val raw = readBounded(resolver, uri, limit)
        if (raw != null && raw.isNotEmpty() && declared in AttachmentPolicy.IMAGE_MIME_TYPES) {
            val extension = AttachmentImportRules.extensionForImageMime(declared)
            return PendingMessageAttachment(
                data = raw,
                name = AttachmentImportRules.photoName(index, count, extension),
                mime = declared,
                kind = PendingMessageAttachment.Kind.IMAGE,
            )
        }
        val jpeg = transcodeJpeg(resolver, uri)
            ?: throw AttachmentImportException(AttachmentImportRules.unsupported(label))
        if (jpeg.size > limit) throw AttachmentImportException(AttachmentImportRules.tooLarge(label, limit))
        return PendingMessageAttachment(
            data = jpeg,
            name = AttachmentImportRules.photoName(index, count, "jpg"),
            mime = "image/jpeg",
            kind = PendingMessageAttachment.Kind.IMAGE,
        )
    }

    /** The bytes, or null when the stream runs past [limit]. */
    private fun readBounded(resolver: ContentResolver, uri: Uri, limit: Int): ByteArray? {
        val input = runCatching { resolver.openInputStream(uri) }.getOrNull() ?: return ByteArray(0)
        input.use { source ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1_024)
            var copied = 0
            while (true) {
                val read = source.read(buffer)
                if (read < 0) break
                if (copied + read > limit) return null
                out.write(buffer, 0, read)
                copied += read
            }
            return out.toByteArray()
        }
    }

    private fun transcodeJpeg(resolver: ContentResolver, uri: Uri): ByteArray? {
        fun open(): InputStream? = runCatching { resolver.openInputStream(uri) }.getOrNull()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open()?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > PHOTO_MAX_PIXELS) sample *= 2
        val bitmap = open()?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return null
        val out = ByteArrayOutputStream()
        val written = bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
        bitmap.recycle()
        return if (written) out.toByteArray() else null
    }

    private fun displayName(resolver: ContentResolver, uri: Uri): String? {
        if (uri.scheme == ContentResolver.SCHEME_FILE) return uri.lastPathSegment
        val cursor = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        }.getOrNull()
        cursor?.use {
            if (it.moveToFirst()) {
                val column = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0) it.getString(column)?.let { name -> return name }
            }
        }
        return uri.lastPathSegment
    }

    private fun mimeForName(name: String): String? {
        val extension = name.substringAfterLast('.', "").lowercase()
        if (extension.isEmpty()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
            ?: SharePolicy.mimeForExtension(extension)
    }

    private fun safeName(raw: String): String {
        val trimmed = raw.substringAfterLast('/').substringAfterLast('\\').trim()
        val cleaned = trimmed.map { if (it.isISOControl()) ' ' else it }.joinToString("").ifBlank { "file" }
        return cleaned.take(180)
    }
}

/** One attachment waiting above the composer — `PendingAttachmentChip` in `AttachmentViews.swift`. */
@Composable
internal fun PendingAttachmentChip(
    attachment: PendingMessageAttachment,
    enabled: Boolean,
    onRemove: () -> Unit,
) {
    val outline = secondaryTint.copy(alpha = 0.10f)
    Row(
        modifier = Modifier
            .widthIn(max = 280.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(outline)
            .border(1.dp, outline, RoundedCornerShape(14.dp))
            .padding(start = 7.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AttachmentThumbnail(attachment)
        Column(modifier = Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(
                text = attachment.name,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = AttachmentImportRules.formatBytes(attachment.data.size.toLong()),
                fontSize = 11.sp,
                color = secondaryTint,
            )
        }
        TouchTarget(
            onClick = onRemove,
            enabled = enabled,
            contentDescription = stringResource(R.string.mobile_remove_attachment_name_ecd908a4, attachment.name),
        ) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .background(secondaryTint.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = null,
                    tint = secondaryTint,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
    }
}

@Composable
private fun AttachmentThumbnail(attachment: PendingMessageAttachment) {
    val shape = RoundedCornerShape(8.dp)
    val bitmap = remember(attachment.id) {
        if (attachment.kind != PendingMessageAttachment.Kind.IMAGE) return@remember null
        runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(attachment.data, 0, attachment.data.size, bounds)
            var sample = 1
            while (max(bounds.outWidth, bounds.outHeight) / sample > 256) sample *= 2
            BitmapFactory.decodeByteArray(
                attachment.data,
                0,
                attachment.data.size,
                BitmapFactory.Options().apply { inSampleSize = sample },
            )?.asImageBitmap()
        }.getOrNull()
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(34.dp).clip(shape).semantics { contentDescription = "" },
        )
    } else {
        Box(
            modifier = Modifier
                .size(34.dp)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), shape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_attach_file),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
