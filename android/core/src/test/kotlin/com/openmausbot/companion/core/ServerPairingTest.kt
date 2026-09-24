package com.openmausbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ServerPairingTest {
    @Test
    fun serverQrLinksAreAcceptedWithTheirExactOriginAndNormalizedCode() {
        for (origin in listOf(
            "https://mini.example:8443", "http://192.168.1.20:8799", "http://localhost:8799",
            "http://mini.local:8799", "http://mini.tail.ts.net:8799", "http://[fd00::1]:8799",
        )) {
            val invite = assertNotNull(PairingInvite.parse("$origin/pair#code=abcd-efgh-jklm"))
            assertEquals("ABCDEFGHJKLM", invite.credential)
            assertEquals(origin, invite.connection.activeEndpoint?.url)
            assertEquals(listOf(origin), invite.connection.automaticEndpoints.map { it.url })
        }
    }

    @Test
    fun publicCleartextServerLinksAreRejected() {
        for (host in listOf("public.example", "8.8.8.8", "[2606:4700:4700::1111]", "192.168.1.2.evil.example")) {
            assertNull(PairingInvite.parse("http://$host/pair#code=ABCD-EFGH-JKLM"), host)
        }
    }

    @Test
    fun malformedServerLinksAreRejectedAndCompanionLinksStillWork() {
        for (bad in listOf(
            "https://mini.example/pair",
            "https://mini.example/pair#code=ABCD-EFGH",
            "https://mini.example/pair#code=123456789012",
            "https://mini.example/other#code=ABCDEFGHJKLM",
            "https://mini.example/pair?code=ABCDEFGHJKLM",
            "https://mini.example/pair#code=ABCDEFGHJKLM&code=ABCDEFGHJKLM",
            "https://user:password@mini.example/pair#code=ABCDEFGHJKLM",
            "ftp://mini.example/pair#code=ABCDEFGHJKLM",
        )) assertNull(PairingInvite.parse(bad), bad)
        assertNotNull(PairingInvite.parse("openmausbot://pair?address=192.168.1.9:8810&code=123456"))
    }
}
