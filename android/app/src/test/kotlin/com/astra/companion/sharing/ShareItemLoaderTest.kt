package com.astra.companion.sharing

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.OpenableColumns
import com.astra.companion.ui.ShareLoadException
import java.io.ByteArrayInputStream
import java.io.File
import java.util.Base64
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

/**
 * The loader against a real [ContentResolver], because its whole job is to turn
 * someone else's URI grant into bytes this app still owns after the trampoline
 * finishes. What may be sent is [com.astra.companion.ui.SharePolicy]'s;
 * this is about what reaches the cache.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShareItemLoaderTest {

    private val context: Context = RuntimeEnvironment.getApplication()
    private val resolver: ContentResolver get() = context.contentResolver
    private val inboxRoot: File get() = ShareInbox.root(context.cacheDir)
    private val provider = SharedFiles()

    /** A 1x1 PNG: real bytes, so the copied file can be compared to them. */
    private val png: ByteArray = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE" +
            "hQGAhKmMIQAAAABJRU5ErkJggg==",
    )

    @Before
    fun registerTheSendingApp() {
        ShadowContentResolver.registerProviderInternal(AUTHORITY, provider)
    }

    @Test
    fun sharedTextArrivesInlineRatherThanAsAFile() {
        val items = ShareItemLoader.load(
            send { putExtra(Intent.EXTRA_TEXT, "  ship it  ") },
            resolver,
            inboxRoot,
        )

        assertEquals(listOf("ship it"), items.text)
        assertEquals(emptyList(), items.urls)
        assertEquals(emptyList(), items.attachments)
        assertEquals(0, items.ignoredCount)
    }

    @Test
    fun aSharedWebAddressArrivesAsALinkRatherThanAsText() {
        val items = ShareItemLoader.load(
            send { putExtra(Intent.EXTRA_TEXT, "https://example.com/post") },
            resolver,
            inboxRoot,
        )

        assertEquals(listOf("https://example.com/post"), items.urls)
        assertEquals(emptyList(), items.text)
    }

    @Test
    fun aSharedImageIsCopiedIntoTheCacheWhileTheGrantIsStillAlive() {
        val photo = content("photo.png", "image/png", png)

        val items = ShareItemLoader.load(
            send {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, photo)
            },
            resolver,
            inboxRoot,
        )

        val attachment = items.attachments.single()
        assertEquals(LocalShareAttachment.Kind.IMAGE, attachment.kind)
        assertEquals("image/png", attachment.mime)
        assertEquals("photo.png", attachment.name)
        assertEquals(png.size, attachment.bytes)
        // The grant dies with the Activity, so only these bytes can be sent later.
        assertTrue(attachment.file.isFile, "${attachment.file} was never written")
        assertContentEquals(png, attachment.file.readBytes())
        assertEquals(items.inboxDir, attachment.file.parentFile)
        assertTrue(attachment.file.absolutePath.startsWith(inboxRoot.absolutePath))
    }

    @Test
    fun fourItemsAreAcceptedAndAFifthIsRefusedRatherThanDropped() {
        val four = (1..4).map { content("photo$it.png", "image/png", png) }
        val accepted = ShareItemLoader.load(sendMultiple(four), resolver, inboxRoot)
        assertEquals(4, accepted.attachments.size)

        val five = (1..5).map { content("shot$it.png", "image/png", png) }
        val refusal = assertFailsWith<ShareLoadException> {
            ShareItemLoader.load(sendMultiple(five), resolver, inboxRoot)
        }

        assertEquals("Send up to 4 items at a time.", refusal.message)
        // A refused share leaves nothing of itself in the cache.
        assertEquals(emptyList(), inboxRoot.listFiles().orEmpty().toList())
    }

    @Test
    fun fourPhotosPlusACaptionAreAcceptedBecauseExtraTextIsNotAnAttachment() {
        val four = (1..4).map { content("photo$it.png", "image/png", png) }
        val items = ShareItemLoader.load(
            sendMultiple(four).apply { putExtra(Intent.EXTRA_TEXT, "vacation set") },
            resolver,
            inboxRoot,
        )

        assertEquals(4, items.attachments.size)
        assertEquals(listOf("vacation set"), items.text)
    }

    @Test
    fun aShareLargerThanTheCopyCeilingIsRefusedAndLeavesNoPartialFile() {
        // Image branch: iOS still uses the 25 MB copy ceiling. Without the
        // in-loop check this would finish the copy and fail later as "10 MB".
        val photo = Uri.parse("content://$AUTHORITY/photo.png")
        provider.types[photo.toString()] = "image/png"
        provider.names[photo.toString()] = "photo.png"
        shadowOf(resolver).registerInputStreamSupplier(photo) {
            object : java.io.InputStream() {
                private var remaining = 25L * 1_024 * 1_024 + 1
                override fun read(): Int {
                    if (remaining <= 0) return -1
                    remaining -= 1
                    return 1
                }
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (remaining <= 0) return -1
                    val n = minOf(length.toLong(), remaining).toInt()
                    buffer.fill(1, offset, offset + n)
                    remaining -= n
                    return n
                }
            }
        }

        val refusal = assertFailsWith<ShareLoadException> {
            ShareItemLoader.load(
                send {
                    type = "image/png"
                    putExtra(Intent.EXTRA_STREAM, photo)
                },
                resolver,
                inboxRoot,
            )
        }

        assertEquals("photo.png is larger than 25 MB.", refusal.message)
        assertEquals(emptyList(), inboxRoot.listFiles().orEmpty().toList())
    }

    @Test
    fun aZipIsLeftOutOfAShareThatAlsoCarriesText() {
        val archive = content("archive.zip", "application/zip", byteArrayOf(0x50, 0x4B, 0x03, 0x04))

        val items = ShareItemLoader.load(
            send {
                type = "*/*"
                putExtra(Intent.EXTRA_TEXT, "the build output")
                putExtra(Intent.EXTRA_STREAM, archive)
            },
            resolver,
            inboxRoot,
        )

        assertEquals(listOf("the build output"), items.text)
        assertEquals(emptyList(), items.attachments)
        assertEquals(1, items.ignoredCount)
    }

    @Test
    fun aShareOfNothingButAZipIsRefused() {
        val archive = content("archive.zip", "application/zip", byteArrayOf(0x50, 0x4B, 0x03, 0x04))

        val refusal = assertFailsWith<ShareLoadException> {
            ShareItemLoader.load(
                send {
                    type = "application/zip"
                    putExtra(Intent.EXTRA_STREAM, archive)
                },
                resolver,
                inboxRoot,
            )
        }

        assertEquals("There isn't any text, link, image, or supported document to send.", refusal.message)
    }

    private fun send(build: Intent.() -> Unit): Intent = Intent(Intent.ACTION_SEND).apply(build)

    private fun sendMultiple(uris: List<Uri>): Intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        type = "image/png"
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
    }

    /** One file the sending app exposes: a type, a display name, and bytes. */
    private fun content(name: String, mime: String, bytes: ByteArray): Uri {
        val uri = Uri.parse("content://$AUTHORITY/$name")
        provider.types[uri.toString()] = mime
        provider.names[uri.toString()] = name
        shadowOf(resolver).registerInputStreamSupplier(uri) { ByteArrayInputStream(bytes) }
        return uri
    }

    private class SharedFiles : ContentProvider() {
        val types = mutableMapOf<String, String>()
        val names = mutableMapOf<String, String>()

        override fun onCreate(): Boolean = true

        override fun getType(uri: Uri): String? = types[uri.toString()]

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor? {
            val name = names[uri.toString()] ?: return null
            return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { addRow(arrayOf(name)) }
        }

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

        override fun update(
            uri: Uri,
            values: ContentValues?,
            selection: String?,
            selectionArgs: Array<out String>?,
        ): Int = 0
    }

    private companion object {
        const val AUTHORITY = "com.example.gallery"
    }
}
