package com.openmausbot.chief.data

import androidx.test.core.app.ApplicationProvider
import com.openmausbot.chief.MausApplication
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class CrashDiagnosticsTest {
    @Test
    fun recordsOnlySafeStackMetadataAndBoundsReports() {
        val context = ApplicationProvider.getApplicationContext<MausApplication>()
        val diagnostics = CrashDiagnostics(context)
        diagnostics.clear()
        val secret = "message body and omb_secret_should_not_be_saved"

        diagnostics.record(IllegalStateException(secret), at = 1_700_000_000_000)

        val entries = diagnostics.entries()
        assertEquals(1, entries.size)
        val file = File(context.filesDir, "diagnostics/${entries.single().name}")
        val text = file.readText()
        assertTrue(text.contains("exception=java.lang.IllegalStateException"))
        assertTrue(text.contains("CrashDiagnosticsTest"))
        assertFalse(text.contains(secret))
        assertFalse(text.contains("omb_secret"))
        diagnostics.clear()
        assertTrue(diagnostics.entries().isEmpty())
    }
}
