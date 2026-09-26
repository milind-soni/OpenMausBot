package com.openmausbot.companion.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The desktop app's companion area is called **Phone**. Every instruction that
 * sends a person there has to use that name, or the first step of setup points
 * at a screen that does not exist: `ios/App/PairingView.swift:132,227`,
 * `OnboardingViews.swift:137`, `SettingsView.swift:289,302`,
 * `ComputerView.swift:89` and `Discovery.swift:137` all say Phone.
 *
 * The copy pinned here lives inside `@Composable` bodies and a private
 * `failureMessage`, so no JVM unit test can call it — a source pin, in the
 * spirit of [com.openmausbot.companion.PairingLinkManifestTest] and
 * [com.openmausbot.companion.lifecycle.SessionLingerWiringTest], is what is
 * available. It is a text assertion, not a runtime proof: it says the sentence
 * is written in the file, not that the screen renders it. The constants that
 * *are* reachable are pinned where they live —
 * [SettingsPolicyTest], [ComputerPolicyTest] and, in `:core`,
 * `FailoverTest.refusedConnectionPointsAtThePhoneSection`.
 */
class PhoneSectionCopyTest {

    /** Names of the desktop area as it was called before the rename. */
    private val retiredSectionNames = listOf(
        "Settings → Companion",
        "Companion panel",
        "shown by Companion",
        "companion settings",
        "Companion settings",
    )

    @Test
    fun `pairing sends the person to Settings then Phone`() {
        val source = sourceFile("ui/PairingScreen.kt").readText()
        val english = locate("src/main/res/values/strings.xml").readText()

        // The copy lives in resources so Android can select Simplified or
        // Traditional Chinese. Keep the pairing screen wired to those entries
        // and keep the canonical English text explicit in the default catalog.
        assertTrue(
            source.contains("R.string.mobile_open_openmausbot_settings_phone_38cfc5bb") &&
                english.contains("1.  Open OpenMausBot → Settings → Phone"),
            "the setup steps must use the localized Settings → Phone copy",
        )
        assertTrue(
            source.contains("R.string.mobile_pairing_no_address") &&
                english.contains("Enter the address shown in Phone settings instead."),
            "the discovery fallback must use the localized Phone settings copy",
        )
        assertTrue(
            source.contains("R.string.mobile_pair_tailscale_hint") &&
                english.contains("Phone settings will then show a name ending in "),
            "the Tailscale hint must use the localized Phone settings copy",
        )
        assertTrue(
            source.contains("R.string.mobile_pair_manual_address_hint") &&
                english.contains("Phone settings on your computer shows — "),
            "the manual-address footnote must use the localized Phone settings copy",
        )
    }

    @Test
    fun `every discovery failure points at Phone settings`() {
        val source = sourceFile("discovery/NsdDiscovery.kt").readText()

        // Four exits — permission refused, an unexpected throw, an internal NSD
        // failure and the spent-retries one — and a person who cannot browse has
        // nowhere else to read the address from.
        assertEquals(
            4,
            countOf(source, "Enter the address shown in Phone settings below."),
            "every discovery failure must send the person to Phone settings",
        )
    }

    @Test
    fun `a revoked phone is told which desktop section removed it`() {
        val source = sourceFile("ui/RootScreen.kt").readText()

        assertTrue(
            source.contains(
                "It was removed from the computer's Phone settings, or the pairing was reset.",
            ),
            "the unpaired screen must name Phone settings",
        )
    }

    @Test
    fun `no instruction still teaches the retired section name`() {
        for (name in listOf(
            "ui/PairingScreen.kt",
            "discovery/NsdDiscovery.kt",
            "ui/RootScreen.kt",
            "ui/SettingsPolicy.kt",
            "ui/SettingsScreen.kt",
            "ui/ComputerPolicy.kt",
        )) {
            val source = sourceFile(name).readText()
            for (retired in retiredSectionNames) {
                assertFalse(
                    source.contains(retired),
                    "$name still names \"$retired\" — the desktop section is called Phone",
                )
            }
        }
    }

    private fun countOf(source: String, needle: String): Int =
        source.split(needle).size - 1

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
