package com.astra.companion.storage

import com.astra.companion.core.Connection
import com.astra.companion.core.ConnectionStore
import com.astra.companion.core.TokenStore
import com.astra.companion.ui.PermissionPreferences
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * Pairing persistence contract with fake stores (DataStore/Keystore glued in :app;
 * Session behavior covered in :core SessionTest).
 */
class PersistenceContractTest {
    @Test
    fun connectionRoundTripsWithoutToken() = runTest {
        val store: ConnectionStore = InMemoryConnectionStore()
        val connection = Connection(id = "c1", name = "Mac", host = "192.168.1.2", port = 8810)
        store.save(connection)
        assertEquals(connection, store.load())
        store.clear()
        assertNull(store.load())
    }

    @Test
    fun tokenUnavailableMapsToLockedReadResult() = runTest {
        val tokens = object : TokenStore {
            override suspend fun save(connectionId: String, token: String) = Unit
            override suspend fun read(connectionId: String) =
                TokenStore.ReadResult.Unavailable(locked = true, message = "Unlock this phone")
            override suspend fun remove(connectionId: String) = Unit
        }
        val result = tokens.read("c1")
        val unavailable = assertIs<TokenStore.ReadResult.Unavailable>(result)
        assertTrue(unavailable.locked)
    }

    @Test
    fun backupAndTransferXmlExcludeTokenPrefsFile() {
        val tokenFile = "${KeystoreTokenStore.PREFS_NAME}.xml"
        val backup = readXml("backup_rules.xml")
        val extraction = readXml("data_extraction_rules.xml")

        assertTrue(
            backup.contains("""path="$tokenFile""""),
            "backup_rules.xml must exclude $tokenFile; was:\n$backup",
        )
        assertTrue(
            backup.contains("full-backup-content") || backup.contains("<exclude"),
            "backup_rules.xml should declare Auto Backup excludes",
        )
        assertTrue(
            extraction.contains("""path="$tokenFile""""),
            "data_extraction_rules.xml must exclude $tokenFile; was:\n$extraction",
        )
        assertTrue(
            extraction.contains("<cloud-backup>") && extraction.contains("<device-transfer>"),
            "data_extraction_rules.xml must cover cloud-backup and device-transfer; was:\n$extraction",
        )
        // Both cloud-backup and device-transfer blocks must name the token file.
        val cloud = extraction.substringAfter("<cloud-backup>").substringBefore("</cloud-backup>")
        val transfer = extraction.substringAfter("<device-transfer>").substringBefore("</device-transfer>")
        assertTrue(cloud.contains("""path="$tokenFile""""), "cloud-backup missing $tokenFile")
        assertTrue(transfer.contains("""path="$tokenFile""""), "device-transfer missing $tokenFile")
    }

    /**
     * The permission-prompt bookkeeping is not a secret, but it is device-local
     * truth: it records that *this* install has spent its notification prompt.
     * Restoring it onto a fresh install — where the OS has reset the permission
     * and would ask again — would show "Open notification settings" for a prompt
     * that was never used here, contradicting the uninstall-resets premise the
     * design leans on.
     */
    @Test
    fun backupAndTransferXmlExcludePermissionPrefsFile() {
        val prefsFile = PermissionPreferences.FILE
        val needle = "path=\"$prefsFile\""
        val backup = readXml("backup_rules.xml")
        val extraction = readXml("data_extraction_rules.xml")

        assertTrue(
            backup.contains(needle),
            "backup_rules.xml must exclude $prefsFile; was:\n$backup",
        )
        val cloud = extraction.substringAfter("<cloud-backup>").substringBefore("</cloud-backup>")
        val transfer = extraction.substringAfter("<device-transfer>").substringBefore("</device-transfer>")
        assertTrue(cloud.contains(needle), "cloud-backup missing $prefsFile")
        assertTrue(transfer.contains(needle), "device-transfer missing $prefsFile")
    }

    @Test
    fun permissionPrefsFileNameMatchesWhatTheAppOpens() {
        // The rules above are only worth anything if they name the real file.
        assertEquals("astra.permissions", PermissionPreferences.NAME)
        assertEquals(PermissionPreferences.NAME + ".xml", PermissionPreferences.FILE)
    }

    private fun readXml(name: String): String {
        val candidates = listOf(
            File("src/main/res/xml", name),
            File("android/app/src/main/res/xml", name),
        )
        val file = candidates.firstOrNull { it.isFile }
            ?: error("Could not find res/xml/$name (cwd=${File(".").absolutePath})")
        return file.readText()
    }
}

private class InMemoryConnectionStore : ConnectionStore {
    private var value: Connection? = null
    override suspend fun load(): Connection? = value
    override suspend fun save(connection: Connection) {
        value = connection
    }
    override suspend fun clear() {
        value = null
    }
}
