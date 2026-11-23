package com.openmausbot.companion.ui

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.OpenableColumns
import com.openmausbot.companion.core.AttachmentPolicy
import com.openmausbot.companion.core.PendingMessageAttachment
import java.io.ByteArrayInputStream
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AttachmentImportTest {
    private val resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
    private val provider = PickedFiles()

    @Before
    fun registerProvider() {
        ShadowContentResolver.registerProviderInternal(AUTHORITY, provider)
    }

    @Test
    fun pickedCsvWithAndroidMimeAliasCanBeUploadedAsCsv() {
        val bytes = "a,b\n1,2\n".toByteArray()
        val uri = file("rows.csv", "text/comma-separated-values", bytes)

        val attachment = AttachmentImport.readDocument(resolver, uri, AttachmentPolicy.MAXIMUM_TOTAL_BYTES)

        assertEquals("rows.csv", attachment.name)
        assertEquals("text/csv", attachment.mime)
        assertEquals(PendingMessageAttachment.Kind.FILE, attachment.kind)
        assertContentEquals(bytes, attachment.data)
    }

    @Test
    fun pickedHtmlRenamedCsvRemainsUnsupported() {
        val uri = file("rows.csv", "text/html", "<script>bad()</script>".toByteArray())

        assertFailsWith<AttachmentImportException> {
            AttachmentImport.readDocument(resolver, uri, AttachmentPolicy.MAXIMUM_TOTAL_BYTES)
        }
    }

    private fun file(name: String, mime: String, bytes: ByteArray): Uri {
        val uri = Uri.parse("content://$AUTHORITY/$name")
        provider.types[uri.toString()] = mime
        provider.names[uri.toString()] = name
        shadowOf(resolver).registerInputStreamSupplier(uri) { ByteArrayInputStream(bytes) }
        return uri
    }

    private class PickedFiles : ContentProvider() {
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
        ): Cursor? = names[uri.toString()]?.let { name ->
            MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).apply { addRow(arrayOf(name)) }
        }
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
    }

    private companion object {
        const val AUTHORITY = "com.example.picked-files"
    }
}
