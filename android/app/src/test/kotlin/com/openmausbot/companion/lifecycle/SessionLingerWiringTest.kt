package com.openmausbot.companion.lifecycle

import androidx.lifecycle.Lifecycle
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.w3c.dom.Element

/**
 * The machine can be green while the Application still cancels the stream at
 * `onStop` — so this pins the wiring itself.
 *
 * Two halves, because neither alone is enough:
 *
 * 1. [installSessionLinger] is the one function `OpenMausApp.onCreate` calls,
 *    and here it is driven through a real lifecycle, registering the very
 *    observer the Application registers.
 * 2. A source pin on `OpenMausApp.kt`, in the spirit of `PairingLinkManifestTest`:
 *    it fails if the Application goes back to an inline observer or to calling
 *    `disconnect()` on the way out. That is a text assertion, not a runtime
 *    proof — it is here because instantiating the real Application in a JVM
 *    suite would drag in DataStore, the Keystore and MediaPlayer, and prove
 *    less than it cost.
 *
 * The service declaration is pinned from the merged-source manifest for the
 * same reason `PairingLinkManifestTest` reads it: `exported`, foreground
 * service attributes and `stopWithTask` are things no compiler checks.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionLingerWiringTest {

    @Test
    fun `the installed observer lingers instead of disconnecting at ON_STOP`() = runTest {
        val stream = FakeStream()
        val sink = RecordingSink()
        val session = session(stream, sink)
        val anchor = FakeAnchor()

        // The same install-and-settle sequence `SessionLingerTest` drives, so
        // `ON_STOP` below is reached on a session that is genuinely Live rather
        // than one still Connecting behind a hello that was never collected.
        val owner = installLive(session, stream, anchor).owner
        assertEquals(1, stream.collectors)

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        runCurrent()

        assertEquals(1, stream.collectors)
        assertEquals(listOf(1L), anchor.started)

        stream.emit(notify("done", seq = 3))
        runCurrent()
        assertEquals(1, sink.delivered.size)

        advanceTimeBy(25_000)
        runCurrent()
        runCurrent()
        assertEquals(0, stream.collectors)
        assertEquals(listOf(1L), anchor.stopped)
    }

    @Test
    fun `the Application installs the linger and never disconnects on the way out`() {
        val source = sourceFile("OpenMausApp.kt").readText()

        assertTrue(
            source.contains("installSessionLinger("),
            "OpenMausApp must install the linger coordinator",
        )
        assertFalse(
            source.contains("disconnect()"),
            "OpenMausApp must not cancel the stream itself — that is what dropped the notification",
        )
        assertFalse(
            source.contains("DefaultLifecycleObserver"),
            "the process-lifecycle observer must be SessionLingerController, not an inline one",
        )
    }

    @Test
    fun `the linger anchor is a plain, unexported, non-sticky service`() {
        val service = service(".lifecycle.SessionLingerService")

        assertEquals("false", service.getAttributeNS(ANDROID, "exported"))
        assertEquals("true", service.getAttributeNS(ANDROID, "stopWithTask"))
        assertEquals("", service.getAttributeNS(ANDROID, "foregroundServiceType"))
        assertEquals("", service.getAttributeNS(ANDROID, "permission"))
        assertEquals(0, service.getElementsByTagName("intent-filter").length)

        // The four assertEquals above are the actual invariant this test name
        // promises: SessionLingerService itself declares no foregroundServiceType,
        // no permission, no intent-filter, and stays exported=false/stopWithTask=true.
        // A manifest-wide "contains FOREGROUND_SERVICE" ban used to stand in for
        // that, back when this was the only service in the app; it stopped being a
        // proxy for this test's own claim once AlwaysOnConnectionService — a
        // separate, user-opt-in, Settings-toggled service for a different job
        // (surviving the app being fully closed, not a 25s post-background grace
        // window) — legitimately needed one. See AlwaysOnConnectionService's own
        // kdoc for why that service does need FOREGROUND_SERVICE.
    }

    private val ANDROID = "http://schemas.android.com/apk/res/android"

    private val manifestFile: File by lazy { locate("src/main/AndroidManifest.xml") }

    private fun service(name: String): Element {
        val document = DocumentBuilderFactory.newInstance()
            .apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(manifestFile)
        val services = document.documentElement.getElementsByTagName("service")
        for (index in 0 until services.length) {
            val element = services.item(index) as Element
            if (element.getAttributeNS(ANDROID, "name") == name) return element
        }
        error("no <service android:name=\"$name\"> in the manifest")
    }

    private fun sourceFile(name: String): File =
        locate("src/main/kotlin/com/openmausbot/companion/$name")

    private fun locate(relative: String): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (prefix in listOf("", "app/")) {
                val file = File(directory, prefix + relative)
                if (file.isFile) return file
            }
            directory = directory.parentFile
        }
        error("could not find $relative from ${File(".").absolutePath}")
    }
}
