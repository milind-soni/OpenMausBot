package com.openmausbot.chief.data

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Small, local-only crash journal. It deliberately records no exception
 * messages: those can contain message bodies, URLs, or credentials. The
 * journal is useful for support while keeping the app's private data private.
 */
class CrashDiagnostics(private val context: Context) {
    private val directory: File get() = File(context.filesDir, DIRECTORY)

    fun record(throwable: Throwable, at: Long = System.currentTimeMillis()) {
        runCatching {
            directory.mkdirs()
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(Date(at))
            val file = File(directory, "crash-$stamp.log")
            val frames = buildList {
                add("timestamp=$at")
                add("exception=${throwable::class.java.name}")
                throwable.stackTrace.take(MAX_FRAMES).forEach { frame ->
                    add("at ${frame.className}.${frame.methodName}(${frame.fileName ?: "Unknown Source"}:${frame.lineNumber})")
                }
            }
            file.writeText(frames.joinToString("\n") + "\n", Charsets.UTF_8)
            trim()
        }
    }

    fun entries(): List<Entry> = runCatching {
        directory.listFiles { file -> file.isFile && file.name.startsWith("crash-") && file.extension == "log" }
            .orEmpty()
            .sortedByDescending { it.lastModified() }
            .take(MAX_FILES)
            .map { Entry(it.name, it.lastModified()) }
    }.getOrDefault(emptyList())

    fun clear() {
        runCatching { directory.listFiles().orEmpty().forEach { it.delete() } }
    }

    private fun trim() {
        directory.listFiles { file -> file.isFile && file.name.startsWith("crash-") }
            .orEmpty()
            .sortedByDescending { it.lastModified() }
            .drop(MAX_FILES)
            .forEach { it.delete() }
    }

    data class Entry(val name: String, val timestamp: Long)

    companion object {
        private const val DIRECTORY = "diagnostics"
        private const val MAX_FILES = 12
        private const val MAX_FRAMES = 24
    }
}
