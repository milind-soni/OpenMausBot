package com.astra.companion

import com.astra.companion.ui.PairingHandoff
import com.astra.companion.ui.PairingLink
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.w3c.dom.Element

/**
 * The §6 guarantee for a pairing deep link lives in the manifest, so that is
 * where it is checked.
 *
 * A URL carrying `omb_pair_…` must never reach an Activity whose launching Intent
 * the system keeps: the ActivityManager hands that Intent back when it restarts
 * the Activity after a process kill, and under the default `persistRootOnly` it
 * writes a *root* Activity's Intent to task state that survives a reboot. Either
 * one would let a one-time credential outlive the process that is supposed to be
 * the only thing holding it.
 *
 * These assertions are about attributes no compiler checks and no unit test would
 * otherwise notice going missing.
 */
class PairingLinkManifestTest {
    private val android = "http://schemas.android.com/apk/res/android"

    private val manifest: Element by lazy {
        val file = locateManifest()
        val document = DocumentBuilderFactory.newInstance()
            .apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(file)
        document.documentElement
    }

    private fun locateManifest(): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (candidate in listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")) {
                val file = File(directory, candidate)
                if (file.isFile) return file
            }
            directory = directory.parentFile
        }
        error("could not find AndroidManifest.xml from ${File(".").absolutePath}")
    }

    private fun activity(name: String): Element {
        val activities = manifest.getElementsByTagName("activity")
        for (index in 0 until activities.length) {
            val element = activities.item(index) as Element
            if (element.getAttributeNS(android, "name") == name) return element
        }
        error("no <activity android:name=\"$name\"> in the manifest")
    }

    private fun Element.hasPairingFilter(): Boolean {
        val filters = getElementsByTagName("intent-filter")
        for (index in 0 until filters.length) {
            val filter = filters.item(index) as Element
            val data = filter.getElementsByTagName("data")
            for (dataIndex in 0 until data.length) {
                val element = data.item(dataIndex) as Element
                if (element.getAttributeNS(android, "scheme") == PairingLink.SCHEME &&
                    element.getAttributeNS(android, "host") == PairingLink.HOST
                ) {
                    return true
                }
            }
        }
        return false
    }

    @Test
    fun `the pairing deep link is handled only by the trampoline`() {
        assertTrue(
            activity(".PairingLinkActivity").hasPairingFilter(),
            "PairingLinkActivity must own the astra://pair filter",
        )
        assertFalse(
            activity(".MainActivity").hasPairingFilter(),
            "MainActivity must not receive credential-carrying pairing URLs: " +
                "the system keeps and may persist a root Activity's launching Intent",
        )
    }

    @Test
    fun `the trampoline is never kept, listed, or persisted`() {
        val trampoline = activity(".PairingLinkActivity")
        assertEquals("true", trampoline.getAttributeNS(android, "noHistory"))
        assertEquals("true", trampoline.getAttributeNS(android, "excludeFromRecents"))
        assertEquals("persistNever", trampoline.getAttributeNS(android, "persistableMode"))
        // Its own task affinity, so it can never be the root of the main task.
        assertTrue(trampoline.hasAttributeNS(android, "taskAffinity"))
        assertEquals("", trampoline.getAttributeNS(android, "taskAffinity"))
    }

    @Test
    fun `the main activity is never persisted either`() {
        assertEquals(
            "persistNever",
            activity(".MainActivity").getAttributeNS(android, "persistableMode"),
        )
    }

    @Test
    fun `the manifest was actually found and parsed`() {
        assertNotNull(manifest)
        assertEquals("manifest", manifest.tagName)
    }
}

class ShareReceiveManifestTest {
    private val android = "http://schemas.android.com/apk/res/android"

    private val manifest: Element by lazy {
        val file = locateManifest()
        val document = DocumentBuilderFactory.newInstance()
            .apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(file)
        document.documentElement
    }

    private fun locateManifest(): File {
        var directory: File? = File(".").absoluteFile
        while (directory != null) {
            for (candidate in listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")) {
                val file = File(directory, candidate)
                if (file.isFile) return file
            }
            directory = directory.parentFile
        }
        error("could not find AndroidManifest.xml from ${File(".").absolutePath}")
    }

    private fun activity(name: String): Element {
        val activities = manifest.getElementsByTagName("activity")
        for (index in 0 until activities.length) {
            val element = activities.item(index) as Element
            if (element.getAttributeNS(android, "name") == name) return element
        }
        error("no <activity android:name=\"$name\"> in the manifest")
    }

    private fun Element.hasSendFilter(): Boolean {
        val filters = getElementsByTagName("intent-filter")
        for (index in 0 until filters.length) {
            val filter = filters.item(index) as Element
            val actions = filter.getElementsByTagName("action")
            for (actionIndex in 0 until actions.length) {
                val action = (actions.item(actionIndex) as Element).getAttributeNS(android, "name")
                if (action == "android.intent.action.SEND" || action == "android.intent.action.SEND_MULTIPLE") {
                    return true
                }
            }
        }
        return false
    }

    @Test
    fun `inbound share is handled only by the trampoline`() {
        assertTrue(activity(".ShareReceiveActivity").hasSendFilter())
        assertFalse(
            activity(".MainActivity").hasSendFilter(),
            "MainActivity must not receive ACTION_SEND: the system keeps a root Activity's launching Intent",
        )
    }

    @Test
    fun `the share trampoline is never kept, listed, or persisted`() {
        val trampoline = activity(".ShareReceiveActivity")
        assertEquals("true", trampoline.getAttributeNS(android, "noHistory"))
        assertEquals("true", trampoline.getAttributeNS(android, "excludeFromRecents"))
        assertEquals("persistNever", trampoline.getAttributeNS(android, "persistableMode"))
        assertEquals("", trampoline.getAttributeNS(android, "taskAffinity"))
        assertEquals(
            "orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize|uiMode|density",
            trampoline.getAttributeNS(android, "configChanges"),
        )
    }
}

class PairingLinkTest {
    @Test
    fun `only the pairing scheme and host are an invite`() {
        assertTrue(PairingLink.isInvite("astra", "pair"))
        assertTrue(PairingLink.isInvite("Astra", "PAIR"))
        assertFalse(PairingLink.isInvite("https", "pair"))
        assertFalse(PairingLink.isInvite("astra", "join"))
        assertFalse(PairingLink.isInvite(null, null))
    }
}

/**
 * The trampoline's ordering invariant: this Activity must be finishing before the
 * credential reaches anything that outlives it.
 *
 * Otherwise a process death in that window leaves the system holding a newly
 * launched, *non-finishing* ActivityRecord, which AOSP relaunches with its
 * original credential-bearing Intent — the redelivery the trampoline exists to
 * prevent. `noHistory` and `persistNever` do not close that in-memory race.
 */
class PairingHandoffTest {
    private val url = "astra://pair?address=10.0.0.2:8810&token=omb_pair_secret"

    @Test
    fun `the record is finishing before the credential is delivered`() {
        val order = mutableListOf<String>()
        PairingHandoff.run(
            inviteUrl = url,
            relaunch = { order += "relaunch" },
            markFinishing = { order += "finish" },
            deliver = { order += "deliver" },
        )
        assertEquals(listOf("relaunch", "finish", "deliver"), order)
        assertTrue(
            order.indexOf("finish") < order.indexOf("deliver"),
            "the credential must not leave the Intent before the record is finishing",
        )
    }

    @Test
    fun `the delivered url is the invite itself`() {
        var delivered: String? = null
        PairingHandoff.run(
            inviteUrl = url,
            relaunch = {},
            markFinishing = {},
            deliver = { delivered = it },
        )
        assertEquals(url, delivered)
    }

    @Test
    fun `a non-invite still relaunches and finishes, and delivers nothing`() {
        val order = mutableListOf<String>()
        PairingHandoff.run(
            inviteUrl = null,
            relaunch = { order += "relaunch" },
            markFinishing = { order += "finish" },
            deliver = { order += "deliver" },
        )
        assertEquals(listOf("relaunch", "finish"), order)
    }

    @Test
    fun `the user reaches the real screen before anything else happens`() {
        val order = mutableListOf<String>()
        PairingHandoff.run(
            inviteUrl = url,
            relaunch = { order += "relaunch" },
            markFinishing = { order += "finish" },
            deliver = { order += "deliver" },
        )
        assertEquals("relaunch", order.first())
    }
}
