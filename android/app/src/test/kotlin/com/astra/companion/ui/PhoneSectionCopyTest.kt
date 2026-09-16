package com.astra.companion.ui

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
 * spirit of [com.astra.companion.PairingLinkManifestTest] and
 * [com.astra.companion.lifecycle.SessionLingerWiringTest], is what is
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

        // Step one of setup. Upstream: `ios/App/OnboardingViews.swift:137`.
        assertTrue(
            source.contains("1.  Open Astra → Settings → Phone"),
            "the setup steps must name the Phone section",
        )
        // A discovered computer that answered without an address.
        assertTrue(
            source.contains("Enter the address shown in Phone settings instead."),
            "the discovery fallback must name Phone settings",
        )
        // The tailnet hint, and the manual-address footnote.
        assertTrue(
            source.contains("same account — Phone settings will then show a name ending in "),
            "the Tailscale hint must name Phone settings",
        )
        assertTrue(
            source.contains("Whatever Phone settings on your computer shows — "),
            "the manual-address footnote must name Phone settings",
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
