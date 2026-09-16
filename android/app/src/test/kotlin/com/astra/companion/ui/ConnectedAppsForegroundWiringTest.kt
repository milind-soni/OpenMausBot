package com.astra.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.astra.companion.core.Connection
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.assertEquals
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Coming back from the browser has to re-read the inventory, and entering the
 * screen must not read it twice.
 *
 * Authorization finishes somewhere else — the system browser — so the answer
 * arrives while this screen is in the background. iOS refreshes on
 * `scenePhase == .active` (`ios/App/ConnectedAppsView.swift:90-92`); the Android
 * shape of that is a resume of the screen's own lifecycle owner.
 *
 * What proves it is the request, not a counter the screen keeps: the scene dials
 * a real socket, and this counts what arrived at `/api/connectors/connected`. A
 * screen that lost its resume effect, or one that fired it on entry as well,
 * changes that number.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConnectedAppsForegroundWiringTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var server: MockWebServer
    private val hits = ConcurrentHashMap<String, AtomicInteger>()

    private val catalog = """{"configured":true,"cards":[{"slug":"gmail","label":"Gmail","blurb":"Mail"}]}"""
    private val connected = """{"configured":true,"credentialStore":"ok","services":{}}"""

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                hits.getOrPut(path) { AtomicInteger(0) }.incrementAndGet()
                val body = when (path) {
                    "/api/connectors/catalog" -> catalog
                    "/api/connectors/connected" -> connected
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "application/json")
                    .setBody(body)
            }
        }
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `a return to the foreground re-reads the inventory, and entering it does not read twice`() {
        val scene = WiringScene(connection = requireNotNull(Connection.parse(server.url("/").toString())))
        val owner = ResumableOwner()

        compose.setContent {
            CompositionLocalProvider(
                LocalCompanion provides scene.environment,
                LocalLifecycleOwner provides owner,
            ) {
                CompanionTheme(darkTheme = false) {
                    ConnectedAppsScreen(onBack = {})
                }
            }
        }

        compose.waitUntil(5_000) { asked("/api/connectors/connected") == 1 }
        compose.waitForIdle()
        assertEquals(
            1,
            asked("/api/connectors/connected"),
            "the resume that comes with entering the screen asked a second time",
        )
        assertEquals(1, asked("/api/connectors/catalog"))

        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)

        compose.waitUntil(5_000) { asked("/api/connectors/connected") == 2 }
        assertEquals(
            1,
            asked("/api/connectors/catalog"),
            "the return re-reads accounts only; the catalog is not what changed",
        )
    }

    private fun asked(path: String): Int = hits[path]?.get() ?: 0

    /** A lifecycle a test can drive, standing in for the screen's own. */
    private class ResumableOwner : LifecycleOwner {
        val registry = LifecycleRegistry(this).apply {
            currentState = Lifecycle.State.RESUMED
        }
        override val lifecycle: Lifecycle get() = registry
    }
}
