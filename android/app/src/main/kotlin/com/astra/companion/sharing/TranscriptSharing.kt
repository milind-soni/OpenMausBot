package com.astra.companion.sharing

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.astra.companion.core.ExportedTranscript
import com.astra.companion.ui.ShareFormat
import com.astra.companion.ui.SharePayload
import java.io.File

/**
 * Handing an exported transcript to the Android share sheet.
 *
 * A file rather than `EXTRA_TEXT`, which is the choice worth stating. iOS shares
 * the exported file through `UIActivityViewController`, so the receiving app gets
 * `transcript.md` with its own type; matching that keeps the two phones' output
 * identical. It also sidesteps the binder transaction limit — a long thread's
 * markdown runs to hundreds of kilobytes, and an `EXTRA_TEXT` that large fails
 * with `TransactionTooLargeException` at exactly the moment the feature is most
 * useful. Sharing text for short transcripts and a file for long ones would make
 * the behaviour depend on a threshold no one can see.
 *
 * The file lives in the app's cache directory, which is app-private and reclaimed
 * by the system under pressure. [clearPrevious] runs before each write, so at most
 * the most recent export is on disk — deleting immediately after `startActivity`
 * is not an option, since the receiving app reads the URI afterwards.
 */
class TranscriptSharing(
    private val context: Context,
    private val authority: String = "${context.packageName}.transcripts",
) {
    /**
     * @return null on success, or a human-readable reason the share did not open.
     */
    fun share(export: ExportedTranscript, format: ShareFormat): String? {
        val directory = File(context.cacheDir, DIRECTORY)
        return try {
            clearPrevious(directory)
            if (!directory.exists() && !directory.mkdirs()) {
                return "Could not prepare the transcript for sharing."
            }
            val file = File(directory, SharePayload.fileName(export, format))
            file.writeBytes(export.data)

            val uri = FileProvider.getUriForFile(context, authority, file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = SharePayload.mimeType(export, format)
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, file.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, SharePayload.chooserTitle(format)).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            null
        } catch (error: Exception) {
            "Could not share the transcript: ${error.message ?: error::class.simpleName}"
        }
    }

    private fun clearPrevious(directory: File) {
        directory.listFiles()?.forEach { runCatching { it.delete() } }
    }

    private companion object {
        const val DIRECTORY = "shared-transcripts"
    }
}
