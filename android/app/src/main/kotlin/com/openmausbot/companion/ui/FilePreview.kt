package com.openmausbot.companion.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.ImageDecoder
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import com.openmausbot.companion.core.DownloadedFile
import com.openmausbot.companion.core.LocalMessageLink
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** How a downloaded file is shown — `FilePreviewItem.Kind` in `AttachmentViews.swift`. */
enum class FilePreviewKind {
    /** Full-window, zoomable image preview. */
    IMAGE,
    /** Rendered in the app, the way a bot reply is. */
    MARKDOWN,
    /** Monospace, in the app. */
    TEXT,
    /** Handed to whatever app opens it — Android's Quick Look. */
    OTHER,
}

object FilePreviewRules {
    /** iOS reads 2 MB of a text file into the preview and says so. */
    const val TEXT_LIMIT_BYTES: Int = 2 * 1_024 * 1_024
    const val TRUNCATED_NOTE: String = "\n\n— Preview truncated. Share or open the file to read the rest. —"

    fun kind(contentType: String, filename: String): FilePreviewKind {
        val mime = contentType.lowercase()
        val suffix = filename.substringAfterLast('.', "").lowercase()
        if (mime.startsWith("image/") || suffix in setOf("png", "jpg", "jpeg", "gif", "webp")) {
            return FilePreviewKind.IMAGE
        }
        if (mime == "text/markdown" || suffix == "md" || suffix == "markdown") return FilePreviewKind.MARKDOWN
        if (mime.startsWith("text/") || mime == "application/json") return FilePreviewKind.TEXT
        return FilePreviewKind.OTHER
    }

    fun text(data: ByteArray): String {
        val visible = if (data.size > TEXT_LIMIT_BYTES) data.copyOf(TEXT_LIMIT_BYTES) else data
        val decoded = visible.toString(Charsets.UTF_8)
        return if (data.size > TEXT_LIMIT_BYTES) decoded + TRUNCATED_NOTE else decoded
    }

    /** The name a bot's link points at, for the "Opening…" line. */
    fun nameForOpening(path: String): String =
        path.split('/', '\\').lastOrNull { it.isNotEmpty() }?.take(180) ?: "file"

    fun noViewer(filename: String): String = "No app on this phone can open $filename."
}

/** Bounds shared by sent-image thumbnails, full-screen previews, and screenshots. */
object AttachmentImageRules {
    const val THUMBNAIL_EDGE: Int = 768
    const val FULL_SCREEN_EDGE: Int = 3_072
    const val LEGACY_INTERMEDIATE_PIXELS: Long = 12_000_000
    const val LEGACY_NEAR_TARGET_MAX_PIXELS: Long = 14_000_000

    /** Largest power-of-two sample whose decoded edge still reaches the requested size. */
    fun sampleSize(width: Int, height: Int, maximumEdge: Int): Int {
        if (width <= 0 || height <= 0 || maximumEdge <= 0) return 1
        var sample = 1
        val sourceEdge = max(width, height)
        while (sample <= Int.MAX_VALUE / 2) {
            val next = sample * 2
            if (sourceEdge / next < maximumEdge) break
            sample = next
        }
        return sample
    }

    /**
     * Android 8 must decode through BitmapFactory. Keep its intermediate under
     * a fixed pixel budget even when that requires one additional power-of-two
     * sample and a modest undershoot; a bounded sharp bitmap beats an OOM.
     */
    fun legacySampleSize(
        width: Int,
        height: Int,
        maximumEdge: Int,
        maximumPixels: Long = LEGACY_INTERMEDIATE_PIXELS,
    ): Int {
        if (width <= 0 || height <= 0 || maximumEdge <= 0 || maximumPixels <= 0) return 1
        var sample = sampleSize(width, height, maximumEdge)
        while (sample <= Int.MAX_VALUE / 2) {
            val pixels = sampledPixels(width, height, sample)
            val sampledEdge = max(sampledDimension(width, sample), sampledDimension(height, sample))
            // BitmapFactory's next step halves each dimension. When the current
            // bitmap is already within 25% of the target, allow a small, hard-
            // capped allocation tolerance instead of throwing away 75% of its
            // pixels (for example 3500² -> 1750²).
            val nearTarget = sampledEdge.toLong() * 4L <= maximumEdge.toLong() * 5L
            val budget = if (nearTarget) {
                maxOf(maximumPixels, LEGACY_NEAR_TARGET_MAX_PIXELS)
            } else {
                maximumPixels
            }
            if (pixels <= budget) break
            sample *= 2
        }
        return sample
    }

    private fun sampledDimension(value: Int, sample: Int): Int {
        val divisor = sample.toLong().coerceAtLeast(1)
        return ((value.toLong() + divisor - 1) / divisor).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    private fun sampledPixels(width: Int, height: Int, sample: Int): Long {
        return sampledDimension(width, sample).toLong() * sampledDimension(height, sample).toLong()
    }

    fun targetSize(width: Int, height: Int, maximumEdge: Int): IntSize {
        if (width <= 0 || height <= 0 || maximumEdge <= 0) return IntSize.Zero
        val scale = minOf(1f, maximumEdge.toFloat() / max(width, height).toFloat())
        return IntSize(
            (width * scale).roundToInt().coerceAtLeast(1),
            (height * scale).roundToInt().coerceAtLeast(1),
        )
    }
}

/** Decode budget for a screen frame, derived from its rendered width and aspect. */
object ScreenShotImageRules {
    private const val MAXIMUM_EDGE = 4_096

    fun maximumEdge(renderedWidthPixels: Int, sourceWidth: Int, sourceHeight: Int): Int {
        if (renderedWidthPixels <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return 1
        val targetWidth = minOf(renderedWidthPixels, sourceWidth)
        val targetHeight = targetWidth.toFloat() * sourceHeight.toFloat() / sourceWidth.toFloat()
        return max(targetWidth.toFloat(), targetHeight).roundToInt().coerceIn(1, MAXIMUM_EDGE)
    }
}

/** Decode untrusted remote pixels off the main thread, at a bounded display size. */
internal fun decodeAttachmentImage(data: ByteArray, maximumEdge: Int): ImageBitmap? {
    if (data.isEmpty()) return null
    return try {
        val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(data))) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val target = AttachmentImageRules.targetSize(info.size.width, info.size.height, maximumEdge)
                decoder.setTargetSize(target.width, target.height)
            }
        } else {
            decodeLegacyOrientedBitmap(data, maximumEdge)
        }
        bitmap?.asImageBitmap()
    } catch (_: OutOfMemoryError) {
        null
    } catch (_: Exception) {
        null
    }
}

/** Read the frame's source aspect first, then spend pixels on its actual on-screen width. */
internal fun decodeScreenShotImage(data: ByteArray, renderedWidthPixels: Int): ImageBitmap? {
    if (data.isEmpty()) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val orientation = runCatching {
        ExifInterface(data.inputStream()).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
        )
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val swapsAxes = orientation in setOf(
        ExifInterface.ORIENTATION_TRANSPOSE,
        ExifInterface.ORIENTATION_ROTATE_90,
        ExifInterface.ORIENTATION_TRANSVERSE,
        ExifInterface.ORIENTATION_ROTATE_270,
    )
    val displayWidth = if (swapsAxes) bounds.outHeight else bounds.outWidth
    val displayHeight = if (swapsAxes) bounds.outWidth else bounds.outHeight
    return decodeAttachmentImage(
        data,
        ScreenShotImageRules.maximumEdge(renderedWidthPixels, displayWidth, displayHeight),
    )
}

/** BitmapFactory ignores EXIF orientation on Android 8; repair those devices explicitly. */
private fun decodeLegacyOrientedBitmap(data: ByteArray, maximumEdge: Int): android.graphics.Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val bitmap = BitmapFactory.decodeByteArray(
            data,
            0,
            data.size,
            BitmapFactory.Options().apply {
                inSampleSize = AttachmentImageRules.legacySampleSize(
                    bounds.outWidth,
                    bounds.outHeight,
                    maximumEdge,
                )
            },
        ) ?: return null
        val orientation = runCatching {
            ExifInterface(data.inputStream()).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> { setRotate(180f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        val oriented = if (
            orientation == ExifInterface.ORIENTATION_NORMAL ||
            orientation == ExifInterface.ORIENTATION_UNDEFINED
        ) {
            bitmap
        } else {
            android.graphics.Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                .also { if (it !== bitmap) bitmap.recycle() }
        }
        val target = AttachmentImageRules.targetSize(oriented.width, oriented.height, maximumEdge)
        if (target.width == oriented.width && target.height == oriented.height) return oriented
        return android.graphics.Bitmap.createScaledBitmap(oriented, target.width, target.height, true)
            .also { if (it !== oriented) oriented.recycle() }
    }

/** A downloaded file, on disk and in memory, ready to show. */
class FilePreviewItem(
    val file: File,
    val filename: String,
    val contentType: String,
    val data: ByteArray,
) {
    val kind: FilePreviewKind get() = FilePreviewRules.kind(contentType, filename)
}

/**
 * Where downloaded files live while they are on screen: one directory per
 * download under the app's cache, reachable through the FileProvider so a
 * viewer app can read exactly that file and nothing else. Only the most recent
 * is kept, and a replacement is written completely before the previous one is
 * removed, so a failed download cannot invalidate the file currently shown.
 */
class FilePreviews(private val context: Context) {
    private val root: File get() = File(context.cacheDir, ROOT)
    private val lock = Any()
    private var current: File? = null
    private var generation: Long = 0

    /** Register synchronously before cancelling the previous coroutine. */
    fun beginRequest(): Long = synchronized(lock) { ++generation }

    /**
     * Serialised with [beginRequest]: a stale request can finish its disk write,
     * but can never replace or delete the newer request's directory.
     */
    suspend fun store(download: DownloadedFile, requestGeneration: Long): FilePreviewItem? {
        staleCleanupComplete.await()
        if (!isCurrent(requestGeneration)) return null
        val directory = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
        val file = File(directory, download.filename)
        try {
            file.writeBytes(download.data)
        } catch (error: Throwable) {
            directory.deleteRecursively()
            throw error
        }
        var replaced: File? = null
        val accepted = synchronized(lock) {
            if (requestGeneration != generation) return@synchronized false
            replaced = current
            current = directory
            true
        }
        if (!accepted) {
            directory.deleteRecursively()
            return null
        }
        replaced?.deleteRecursively()
        return FilePreviewItem(file, download.filename, download.contentType, download.data)
    }

    fun isCurrent(requestGeneration: Long): Boolean = synchronized(lock) { requestGeneration == generation }

    /**
     * Invalidate an in-flight request and remove the preview it may already
     * have published. A request racing this call either loses before publish
     * and deletes its own directory, or is captured here after publish.
     */
    fun invalidateCurrent() {
        val discarded = synchronized(lock) {
            ++generation
            current.also { current = null }
        }
        discarded?.deleteRecursively()
    }

    /** Delete only the dismissed item's directory, never a replacement preview. */
    fun dismiss(item: FilePreviewItem) {
        val directory = item.file.parentFile ?: return
        synchronized(lock) {
            if (current == directory) current = null
        }
        directory.deleteRecursively()
    }

    fun clear() {
        synchronized(lock) {
            ++generation
            current = null
        }
        root.deleteRecursively()
    }

    /** Hand the file to the system. Returns the sentence to show when nothing will take it. */
    fun openWithSystem(item: FilePreviewItem): String? {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(contentUri(item), item.contentType)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return launchChooser(intent, item.filename, FilePreviewRules.noViewer(item.filename))
    }

    /** Share only the private content URI; neither the computer path nor its bearer token leaves the app. */
    fun share(item: FilePreviewItem): String? {
        val intent = Intent(Intent.ACTION_SEND)
            .setType(item.contentType)
            .putExtra(Intent.EXTRA_STREAM, contentUri(item))
            .putExtra(Intent.EXTRA_TITLE, item.filename)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return launchChooser(intent, "Share ${item.filename}", "No app on this phone can share ${item.filename}.")
    }

    private fun contentUri(item: FilePreviewItem) =
        FileProvider.getUriForFile(context, "${context.packageName}.$AUTHORITY_SUFFIX", item.file)

    private fun launchChooser(intent: Intent, title: String, failure: String): String? {
        val chooser = Intent.createChooser(intent, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (context !is android.app.Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(chooser)
            null
        } catch (_: ActivityNotFoundException) {
            failure
        } catch (_: SecurityException) {
            failure
        }
    }

    companion object {
        const val ROOT = "file-previews"
        const val AUTHORITY_SUFFIX = "transcripts"
        private val staleCleanupStarted = AtomicBoolean(false)
        private val staleCleanupComplete = CompletableDeferred<Unit>()

        /** One cleanup per process; stores share its barrier across instances. */
        fun startStaleCleanup(context: Context, scope: CoroutineScope) {
            if (!staleCleanupStarted.compareAndSet(false, true)) return
            val job = scope.launch(Dispatchers.IO) {
                File(context.cacheDir, ROOT).deleteRecursively()
            }
            job.invokeOnCompletion { staleCleanupComplete.complete(Unit) }
        }
    }
}

/** One native, full-window home for an image, readable document, or downloaded file. */
@Composable
internal fun FilePreviewSheet(
    item: FilePreviewItem,
    onDismiss: () -> Unit,
    onShare: () -> String?,
    onOpen: () -> String?,
) {
    var actionError by remember(item.file.absolutePath) { mutableStateOf<String?>(null) }
    val uriHandler = LocalUriHandler.current
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
                Row(
                    modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = onDismiss) { Text("Done") }
                    Text(
                        text = item.filename,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                    )
                    TextButton(onClick = { actionError = onShare() }) { Text("Share") }
                    TextButton(onClick = { actionError = onOpen() }) { Text("Open") }
                }
                HorizontalDivider()
                actionError?.let { message ->
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 13.sp,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                when (item.kind) {
                    FilePreviewKind.IMAGE -> FullScreenImage(item)
                    FilePreviewKind.MARKDOWN -> {
                        val text = remember(item.file.absolutePath) { FilePreviewRules.text(item.data) }
                        SelectionContainer(modifier = Modifier.weight(1f)) {
                            MarkdownText(
                                source = text,
                                openLink = { raw ->
                                    val web = LocalMessageLink.resolve(raw) as? LocalMessageLink.Web
                                    if (web == null) {
                                        actionError = "Open links to other computer files from the original message."
                                    } else {
                                        runCatching { uriHandler.openUri(web.url) }
                                            .onFailure { actionError = "That link couldn't be opened on this phone." }
                                    }
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .verticalScroll(rememberScrollState())
                                    .padding(20.dp),
                            )
                        }
                    }
                    FilePreviewKind.TEXT -> {
                        val text = remember(item.file.absolutePath) { FilePreviewRules.text(item.data) }
                        SelectionContainer(modifier = Modifier.weight(1f)) {
                            Text(
                                text = text,
                                fontSize = 14.sp,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .horizontalScroll(rememberScrollState())
                                    .padding(20.dp),
                            )
                        }
                    }
                    FilePreviewKind.OTHER -> GenericFilePreview(item)
                }
            }
        }
    }
}

@Composable
private fun FullScreenImage(item: FilePreviewItem) {
    var bitmap by remember(item.file.absolutePath) { mutableStateOf<ImageBitmap?>(null) }
    var finished by remember(item.file.absolutePath) { mutableStateOf(false) }
    LaunchedEffect(item.file.absolutePath) {
        bitmap = withContext(Dispatchers.Default) {
            decodeAttachmentImage(item.data, AttachmentImageRules.FULL_SCREEN_EDGE)
        }
        finished = true
    }

    Box(
        modifier = Modifier.fillMaxSize().background(Color.Black).clipToBounds(),
        contentAlignment = Alignment.Center,
    ) {
        val image = bitmap
        when {
            image != null -> ZoomableImage(image, item.filename)
            !finished -> CircularProgressIndicator(color = Color.White, modifier = Modifier.size(28.dp))
            else -> Text("This image couldn't be displayed.", color = Color.White)
        }
    }
}

@Composable
private fun ZoomableImage(image: ImageBitmap, name: String) {
    var scale by remember(image) { mutableFloatStateOf(1f) }
    var offset by remember(image) { mutableStateOf(Offset.Zero) }
    var viewport by remember(image) { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(viewport) {
        offset = ImagePanRules.clamp(offset, scale, viewport, IntSize(image.width, image.height))
    }
    val transform = rememberTransformableState { zoomChange, panChange, _ ->
        val next = (scale * zoomChange).coerceIn(1f, 5f)
        scale = next
        offset = if (next == 1f) {
            Offset.Zero
        } else {
            ImagePanRules.clamp(offset + panChange, next, viewport, IntSize(image.width, image.height))
        }
    }
    Box(modifier = Modifier.fillMaxSize().onSizeChanged { viewport = it }) {
        Image(
            bitmap = image,
            contentDescription = name,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                }
                .transformable(transform),
        )
        if (scale > 1.01f) {
            TextButton(
                onClick = {
                    scale = 1f
                    offset = Offset.Zero
                },
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(8.dp)
                    .background(Color.Black.copy(alpha = 0.55f), androidx.compose.foundation.shape.RoundedCornerShape(18.dp)),
            ) {
                Text("Reset", color = Color.White)
            }
        }
    }
}

/** Translation bounds for a ContentScale.Fit image after zoom. */
object ImagePanRules {
    fun clamp(offset: Offset, scale: Float, viewport: IntSize, image: IntSize): Offset {
        if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) {
            return Offset.Zero
        }
        val fit = minOf(
            viewport.width.toFloat() / image.width,
            viewport.height.toFloat() / image.height,
        )
        val renderedWidth = image.width * fit * scale
        val renderedHeight = image.height * fit * scale
        val maximumX = ((renderedWidth - viewport.width) / 2f).coerceAtLeast(0f)
        val maximumY = ((renderedHeight - viewport.height) / 2f).coerceAtLeast(0f)
        return Offset(
            offset.x.coerceIn(-maximumX, maximumX),
            offset.y.coerceIn(-maximumY, maximumY),
        )
    }
}

@Composable
private fun GenericFilePreview(item: FilePreviewItem) {
    val suffix = item.filename.substringAfterLast('.', "file").uppercase().take(8)
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.weight(1f))
        Box(
            modifier = Modifier
                .size(88.dp)
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), androidx.compose.foundation.shape.RoundedCornerShape(22.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text(suffix, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        }
        Text(
            text = item.filename,
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 18.dp),
        )
        Text(
            text = "${AttachmentImportRules.formatBytes(item.data.size.toLong())} · ${item.contentType}",
            color = secondaryTint,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(
            text = "Use Open to view this file in a compatible app.",
            color = secondaryTint,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 16.dp),
        )
        Spacer(Modifier.weight(1f))
    }
}
