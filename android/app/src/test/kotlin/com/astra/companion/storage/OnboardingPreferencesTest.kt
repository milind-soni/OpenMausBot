package com.astra.companion.storage

import android.content.Context
import com.astra.companion.core.OnboardingPreferenceKeys
import java.io.File
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The durable half of the first-run flow — the port of
 * `testPendingNotificationPreferenceSurvivesAProcessRelaunch` in
 * `ios/Tests/CompanionCoreTests/OnboardingTests.swift:118-132`, plus the §6
 * containment this store has to keep.
 *
 * Durability is the whole point of the marker, and no in-memory fake can show
 * it, so these run against a real `SharedPreferences` file and read it back
 * through a *second* instance — the shape a relaunch has.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OnboardingPreferencesTest {

    private val context: Context = RuntimeEnvironment.getApplication()

    private fun store(name: String) = OnboardingPreferences(
        prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE),
        io = EmptyCoroutineContext,
    )

    @Test
    fun `the pending marker survives a process relaunch`() = runTest {
        val file = "relaunch-marker"
        store(file).setNotificationOnboardingPending(true)

        val relaunched = store(file)

        assertTrue(
            relaunched.notificationOnboardingPending(),
            "a marker that dies with the process cannot protect a relaunch",
        )
        assertTrue(relaunched.notificationPending.value)
    }

    @Test
    fun `the other two markers survive a relaunch as well`() = runTest {
        val file = "relaunch-flags"
        store(file).setWelcomeSeen(true)
        store(file).setNotificationPromptSeen(true)

        val relaunched = store(file)

        assertTrue(relaunched.welcomeSeen.value)
        assertTrue(relaunched.notificationPromptSeen.value)
        assertFalse(relaunched.notificationPending.value)
    }

    @Test
    fun `clearing the marker is durable too`() = runTest {
        val file = "relaunch-cleared"
        store(file).setNotificationOnboardingPending(true)
        store(file).setNotificationOnboardingPending(false)

        assertFalse(
            store(file).notificationOnboardingPending(),
            "an unpair that only clears the marker in memory hands it back on relaunch",
        )
    }

    /**
     * §6: the marker is not a secret, and it must not become a place where one
     * rides along. Every writer this class has is exercised, and then the file
     * is read raw: three keys, all booleans, and nothing anybody added later.
     */
    @Test
    fun `the store holds the three named booleans and nothing else`() = runTest {
        val file = "containment"
        val store = store(file)
        store.setWelcomeSeen(true)
        store.setNotificationPromptSeen(true)
        store.setNotificationOnboardingPending(true)

        val raw = context.getSharedPreferences(file, Context.MODE_PRIVATE).all

        assertEquals(
            OnboardingPreferenceKeys.ALL,
            raw.keys,
            "the onboarding store grew a key nobody named",
        )
        assertTrue(
            raw.values.all { it is Boolean },
            "the onboarding store is holding something that is not a boolean: $raw",
        )
    }

    /**
     * A device-local record of what this install has already shown. Restored
     * onto a fresh device it would skip a welcome and a notification
     * explanation nobody there has seen — the same reason the permission
     * bookkeeping is excluded, one file over.
     */
    @Test
    fun `backup and transfer rules exclude the onboarding file`() {
        val needle = "path=\"${OnboardingPreferences.FILE}\""
        val backup = readXml("backup_rules.xml")
        val extraction = readXml("data_extraction_rules.xml")

        assertTrue(backup.contains(needle), "backup_rules.xml must exclude ${OnboardingPreferences.FILE}")
        val cloud = extraction.substringAfter("<cloud-backup>").substringBefore("</cloud-backup>")
        val transfer = extraction.substringAfter("<device-transfer>").substringBefore("</device-transfer>")
        assertTrue(cloud.contains(needle), "cloud-backup must exclude ${OnboardingPreferences.FILE}")
        assertTrue(transfer.contains(needle), "device-transfer must exclude ${OnboardingPreferences.FILE}")
    }

    /**
     * A source pin, and it says only what a source pin can say: that the word
     * `commit()` is written in the file. It is here because the difference this
     * guards cannot be observed from a test at all — Robolectric runs `apply()`
     * synchronously, so both spellings pass every assertion above.
     *
     * What is at stake is real: `Session.pair` writes this marker *before* it
     * saves the connection precisely so that a process which stops between them
     * leaves an orphan marker rather than a restorable pairing with none.
     * `apply()` hands the disk write to a background thread and returns, which
     * silently gives that ordering back.
     */
    @Test
    fun `the marker is written synchronously`() {
        val source = sourceFile("storage/OnboardingPreferences.kt").readText()
        assertTrue(
            source.contains(".commit()"),
            "the onboarding markers must be committed, not applied",
        )
        assertFalse(
            source.contains(".apply()"),
            "an apply() here returns before the value is durable",
        )
    }

    private fun readXml(name: String): String = locate("src/main/res/xml/$name").readText()

    private fun sourceFile(name: String): File =
        locate("src/main/kotlin/com/astra/companion/$name")

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
