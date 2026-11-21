package org.openmausbot.android.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.URLEncoder
import java.util.Base64

class CompanionRoutingTest {
    @Test
    fun protectedInviteNeverWalksTheLocalAddressesItCarries() {
        val hosted = endpoint("https://mac.companion.example", EndpointKind.HOSTED, 0)
        val lan = endpoint("http://192.168.1.42:8810", EndpointKind.LAN, 100)
        val invite = invite("mac.tail1234.ts.net:8810", listOf(hosted, lan))
        val seed = invite.seedConnection().establishRoutePolicyFromInvite(everyLocalRoute = true)

        assertEquals(listOf(hosted.url), seed.pairingEndpoints().map { it.url })
        assertEquals(emptySet<String>(), seed.allowedLocalRouteUrls)
    }

    @Test
    fun aLocalQrWalksEveryLocalAddressButPinsTheOneThatAnswered() {
        val wsl = endpoint("http://172.19.96.1:8810", EndpointKind.LAN, 0)
        val wifi = endpoint("http://192.168.1.34:8810", EndpointKind.LAN, 100)
        val bonjour = endpoint("http://miguel.local:8810", EndpointKind.BONJOUR, 200)
        val invite = invite("172.19.96.1:8810", listOf(wsl, wifi, bonjour))
        val seed = invite.seedConnection().establishRoutePolicyFromInvite(everyLocalRoute = true)

        assertEquals(listOf(wsl.url, wifi.url, bonjour.url), seed.pairingEndpoints().map { it.url })
        assertEquals(setOf(wsl.url, wifi.url, bonjour.url), seed.allowedLocalRouteUrls)

        val paired = seed.dialing(wifi).pinRouteConsent(wifi, seed)
        assertEquals(setOf(wifi.url), paired.allowedLocalRouteUrls)
        assertEquals(listOf(wifi.url), paired.endpointRoutes.map { it.url })
        assertEquals(listOf(wifi.url), paired.automaticEndpoints().map { it.url })
    }

    @Test
    fun aProtectedWinnerKeepsTheRouteTheInviteSelected() {
        val tailnet = endpoint("http://mac.tail1234.ts.net:8810", EndpointKind.TAILNET, 0)
        val hosted = endpoint("https://mac.companion.example", EndpointKind.HOSTED, 100)
        val invite = invite("mac.tail1234.ts.net:8810", listOf(tailnet, hosted))
        val seed = invite.seedConnection().establishRoutePolicyFromInvite(everyLocalRoute = true)

        val paired = seed.dialing(hosted).pinRouteConsent(hosted, seed)
        assertEquals(setOf(EndpointKind.TAILNET, EndpointKind.HOSTED), paired.allowedRouteKinds)
        assertEquals(listOf(tailnet.url, hosted.url), paired.endpointRoutes.map { it.url })
    }

    @Test
    fun rejectedEndpointsRejectTheWholeInvite() {
        val bad = JSONArray().put(
            JSONObject()
                .put("url", "http://mac.companion.example")
                .put("kind", "hosted")
                .put("priority", 0)
        )
        val encoded = b64u(bad.toString())
        val link = "openmausbot://pair?address=192.168.1.42%3A8810&token=$TOKEN&endpoints=$encoded"
        assertNull(PairingInvite.parse(link))
    }

    @Test
    fun aMalformedSecretKeyRejectsTheInvite() {
        val invalid = b64u(ByteArray(64) { if (it == 0) 4 else 1 })
        val link = "openmausbot://pair?address=192.168.1.42%3A8810&token=$TOKEN&secretKey=$invalid"
        assertNull(PairingInvite.parse(link))
    }

    @Test
    fun aValidP256PointIsAccepted() {
        val key = b64u(ByteArray(65) { if (it == 0) 4 else 1 })
        val link = "openmausbot://pair?address=192.168.1.42%3A8810&token=$TOKEN&secretKey=$key"
        assertEquals(key, PairingInvite.parse(link)?.secretKey)
    }

    @Test
    fun legacyHostsBecomeRoutesOnlyForAConnectionWithoutTypedRoutes() {
        val invite = PairingInvite(
            baseUrl = "http://192.168.1.42:8810",
            token = TOKEN,
            code = null,
            serverName = "Mac",
            hosts = listOf("192.168.1.42", "miguel.local"),
        )
        val seed = invite.seedConnection()
        assertEquals("http://192.168.1.42:8810", seed.baseUrl)
        assertEquals(listOf("http://192.168.1.42:8810"), seed.endpoints)
    }

    private fun endpoint(url: String, kind: EndpointKind, priority: Int): CompanionEndpoint =
        CompanionEndpoint.create(url, kind, priority)!!

    private fun invite(address: String, routes: List<CompanionEndpoint>): PairingInvite {
        val link = "openmausbot://pair?address=${URLEncoder.encode(address, "UTF-8")}" +
            "&token=$TOKEN&endpoints=${URLEncoder.encode(b64u(JSONArray().also { array ->
                routes.forEach { array.put(it.toJson()) }
            }.toString()), "UTF-8")}"
        return PairingInvite.parse(link)!!
    }

    private fun b64u(text: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())

    private fun b64u(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private companion object {
        val TOKEN = "omb_pair_" + "a".repeat(43)
    }
}
