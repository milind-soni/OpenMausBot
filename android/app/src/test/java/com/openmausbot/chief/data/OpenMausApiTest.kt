package com.openmausbot.chief.data

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException

class OpenMausApiTest {
    private lateinit var server: MockWebServer

    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }

    @Test
    fun sendDoesNotInterruptActiveWork() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).send(botId = "chief_1", text = "new direction")

        val sendRequest = server.takeRequest()
        assertEquals("/api/bots/chief_1/messages", sendRequest.path)
        assertTrue(sendRequest.body.readUtf8().contains("\"text\":\"new direction\""))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun pairingUsesOneTimeCredentialWithoutBearerAndReturnsDeviceToken() = runTest {
        server.enqueue(MockResponse().setBody("{\"app\":\"openmausbot\"}").setHeader("Content-Type", "application/json"))
        server.enqueue(
            MockResponse().setBody(
                """{"token":"omb_device_token","device":{"id":"phone","name":"Pixel"},"serverName":"Office"}""",
            ).setHeader("Content-Type", "application/json"),
        )
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val invite = PairingInvite(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan", "hosted"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "123456",
        )

        val paired = OpenMausApi.pair(invite, "Pixel")

        assertEquals("omb_device_token", paired.token)
        val health = server.takeRequest()
        val pair = server.takeRequest()
        assertEquals("/api/health", health.path)
        assertNull(health.getHeader("Authorization"))
        assertEquals("/api/pair", pair.path)
        assertNull(pair.getHeader("Authorization"))
        assertTrue(pair.body.readUtf8().contains("\"code\":\"123456\""))
    }

    @Test
    fun fleetUsesPairedBearerToken() = runTest {
        server.enqueue(MockResponse().setBody("{\"bots\":[],\"groups\":[]}").setHeader("Content-Type", "application/json"))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).fleet()

        val request = server.takeRequest()
        assertEquals("Bearer omb_secret", request.getHeader("Authorization"))
        assertEquals("/api/bots?messages=80", request.path)
    }

    @Test
    fun fleetFallsBackWhenThePreferredHostCannotResolve() = runTest {
        server.enqueue(MockResponse().setBody("{\"bots\":[],\"groups\":[]}").setHeader("Content-Type", "application/json"))
        val preferred = CompanionEndpoint("http://missing.openmaus.test:8810", "lan", 0)
        val fallback = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 1)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = preferred.url,
                endpoints = listOf(preferred, fallback),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(preferred.url, fallback.url),
            ),
            "omb_secret",
        )
        val dns = Dns { hostname ->
            if (hostname == "missing.openmaus.test") throw UnknownHostException(hostname)
            Dns.SYSTEM.lookup(hostname)
        }
        val client = OkHttpClient.Builder().dns(dns).build()

        OpenMausApi(session, client).fleet()

        val request = server.takeRequest()
        assertEquals("Bearer omb_secret", request.getHeader("Authorization"))
        assertEquals("/api/bots?messages=80", request.path)
    }

    @Test
    fun pushTokenRegistrationUsesThePairedDeviceRoute() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).registerPushToken("fcm_${"a".repeat(120)}")

        val request = server.takeRequest()
        assertEquals("PUT", request.method)
        assertEquals("/api/companion/push-token", request.path)
        assertEquals("Bearer omb_secret", request.getHeader("Authorization"))
        assertTrue(request.body.readUtf8().contains("\"token\":\"fcm_"))
    }

    @Test
    fun pushTokenRevocationUsesThePairedDeviceRoute() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).revokePushToken()

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/companion/push-token", request.path)
        assertEquals("Bearer omb_secret", request.getHeader("Authorization"))
    }

    @Test
    fun notificationMirrorUsesTheReadOnlyCompanionRoute() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).mirrorNotification(
            NotificationMirrorPayload(
                id = "message-1",
                packageName = "com.google.android.apps.messaging",
                postedAt = 1_700_000_000_000,
                title = "Alex",
                text = "See you soon",
                conversationTitle = "Alex",
                sender = "Alex",
            ),
        )

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/companion/notification-mirror", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains("\"packageName\":\"com.google.android.apps.messaging\""))
        assertTrue(body.contains("\"title\":\"Alex\""))
    }

    @Test
    fun notificationMirrorHeartbeatUsesTheContentFreeRoute() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        OpenMausApi(session).mirrorHeartbeat()

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/companion/notification-mirror/heartbeat", request.path)
        assertEquals("{}", request.body.readUtf8())
    }

    @Test
    fun computerScreenshotUsesTheViewOnlyCapabilityRoute() = runTest {
        server.enqueue(
            MockResponse().setBody("""{"png":"/9j/AA==","format":"jpeg"}""")
                .setHeader("Content-Type", "application/json"),
        )
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        val frame = OpenMausApi(session).computerScreenshot("chief_1")

        assertEquals("/9j/AA==", frame.png)
        assertEquals("jpeg", frame.format)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/bots/chief_1/computer/screenshot", request.path)
        assertEquals("Bearer omb_secret", request.getHeader("Authorization"))
    }

    @Test
    fun reportingPreferenceUsesThePairedSafeProfileRoute() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"bot":{"id":"chief_1","threadId":"thread_1","name":"Chief","reportingMode":"actionable"}}""",
            ).setHeader("Content-Type", "application/json"),
        )
        val endpoint = CompanionEndpoint(server.url("/").toString().trimEnd('/'), "lan", 0)
        val session = PairedSession(
            SavedConnection(
                name = "Office",
                origin = endpoint.url,
                endpoints = listOf(endpoint),
                allowedKinds = setOf("lan"),
                allowedLocalOrigins = setOf(endpoint.url),
            ),
            "omb_secret",
        )

        val bot = OpenMausApi(session).setReportingMode("chief_1", "actionable")

        assertEquals("actionable", bot.reportingMode)
        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/api/bots/chief_1/profile", request.path)
        assertTrue(request.body.readUtf8().contains("\"reportingMode\":\"actionable\""))
    }
}
