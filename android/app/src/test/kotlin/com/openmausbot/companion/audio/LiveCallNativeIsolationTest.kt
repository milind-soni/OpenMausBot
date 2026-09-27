package com.openmausbot.companion.audio

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The JVM suite must never load libjingle_peerconnection_so: Robolectric
 * cannot, and a test that reached `PeerConnectionFactory.initialize` would die
 * with an UnsatisfiedLinkError. So exactly one production file may import
 * `org.webrtc`, and everything else goes through [LiveCallTransport].
 */
class LiveCallNativeIsolationTest {
    @Test
    fun onlyTheWebRtcTransportImportsOrgWebrtc() {
        val importers = locate("src/main/kotlin").walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { file -> file.readLines().any { it.startsWith("import org.webrtc") } }
            .map { it.name }
            .toSet()
        assertEquals(setOf("WebRtcLiveCallTransport.kt"), importers)
    }

    private fun locate(relative: String): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (prefix in listOf("", "app/")) {
                val file = File(directory, prefix + relative)
                if (file.isDirectory) return file
            }
            directory = directory.parentFile
        }
        error("could not find $relative from ${File(".").absolutePath}")
    }
}
