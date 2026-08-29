package com.openmausbot.chief.data

import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.net.URLEncoder
import java.util.Base64

class PairingInviteTest {
    @Test
    fun parsesPinnedHostedInvite() {
        val endpoints = listOf(CompanionEndpoint("https://chief.example.com", "hosted", 0))
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(WireJson.encodeToString(endpoints).encodeToByteArray())
        val url = "openmausbot://pair?address=chief.example.com%3A443&token=omb_pair_${"a".repeat(43)}&name=Office&endpoints=${URLEncoder.encode(encoded, "UTF-8")}"

        val invite = PairingInvite.parse(url)

        assertNotNull(invite)
        assertEquals("https://chief.example.com", invite!!.connection.origin)
        assertEquals(setOf("hosted"), invite.connection.allowedKinds)
        assertEquals(emptySet<String>(), invite.connection.allowedLocalOrigins)
    }

    @Test
    fun scannedInviteApprovesItsEncodedFallbackRoutes() {
        val endpoints = listOf(
            CompanionEndpoint("https://chief.example.com", "hosted", 0),
            CompanionEndpoint("http://192.168.1.8:8810", "lan", 200),
            CompanionEndpoint("http://openmausbot-test.local:8810", "bonjour", 300),
        )
        val encoded = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(WireJson.encodeToString(endpoints).encodeToByteArray())
        val url = "openmausbot://pair?address=chief.example.com%3A443&token=omb_pair_${"c".repeat(43)}&name=Office&endpoints=${URLEncoder.encode(encoded, "UTF-8")}"

        val invite = PairingInvite.parse(url)

        assertNotNull(invite)
        assertEquals(setOf("hosted", "lan", "bonjour"), invite!!.connection.allowedKinds)
        assertEquals(
            setOf("http://192.168.1.8:8810", "http://openmausbot-test.local:8810"),
            invite.connection.allowedLocalOrigins,
        )
    }

    @Test
    fun localInvitePinsTheExactOrigin() {
        val invite = PairingInvite.manual("192.168.1.8:8810", "123456")

        assertNotNull(invite)
        assertEquals("http://192.168.1.8:8810", invite!!.connection.origin)
        assertEquals(setOf("http://192.168.1.8:8810"), invite.connection.allowedLocalOrigins)
    }

    @Test
    fun rejectsCredentialDowngradeWhenTypedEndpointsAreInvalid() {
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(
            "[{\"url\":\"http://chief.example.com\",\"kind\":\"hosted\",\"priority\":0}]".encodeToByteArray(),
        )
        val url = "openmausbot://pair?address=192.168.1.8%3A8810&token=omb_pair_${"b".repeat(43)}&endpoints=$encoded"

        assertNull(PairingInvite.parse(url))
    }

    @Test
    fun rejectsDuplicateQueryKeysAndWeakCodes() {
        assertNull(PairingInvite.parse("openmausbot://pair?address=host&code=12345"))
        assertNull(PairingInvite.parse("openmausbot://pair?address=host&address=other&code=123456"))
    }

    @Test
    fun rejectsMalformedOrNonPairingDeepLinksWithoutThrowing() {
        assertNull(PairingInvite.parse("openmausbot://pair?address=%ZZ&code=123456"))
        assertNull(PairingInvite.parse("openmausbot://pair:443?address=host&code=123456"))
        assertNull(PairingInvite.parse("openmausbot://pair/path?address=host&code=123456"))
    }
}
