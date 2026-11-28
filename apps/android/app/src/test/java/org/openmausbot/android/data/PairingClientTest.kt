package org.openmausbot.android.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairingClientTest {
    @Test
    fun protectedInviteNeverProbesOrRedeemsOnLan() = runBlocking {
        val hosted = CompanionEndpoint.create("https://mac.companion.example", EndpointKind.HOSTED, 0)!!
        val lan = CompanionEndpoint.create("http://192.168.1.42:8810", EndpointKind.LAN, 100)!!
        val invite = invite("mac.tail1234.ts.net:8810", listOf(hosted, lan))
        val transport = FakeTransport(setOf(hosted.url, lan.url))

        val outcome = PairingClient.pairFirstReachable(invite, "Android", "req-1", transport)

        assertEquals(listOf(hosted.url), transport.healthyCalls)
        assertEquals(listOf(hosted.url), transport.redeemCalls.map { it.first })
        assertEquals(hosted.url, outcome.connection.activeEndpoint?.url)
    }

    @Test
    fun aDeadFirstLocalAddressFallsBackToTheNextWithTheSameRequestId() = runBlocking {
        val dead = CompanionEndpoint.create("http://172.19.96.1:8810", EndpointKind.LAN, 0)!!
        val wifi = CompanionEndpoint.create("http://192.168.1.34:8810", EndpointKind.LAN, 100)!!
        val invite = invite("172.19.96.1:8810", listOf(dead, wifi))
        val transport = FakeTransport(setOf(wifi.url))

        val outcome = PairingClient.pairFirstReachable(invite, "Android", "req-2", transport)

        assertEquals(listOf(wifi.url), transport.redeemCalls.map { it.first })
        assertEquals(listOf("req-2"), transport.redeemCalls.map { it.second })
        assertEquals(setOf(wifi.url), outcome.connection.allowedLocalRouteUrls)
    }

    @Test
    fun aGatewayFailureRetriesTheProtectedFallbackWithTheSameRequestId() = runBlocking {
        val tailnet = CompanionEndpoint.create("http://mac.tail1234.ts.net:8810", EndpointKind.TAILNET, 0)!!
        val hosted = CompanionEndpoint.create("https://mac.companion.example", EndpointKind.HOSTED, 100)!!
        val invite = invite("mac.tail1234.ts.net:8810", listOf(tailnet, hosted))
        val transport = FakeTransport(
            healthy = setOf(tailnet.url, hosted.url),
            failures = mapOf(tailnet.url to ApiException(502, "bad gateway")),
        )

        val outcome = PairingClient.pairFirstReachable(invite, "Android", "req-3", transport)

        assertEquals(listOf(tailnet.url, hosted.url), transport.redeemCalls.map { it.first })
        assertEquals(listOf("req-3", "req-3"), transport.redeemCalls.map { it.second })
        assertEquals(hosted.url, outcome.connection.activeEndpoint?.url)
        assertEquals(setOf(EndpointKind.TAILNET, EndpointKind.HOSTED), outcome.connection.allowedRouteKinds)
    }

    @Test
    fun aPairingRejectionIsNotSentToAnotherRoute() = runBlocking {
        val first = CompanionEndpoint.create("http://192.168.1.34:8810", EndpointKind.LAN, 0)!!
        val second = CompanionEndpoint.create("http://192.168.1.35:8810", EndpointKind.LAN, 100)!!
        val invite = invite("192.168.1.34:8810", listOf(first, second))
        val transport = FakeTransport(
            healthy = setOf(first.url, second.url),
            failures = mapOf(first.url to ApiException(401, "pairing expired")),
        )

        try {
            PairingClient.pairFirstReachable(invite, "Android", "req-4", transport)
            fail("an expired credential should be rejected")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
        }
        assertEquals(1, transport.redeemCalls.size)
    }

    @Test
    fun allFailedProbesLeaveTheCredentialUnspent() = runBlocking {
        val wifi = CompanionEndpoint.create("http://192.168.1.34:8810", EndpointKind.LAN, 0)!!
        val invite = invite("192.168.1.34:8810", listOf(wifi))
        val transport = FakeTransport(emptySet())

        try {
            PairingClient.pairFirstReachable(invite, "Android", "req-5", transport)
            fail("pairing should fail when no route answers")
        } catch (e: PairingRouteError) {
            assertEquals(listOf(wifi.url), e.attemptedHosts)
        }
        assertTrue(transport.redeemCalls.isEmpty())
    }

    private class FakeTransport(
        private val healthy: Set<String>,
        private val failures: Map<String, Throwable> = emptyMap(),
    ) : PairingTransport {
        val healthyCalls = mutableListOf<String>()
        val redeemCalls = mutableListOf<Pair<String, String>>()

        override suspend fun healthy(endpoint: CompanionEndpoint): Boolean {
            healthyCalls += endpoint.url
            return endpoint.url in healthy
        }

        override suspend fun redeem(
            endpoint: CompanionEndpoint,
            credential: String,
            deviceName: String,
            pairRequestId: String,
        ): ApiClient.PairResult {
            redeemCalls += endpoint.url to pairRequestId
            failures[endpoint.url]?.let { throw it }
            return ApiClient.PairResult(
                token = "omb_device",
                deviceId = "d",
                serverName = "Mac",
                hosts = listOf("192.168.1.34"),
                endpoints = emptyList(),
            )
        }
    }

    private fun invite(address: String, routes: List<CompanionEndpoint>): PairingInvite {
        val json = routes.joinToString(prefix = "[", postfix = "]") { route ->
            """{"url":"${route.url}","kind":"${route.kind.wire}","priority":${route.priority}}"""
        }
        val encoded = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(json.toByteArray())
        val link = "openmausbot://pair?address=${java.net.URLEncoder.encode(address, "UTF-8")}" +
            "&token=$TOKEN&endpoints=$encoded"
        return PairingInvite.parse(link)!!
    }

    private companion object {
        val TOKEN = "omb_pair_" + "a".repeat(43)
    }
}
