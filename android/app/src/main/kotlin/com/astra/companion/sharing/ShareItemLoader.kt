package com.astra.companion.sharing

import android.content.ContentResolver
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.webkit.MimeTypeMap
import androidx.exifinterface.media.ExifInterface
import com.astra.companion.ui.ShareLoadException
import com.astra.companion.ui.SharePolicy
import java.io.File
import java.util.UUID

data class LocalShareAttachment(
    val id: String,
    val file: File,
    val name: String,
    val mime: String,
    val bytes: Int,
    val kind: Kind,
) {
    enum class Kind { IMAGE, FILE }
}

data class LoadedShareItems(
    val text: List<String>,
    val urls: List<String>,
    val attachments: List<LocalShareAttachment>,
    val ignoredCount: Int,
    val inboxDir: File,
)

/**
 * Copy an incoming share into app-private storage while the trampoline still
 * holds the sender's URI grant.
 */
object ShareItemLoader {
    private const val COPY_CHUNK_BYTES = 64 * 1_024
    /** iOS copy ceiling for both image and file branches (`ShareItemLoader.swift:268`). */
    private const val COPY_LIMIT_MB = 25
    private const val COPY_LIMIT_BYTES = COPY_LIMIT_MB * 1_024L * 1_024L
    private const val THUMBNAIL_MAX_PIXELS = 3_072

    fun load(intent: Intent?, resolver: ContentResolver, inboxRoot: File): LoadedShareItems {
        val action = intent?.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
            throw ShareLoadException(SharePolicy.nothingSupported())
        }
        inboxRoot.mkdirs()
        inboxRoot.listFiles()?.forEach { runCatching { it.deleteRecursively() } }
        val inbox = File(inboxRoot, UUID.randomUUID().toString()).apply { mkdirs() }
        try {
            return loadInto(intent, resolver, inbox)
        } catch (error: Throwable) {
            runCatching { inbox.deleteRecursively() }
            throw error
        }
    }

    fun cleanUp(payload: SharePayload?) {
        val directory = payload?.inboxDir ?: return
        runCatching { directory.deleteRecursively() }
    }

    fun cleanUp(items: LoadedShareItems?) {
        val directory = items?.inboxDir ?: return
        runCatching { directory.deleteRecursively() }
    }

    fun preview(items: LoadedShareItems) = SharePolicy.SharePreview(
        textCount = items.text.size,
        linkCount = items.urls.size,
        attachmentNames = items.attachments.map(LocalShareAttachment::name),
        imageCount = items.attachments.count { it.kind == LocalShareAttachment.Kind.IMAGE },
        ignoredCount = items.ignoredCount,
    )

    private fun loadInto(intent: Intent, resolver: ContentResolver, inbox: File): LoadedShareItems {
        val extraText = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
            .takeIf(String::isNotEmpty)
        val streams = streamUris(intent)
        // EXTRA_TEXT is a caption, not an attachment — iOS counts only providers.
        if (streams.isEmpty() && extraText == null) {
            throw ShareLoadException(SharePolicy.nothingSupported())
        }
        if (SharePolicy.tooManyItems(streams.size)) {
            throw ShareLoadException(SharePolicy.tooManyItems())
        }

        val texts = mutableListOf<String>()
        val urls = mutableListOf<String>()
        val attachments = mutableListOf<LocalShareAttachment>()
        var ignored = 0
        var textCharacters = 0
        var attachmentBytes = 0

        fun addText(value: String) {
            textCharacters += value.length
            if (textCharacters > SharePolicy.MAXIMUM_TEXT_CHARACTERS) {
                throw ShareLoadException(SharePolicy.tooMuchText())
            }
            texts += value
        }

        extraText?.let { value ->
            if (SharePolicy.validWebUrl(value)) urls += value.trim() else addText(value)
        }

        for (uri in streams) {
            when (val kind = SharePolicy.classifyStream(mimeOf(resolver, intent, uri), nameOf(resolver, uri))) {
                SharePolicy.StreamKind.URL -> {
                    val value = readText(resolver, uri)
                    if (value != null && SharePolicy.validWebUrl(value)) urls += value.trim() else ignored += 1
                }
                SharePolicy.StreamKind.TEXT -> {
                    val value = readText(resolver, uri)?.trim().orEmpty()
                    if (value.isEmpty()) ignored += 1 else addText(value)
                }
                SharePolicy.StreamKind.IMAGE, SharePolicy.StreamKind.FILE -> {
                    val copied = copyUri(resolver, intent, uri, inbox, kind)
                    attachmentBytes += copied.bytes
                    if (attachmentBytes > SharePolicy.MAXIMUM_TOTAL_ATTACHMENT_BYTES) {
                        throw ShareLoadException(SharePolicy.tooLarge("Those files together", 50))
                    }
                    attachments += copied
                }
                SharePolicy.StreamKind.IGNORE -> ignored += 1
            }
        }

        if (texts.isEmpty() && urls.isEmpty() && attachments.isEmpty()) {
            throw ShareLoadException(SharePolicy.nothingSupported())
        }
        return LoadedShareItems(
            text = texts,
            urls = urls,
            attachments = attachments,
            ignoredCount = ignored,
            inboxDir = inbox,
        )
    }

    private fun streamUris(intent: Intent): List<Uri> {
        val extras = buildList {
            when (intent.action) {
                Intent.ACTION_SEND -> parcelableUri(intent)?.let(::add)
                Intent.ACTION_SEND_MULTIPLE -> parcelableUriList(intent).forEach(::add)
            }
            val clip = intent.clipData ?: return@buildList
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index).uri?.let(::add)
            }
        }
        return extras.distinctBy(Uri::toString)
    }

    @Suppress("DEPRECATION")
    private fun parcelableUri(intent: Intent): Uri? = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }

    @Suppress("DEPRECATION")
    private fun parcelableUriList(intent: Intent): List<Uri> {
        val values = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        }
        return values.orEmpty().filterNotNull()
    }

    private fun mimeOf(resolver: ContentResolver, intent: Intent, uri: Uri): String? {
        val fromResolver = resolver.getType(uri)
        if (!fromResolver.isNullOrBlank()) return fromResolver
        val fromIntent = intent.type?.takeIf { it.isNotBlank() && it != "*/*" }
        if (fromIntent != null) return fromIntent
        val extension = nameOf(resolver, uri)?.substringAfterLast('.', "")
        return extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.lowercase()) }
            ?: SharePolicy.mimeForExtension(extension.orEmpty())
    }

    private fun nameOf(resolver: ContentResolver, uri: Uri): String? {
        if (uri.scheme == ContentResolver.SCHEME_FILE) return uri.lastPathSegment
        val cursor = runCatching {
            resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
        }.getOrNull()
        cursor?.use {
            if (it.moveToFirst()) {
                val index = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return it.getString(index)
            }
        }
        return uri.lastPathSegment
    }

    private fun readText(resolver: ContentResolver, uri: Uri): String? =
        runCatching {
            resolver.openInputStream(uri)?.use { stream ->
                stream.readBytes().toString(Charsets.UTF_8)
            }
        }.getOrNull()

    private fun copyUri(
        resolver: ContentResolver,
        intent: Intent,
        uri: Uri,
        inbox: File,
        kind: SharePolicy.StreamKind,
    ): LocalShareAttachment {
        val displayName = safeName(nameOf(resolver, uri) ?: "item")
        val mime = mimeOf(resolver, intent, uri)?.lowercase()?.substringBefore(';')?.trim().orEmpty()
        val target = File(inbox, "${UUID.randomUUID()}-$displayName")
        val size = runCatching {
            copyBounded(resolver, uri, target, displayName)
        }.getOrElse { error ->
            runCatching { target.delete() }
            if (error is ShareLoadException) throw error
            throw ShareLoadException(SharePolicy.unreadable(displayName))
        }
        if (size <= 0L) {
            target.delete()
            throw ShareLoadException(SharePolicy.unreadable(displayName))
        }
        val resolvedMime = mime.ifEmpty {
            SharePolicy.mimeForExtension(displayName.substringAfterLast('.', "")) ?: "application/octet-stream"
        }
        if (kind == SharePolicy.StreamKind.IMAGE) {
            if (resolvedMime in SharePolicy.IMAGE_MIMES && size <= SharePolicy.MAXIMUM_IMAGE_BYTES.toLong()) {
                return attachment(target, displayName, resolvedMime, size.toInt(), LocalShareAttachment.Kind.IMAGE)
            }
            val converted = transcodeJpeg(target, inbox)
            target.delete()
            return converted ?: throw ShareLoadException(SharePolicy.tooLarge(displayName, 10))
        }
        if (size > SharePolicy.MAXIMUM_FILE_BYTES.toLong()) {
            target.delete()
            throw ShareLoadException(SharePolicy.tooLarge(displayName, 25))
        }
        if (resolvedMime !in SharePolicy.DOCUMENT_MIMES) {
            target.delete()
            throw ShareLoadException(SharePolicy.unsupportedDocument(displayName))
        }
        return attachment(target, displayName, resolvedMime, size.toInt(), LocalShareAttachment.Kind.FILE)
    }

    /**
     * Stream into our own file and enforce the ceiling on bytes actually read.
     * A provider can change its temporary file after a metadata check, so a
     * pre-copy length alone is not a limit.
     */
    private fun copyBounded(
        resolver: ContentResolver,
        uri: Uri,
        target: File,
        displayName: String,
    ): Long {
        val input = resolver.openInputStream(uri)
            ?: throw ShareLoadException(SharePolicy.unreadable(displayName))
        input.use { source ->
            target.outputStream().use { output ->
                val buffer = ByteArray(COPY_CHUNK_BYTES)
                var copied = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    if (copied + read > COPY_LIMIT_BYTES) {
                        throw ShareLoadException(SharePolicy.tooLarge(displayName, COPY_LIMIT_MB))
                    }
                    output.write(buffer, 0, read)
                    copied += read
                }
                return copied
            }
        }
    }

    private fun attachment(
        file: File,
        name: String,
        mime: String,
        bytes: Int,
        kind: LocalShareAttachment.Kind,
    ) = LocalShareAttachment(
        id = UUID.randomUUID().toString(),
        file = file,
        name = name,
        mime = mime,
        bytes = bytes,
        kind = kind,
    )

    // Two full-size 48 MP bitmaps would blow the process budget.
    private fun transcodeJpeg(source: File, inbox: File): LocalShareAttachment? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val sampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, THUMBNAIL_MAX_PIXELS)
        val decoded = BitmapFactory.decodeFile(
            source.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sampleSize },
        ) ?: return null
        val bitmap = applyExifOrientation(source, decoded)
        if (bitmap !== decoded) decoded.recycle()
        val out = File(inbox, "${UUID.randomUUID()}-image.jpg")
        val written = runCatching {
            out.outputStream().use { stream ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 85, stream)
            }
        }.getOrDefault(false)
        bitmap.recycle()
        val size = out.length()
        if (!written || size <= 0L || size > SharePolicy.MAXIMUM_IMAGE_BYTES.toLong()) {
            out.delete()
            return null
        }
        return attachment(out, "image.jpg", "image/jpeg", size.toInt(), LocalShareAttachment.Kind.IMAGE)
    }

    private fun sampleSizeFor(width: Int, height: Int, maxPixels: Int): Int {
        var sample = 1
        val longest = maxOf(width, height)
        while (longest / sample > maxPixels) {
            sample *= 2
        }
        return sample
    }

    private fun applyExifOrientation(source: File, bitmap: Bitmap): Bitmap {
        val orientation = runCatching {
            ExifInterface(source).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                matrix.setRotate(180f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
            else -> return bitmap
        }
        return runCatching {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        }.getOrDefault(bitmap)
    }

    private fun safeName(raw: String): String {
        val trimmed = raw.substringAfterLast('/').substringAfterLast('\\').trim()
        val cleaned = trimmed.map { character ->
            if (character.isISOControl() || character == File.separatorChar) ' ' else character
        }.joinToString("").ifBlank { "item" }
        return cleaned.take(180)
    }
}
