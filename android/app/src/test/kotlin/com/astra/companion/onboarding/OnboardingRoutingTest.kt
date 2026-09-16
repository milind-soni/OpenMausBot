package com.astra.companion.onboarding

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.astra.companion.core.NotificationAuthorizationState
import com.astra.companion.core.OnboardingPairingState
import com.astra.companion.core.Session
import com.astra.companion.ui.CompanionRoot
import com.astra.companion.ui.LocalCompanion
import com.astra.companion.ui.NotificationAccess
import com.astra.companion.ui.notificationAuthorization
import com.astra.companion.ui.onboardingPairingState
import com.astra.companion.ui.OnboardingCopy
import com.astra.companion.ui.PermissionPreferences
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the first run actually does, read off the mounted composition.
 *
 * The router itself is proven in `:core` by `OnboardingTest`, on pure inputs.
 * That proves the rule and nothing about whether this app obeys it: a screen
 * that ignored the marker, or fired a permission request from its first frame,
 * would leave every one of those assertions green. So these mount the real
 * `CompanionRoot` against [OnboardingScene] and ask the two questions no value
 * on any object answers —
 *
 * 1. **which screen is on the glass**, for each shape the state can take, and
 * 2. **what the app asked the system for while getting there**, in order.
 *
 * (2) is the whole reason this pass exists. The scene's `requestPermissions` and
 * the notification controller's `request` are the only ways a prompt can reach
 * the OS from this composition, and both are recorded, so "asked nothing" is a
 * measurement rather than an assumption.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OnboardingRoutingTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun mount(scene: OnboardingScene) {
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides scene.environment) {
                CompanionRoot(pendingNotification = null, onPendingTargetConsumed = {})
            }
        }
        compose.waitUntil(5_000) {
            scene.session.restoreState.value !is Session.RestoreState.Pending
        }
        compose.waitForIdle()
    }

    @Test
    fun `a first launch says what the app is before it asks the system for anything`() {
        val scene = OnboardingScene()
        mount(scene)

        compose.onNodeWithText(OnboardingCopy.WELCOME_TITLE).assertIsDisplayed()
        assertEquals(
            emptyList(),
            scene.asked(),
            "the first frame of a first launch put a system dialog on screen",
        )
        assertEquals(0, scene.discovery.starts.value, "and it started a network search")
    }

    @Test
    fun `Not now leads to a home that can still connect and still reach Settings`() {
        val scene = OnboardingScene()
        mount(scene)

        compose.onNodeWithText(OnboardingCopy.NOT_NOW).performClick()
        compose.waitForIdle()

        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_TITLE).assertIsDisplayed()
        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_CONNECT).assertIsDisplayed()

        // The later way back to notifications, without re-entering a connection
        // flow this person has just declined.
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Connect a computer").assertIsDisplayed()
        compose.onNodeWithText("Enable notifications").assertIsDisplayed()
        // And nothing that needs a pairing to mean anything.
        compose.onNodeWithText("Unpair this phone").assertDoesNotExist()
        compose.onNodeWithText("Tasks & Routines").assertDoesNotExist()

        assertEquals(emptyList(), scene.asked(), "declining setup still spent a prompt")

        // And back closes Settings rather than the app.
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_TITLE).assertIsDisplayed()
    }

    @Test
    fun `the unpaired home leads back into pairing`() {
        val scene = OnboardingScene(welcomeSeen = true)
        mount(scene)

        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_TITLE).assertIsDisplayed()
        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_CONNECT).performClick()
        compose.waitForIdle()

        compose.onNodeWithText("Pair with a computer").assertIsDisplayed()
        assertEquals(emptyList(), scene.asked(), "reaching the QR screen asked for something")
    }

    @Test
    fun `a deep link opens pairing even on a first launch nobody has answered`() {
        val scene = OnboardingScene()
        mount(scene)
        compose.onNodeWithText(OnboardingCopy.WELCOME_TITLE).assertIsDisplayed()

        scene.session.receivePairingURL(
            "astra://pair?address=127.0.0.1:8810&code=123456",
        )
        compose.waitForIdle()

        compose.onNodeWithText("Pair with a computer").assertIsDisplayed()
    }

    @Test
    fun `a pairing that already existed is never given first-pair education`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            // The marker is false because this pairing was committed before the
            // education step existed — an upgrade, not a first pairing.
            notificationOnboardingPending = false,
        )
        mount(scene)

        compose.onNodeWithText("No bots yet").assertIsDisplayed()
        assertEquals(
            emptyList(),
            scene.asked(),
            "an upgrade asked an already-paired phone for a permission it never offered to explain",
        )
    }

    @Test
    fun `a first pairing explains notifications before the system dialog, and asks once`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            notificationOnboardingPending = true,
        )
        mount(scene)

        // Explained first, and nothing asked yet.
        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_TITLE).assertIsDisplayed()
        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_BODY).assertIsDisplayed()
        assertEquals(
            emptyList(),
            scene.asked(),
            "the system dialog beat the explanation to the screen",
        )

        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_ENABLE).performClick()
        compose.waitForIdle()

        assertEquals(
            listOf(PermissionPreferences.POST_NOTIFICATIONS),
            scene.asked(),
            "the explained step must ask for notifications and nothing else",
        )
        // And the step is over: it does not come back for the same pairing, in
        // this process or the next one.
        compose.onNodeWithText("No bots yet").assertIsDisplayed()
        assertFalse(
            scene.relaunchedOnboarding().notificationPending.value,
            "the prompt was fired but the marker is still pending",
        )
    }

    @Test
    fun `Not now on the education step ends it without a prompt`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            notificationOnboardingPending = true,
        )
        mount(scene)
        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_TITLE).assertIsDisplayed()

        compose.onNodeWithText(OnboardingCopy.NOT_NOW).performClick()
        compose.waitForIdle()

        compose.onNodeWithText("No bots yet").assertIsDisplayed()
        assertEquals(emptyList(), scene.asked(), "\"Not now\" fired the prompt anyway")
        // And the answer reached disk: a relaunch finds no step still owing.
        // Read through a store that never saw this process, because a marker
        // cleared only in memory is a marker that comes back.
        assertFalse(
            scene.relaunchedOnboarding().notificationPending.value,
            "the education step was answered but the marker is still pending",
        )
    }

    @Test
    fun `a phone whose notifications are already decided skips the step`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            notificationOnboardingPending = true,
            notificationsEnabled = true,
        )
        mount(scene)

        compose.onNodeWithText("No bots yet").assertIsDisplayed()
        assertEquals(emptyList(), scene.asked())
    }

    /**
     * The upgrade case, which has no welcome in its history at all.
     *
     * A phone that was already paired before any of this existed reads a marker
     * file with nothing in it, so "has seen the welcome" is false while the
     * person has been using the app for weeks. Landing them on a first-run
     * welcome the day they unpair would be absurd; being paired is what answers
     * that question for them.
     */
    @Test
    fun `an upgrade that unpairs lands on the home, not on a welcome it never needed`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = false,
        )
        mount(scene)
        compose.onNodeWithText("No bots yet").assertIsDisplayed()

        scene.session.signOut()
        compose.waitUntil(5_000) { scene.session.connection.value == null }
        compose.waitForIdle()

        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_TITLE).assertIsDisplayed()
        compose.onNodeWithText(OnboardingCopy.WELCOME_TITLE).assertDoesNotExist()
    }

    /**
     * One person, from the first frame to a voluntary unpair, with a real
     * `Session` committing a real pairing in the middle of it.
     *
     * Every other case here arranges the durable marker by hand. This one never
     * touches it: `Session.pair` writes it as part of committing the pairing,
     * the store publishes it, and the router acts on it — so this is the only
     * test that fails if any link of that chain is cut rather than any one of
     * them being wrong.
     *
     * It also pins the last thing on iOS's list that a state machine gets wrong
     * quietly: unpairing later must not walk back into the pairing form,
     * because "I asked to connect" was answered a long time ago.
     */
    @Test
    fun `a whole first run, from the welcome to a later unpair`() {
        val scene = OnboardingScene()
        mount(scene)
        compose.onNodeWithText(OnboardingCopy.WELCOME_TITLE).assertIsDisplayed()

        scene.session.receivePairingURL(
            "astra://pair?address=127.0.0.1:8810&code=123456",
        )
        compose.waitUntil(5_000) { scene.session.pairingInvite.value != null }
        compose.waitForIdle()
        compose.onNodeWithText("Pair with this computer").performClick()
        compose.waitUntil(5_000) { scene.session.connection.value != null }
        compose.waitForIdle()

        // Nobody set the marker here: the pairing commit did.
        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_TITLE).assertIsDisplayed()
        assertEquals(
            emptyList(),
            scene.asked(),
            "a permission dialog reached the screen before the explanation did",
        )

        compose.onNodeWithText(OnboardingCopy.NOT_NOW).performClick()
        compose.waitForIdle()
        compose.onNodeWithText("No bots yet").assertIsDisplayed()

        scene.session.signOut()
        compose.waitUntil(5_000) { scene.session.connection.value == null }
        compose.waitForIdle()

        compose.onNodeWithText(OnboardingCopy.UNPAIRED_HOME_TITLE).assertIsDisplayed()
        compose.onNodeWithText("Pair with a computer").assertDoesNotExist()
        assertFalse(
            scene.relaunchedOnboarding().notificationPending.value,
            "the unpaired phone still owes an education step for a pairing it no longer has",
        )
    }

    /**
     * The two translations between what `Session` publishes and what the router
     * asks about. They are pure, so this proves the mapping and not that the
     * composition uses it — the cases above do that, by mounting it. What these
     * add is the pair of states a mounted test cannot easily arrange: a token
     * revoked while the connection record is still on disk, which is the normal
     * shape of a revocation, and a notification permission that is blocked
     * rather than merely ungranted.
     */
    @Test
    fun `a revoked token outranks the connection record still sitting on disk`() {
        assertEquals(
            OnboardingPairingState.REVOKED,
            onboardingPairingState(Session.Status.Unauthorized, OnboardingScene.MAC),
        )
        assertEquals(
            OnboardingPairingState.PAIRED,
            onboardingPairingState(Session.Status.Offline("nope"), OnboardingScene.MAC),
        )
        assertEquals(
            OnboardingPairingState.UNPAIRED,
            onboardingPairingState(Session.Status.Unpaired, null),
        )
        // A connection is what makes a phone paired, not a live stream: an
        // offline restore still belongs in chats, not on the welcome screen.
        assertEquals(
            OnboardingPairingState.UNPAIRED,
            onboardingPairingState(Session.Status.Connecting, null),
        )
    }

    @Test
    fun `a blocked notification permission counts as decided`() {
        assertEquals(
            NotificationAuthorizationState.NOT_DETERMINED,
            notificationAuthorization(NotificationAccess.ASKABLE),
        )
        assertEquals(
            NotificationAuthorizationState.DETERMINED,
            notificationAuthorization(NotificationAccess.GRANTED),
        )
        // Nothing left to ask for: pre-33, or a prompt already spent. An
        // explanation here would end in a button the system silently drops.
        assertEquals(
            NotificationAuthorizationState.DETERMINED,
            notificationAuthorization(NotificationAccess.BLOCKED),
        )
    }

    /**
     * Below API 33 there is no notification permission to grant, and
     * `NotificationPermissionController` reports BLOCKED because only the system
     * settings page can change anything. Showing the education step there would
     * end in an "Enable notifications" button that cannot enable anything.
     */
    @Test
    fun `a phone with nothing left to ask is not shown the step`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            notificationOnboardingPending = true,
            canRequestNotifications = false,
        )
        mount(scene)

        compose.onNodeWithText("No bots yet").assertIsDisplayed()
        compose.onNodeWithText(OnboardingCopy.NOTIFICATIONS_TITLE).assertDoesNotExist()
        assertEquals(emptyList(), scene.asked())
    }

    /**
     * The honest scope of this one, measured rather than assumed: on Android a
     * revoked phone can receive an invitation for another computer. The invite
     * is retained safely by `Session`, but revocation still owns the visible
     * route until the person chooses recovery or another saved computer.
     *
     * So this shows that a deep link arriving at a revoked phone leaves the
     * recovery screen standing, which is the real Android case. The precedence
     * rule itself — revocation outranking a requested pairing *and* a pending
     * invite at once — is a state this composition cannot reach, and it is
     * killed in `:core` by `OnboardingTest.revokedPairingAlwaysShowsRecovery`.
     * A mutation that hoists the pairing check above the state switch survives
     * the whole `:app` suite; it does not survive `:core`.
     */
    @Test
    fun `a deep link arriving at a revoked phone leaves recovery standing`() {
        val scene = OnboardingScene(
            savedConnection = OnboardingScene.MAC,
            savedToken = "device-token",
            welcomeSeen = true,
            notificationOnboardingPending = true,
            revoked = true,
        )
        mount(scene)
        scene.session.connect()
        compose.waitUntil(5_000) {
            scene.session.status.value is Session.Status.Unauthorized
        }
        compose.waitForIdle()

        // The other reason this phone could be routed somewhere else is already
        // true: an education step is pending and its permission is askable.
        compose.onNodeWithText("This phone was unpaired").assertIsDisplayed()

        scene.session.receivePairingURL(
            "astra://pair?address=127.0.0.1:8810&code=123456",
        )
        compose.waitForIdle()

        assertNotNull(scene.session.pairingInvite.value)
        compose.onNodeWithText("This phone was unpaired").assertIsDisplayed()
        assertTrue(scene.asked().isEmpty())
    }
}
