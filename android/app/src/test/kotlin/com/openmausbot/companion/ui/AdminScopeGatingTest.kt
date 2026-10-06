package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.openmausbot.companion.core.Connection
import kotlin.test.assertNotNull
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Owner-only controls follow `Connection.canAdminister`, as in the iOS views that read
 * `session.canAdminister`: a server session without the `admin` scope is not shown buttons
 * the server would answer 403 to. A companion pairing and an admin server session keep them.
 *
 * Nothing here dials: the scene restores the saved connection and the screens are mounted
 * over it without a stream, which is all these controls read.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalTestApi::class)
class AdminScopeGatingTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>(
        // The roster's spinners and avatars request frames; reduced motion lets the clock idle.
        effectContext = object : MotionDurationScale { override val scaleFactor = 0f },
    )

    private var scene: WiringScene? = null

    @After
    fun tearDown() {
        scene?.session?.disconnect()
    }

    @Test
    fun `a chat-only server session has no Connected Apps row, but keeps routines`() {
        mountSettings(server(scopes = listOf("client")))
        compose.onNodeWithText(ROUTINES).assertExists()
        compose.onNodeWithText(CONNECTED_APPS).assertDoesNotExist()
    }

    @Test
    fun `an admin server session offers Connected Apps`() {
        mountSettings(server(scopes = listOf("admin", "client")))
        compose.onNodeWithText(CONNECTED_APPS).assertExists()
    }

    @Test
    fun `a companion pairing offers Connected Apps`() {
        mountSettings(companion())
        compose.onNodeWithText(CONNECTED_APPS).assertExists()
    }

    @Test
    fun `a chat-only server session cannot create bots or sections from the roster`() {
        mountRoster(server(scopes = listOf("client")))
        compose.onNodeWithContentDescription(SEARCH).assertIsDisplayed()
        compose.onNodeWithContentDescription(NEW_BOT).assertDoesNotExist()
        compose.onNodeWithContentDescription(NEW_SECTION).assertDoesNotExist()
    }

    @Test
    fun `a companion pairing keeps the roster's create buttons`() {
        mountRoster(companion())
        compose.onNodeWithContentDescription(NEW_BOT).assertIsDisplayed()
        compose.onNodeWithContentDescription(NEW_SECTION).assertIsDisplayed()
    }

    private fun server(scopes: List<String>): Connection =
        assertNotNull(Connection.parse("https://mini.example"))
            .copy(id = "server", serverEnvironmentId = "env-fixture", serverScopes = scopes)

    private fun companion(): Connection = Connection(id = "companion", name = "Mac", host = "127.0.0.1", port = 8810)

    private fun mountSettings(connection: Connection) {
        val mounted = restored(connection)
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides mounted.environment) {
                CompanionTheme(darkTheme = false) {
                    SettingsScreen(onBack = {}, onOpenRoutines = {}, onOpenConnectedApps = {})
                }
            }
        }
        compose.waitForIdle()
    }

    private fun mountRoster(connection: Connection) {
        val mounted = restored(connection)
        compose.setContent {
            CompositionLocalProvider(LocalCompanion provides mounted.environment) {
                CompanionTheme(darkTheme = false) {
                    RosterScreen(CompanionNavigator())
                }
            }
        }
        compose.waitForIdle()
    }

    private fun restored(connection: Connection): WiringScene {
        val mounted = WiringScene(connection = connection)
        scene = mounted
        compose.waitUntil(5_000) { mounted.session.connection.value?.id == connection.id }
        return mounted
    }

    private companion object {
        const val ROUTINES = "Threads & Routines"
        const val CONNECTED_APPS = "Connected Apps"
        const val SEARCH = "Search"
        const val NEW_BOT = "New bot"
        const val NEW_SECTION = "Organize bots into a section"
    }
}
