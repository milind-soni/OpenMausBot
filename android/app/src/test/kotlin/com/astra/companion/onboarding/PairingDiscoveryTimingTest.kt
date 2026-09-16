package com.astra.companion.onboarding

import android.Manifest
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.astra.companion.permissions.CompanionPermissions
import com.astra.companion.ui.CompanionTheme
import com.astra.companion.ui.LocalCompanion
import com.astra.companion.ui.PairingScreen
import com.astra.companion.ui.PermissionPreferences
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.CompletableDeferred
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * When the pairing screen touches the network, and when it asks to be allowed to.
 *
 * Both are invisible from anything the screen exposes. A browse is a *collection
 * of a cold Flow*, so the only honest way to ask "did entering this screen start
 * a search?" is to hand it a Flow that counts collections and mount the real
 * composable — which is what [OnboardingScene.FakeDiscovery] is for. Asserting
 * that some `showingOtherWays` boolean is false would prove the boolean, not the
 * browse: the previous version of this screen had no such boolean and browsed
 * from the moment it existed.
 *
 * The permission has the same shape. `environment.requestPermissions` is the
 * only route from this screen to a system dialog, and the scene records every
 * call in order, so "the QR path asks for nothing" is measured.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingDiscoveryTimingTest {

    @get:Rule
    val compose = createComposeRule()

    private val otherWays = "Other ways to connect"
    private val discoveryHeader = "On this network".uppercase()

    /** API 37 in the permission model, so the local-network grant is in scope. */
    private fun scene(
        pairSuspendsUntil: CompletableDeferred<Unit>? = null,
    ) = OnboardingScene(sdkInt = 37, pairSuspendsUntil = pairSuspendsUntil)

    private fun mount(scene: OnboardingScene, onCancel: () -> Unit = {}) {
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionTheme(darkTheme = false) {
                    PairingScreen(onCancel = onCancel)
                }
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `entering the pairing screen starts no search and asks for nothing`() {
        val scene = scene()
        mount(scene)

        compose.onNodeWithText("Scan QR Code").assertIsDisplayed()
        compose.onNodeWithText(otherWays).assertIsDisplayed()

        assertEquals(
            0,
            scene.discovery.starts.value,
            "someone who only means to scan the QR code paid for a local search",
        )
        assertEquals(
            emptyList(),
            scene.asked(),
            "the QR path must cost no permission at all",
        )
    }

    @Test
    fun `opening other ways is what starts the search and asks for what it needs`() {
        val scene = scene()
        mount(scene)

        compose.onNodeWithText(otherWays).performClick()
        compose.waitForIdle()

        compose.onNodeWithText(discoveryHeader).assertIsDisplayed()
        assertEquals(1, scene.discovery.starts.value)
        assertEquals(1, scene.discovery.active.value)
        assertEquals(
            listOf(
                Manifest.permission.NEARBY_WIFI_DEVICES,
                CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK,
            ),
            scene.asked(),
            "the browse must ask for what a browse needs, and only that",
        )
        assertFalse(
            scene.asked().contains(PermissionPreferences.POST_NOTIFICATIONS),
            "opening the list of nearby computers must never ask about notifications",
        )
    }

    @Test
    fun `closing it stops the search`() {
        val scene = scene()
        mount(scene)

        compose.onNodeWithText(otherWays).performClick()
        compose.waitForIdle()
        assertEquals(1, scene.discovery.active.value)

        compose.onNodeWithText(otherWays).performClick()
        compose.waitForIdle()

        compose.onNodeWithText(discoveryHeader).assertDoesNotExist()
        assertEquals(
            0,
            scene.discovery.active.value,
            "a closed panel left a multicast browse running behind it",
        )
    }

    @Test
    fun `a granted phone opens the list without a dialog`() {
        val scene = OnboardingScene(
            sdkInt = 37,
            granted = mutableSetOf(
                Manifest.permission.NEARBY_WIFI_DEVICES,
                CompanionPermissions.PERMISSION_ACCESS_LOCAL_NETWORK,
            ),
        )
        mount(scene)

        compose.onNodeWithText(otherWays).performClick()
        compose.waitForIdle()

        assertEquals(1, scene.discovery.starts.value)
        assertEquals(emptyList(), scene.asked(), "asked again for something already granted")
    }

    @Test
    fun `Not now leaves the pairing screen`() {
        val scene = scene()
        var cancelled = 0
        mount(scene) { cancelled += 1 }

        compose.onNodeWithText("Not now").performClick()
        compose.waitForIdle()

        assertEquals(1, cancelled)
    }

    /**
     * The port of `.disabled(!submission.allowsNavigation)` on iOS's cancel
     * button. A one-time credential that may already have reached the computer
     * must not be walked away from halfway (§6): the screen has to stay until
     * the attempt settles, whichever way it settles.
     */
    @Test
    fun `Not now is refused while a redemption is in flight`() {
        val gate = CompletableDeferred<Unit>()
        val scene = scene(pairSuspendsUntil = gate)
        var cancelled = 0
        mount(scene) { cancelled += 1 }

        scene.session.receivePairingURL(
            "astra://pair?address=127.0.0.1:8810&code=123456",
        )
        compose.waitUntil(5_000) { scene.session.pairingInvite.value != null }
        compose.waitForIdle()
        // The link carried the credential, so the step is a confirmation of the
        // computer rather than a code to type.
        compose.onNodeWithText("Not now").assertIsEnabled()

        compose.onNodeWithText("Pair with this computer").performClick()
        compose.waitForIdle()

        compose.onNodeWithText("Not now").assertIsNotEnabled()
        assertEquals(0, cancelled)

        gate.complete(Unit)
        compose.waitForIdle()
    }
}
