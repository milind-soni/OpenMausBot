package com.astra.companion.core

import java.net.URI
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import okhttp3.Dns
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class RouteConsentTest {
    private val hosted = requireNotNull(
        CompanionEndpoint.create("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0),
    )
    private val tailnet = requireNotNull(
        CompanionEndpoint.create(
            "http://mac.tail1234.ts.net:8810",
            CompanionEndpointKind.TAILNET,
            100,
        ),
    )
    private val local = requireNotNull(
        CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200),
    )
    private val otherLocal = requireNotNull(
        CompanionEndpoint.create("http://192.168.1.99:8810", CompanionEndpointKind.LAN, 50),
    )

    @Test
    fun hostedInviteAndAdvertisementsRemainHostedOnly() {
        var connection = Connection(
            name = "Mac",
            host = hosted.host,
            port = hosted.port,
            activeEndpoint = hosted,
            endpoints = listOf(hosted),
        ).establishingRoutePolicyFromInvite()

        connection = connection.applyingPairingAdvertisement(
            advertisedHosts = listOf(tailnet.host, local.host),
            advertisedEndpoints = listOf(hosted, tailnet, local),
        )
        assertEquals(setOf(CompanionEndpointKind.HOSTED), connection.allowedRouteKinds)
        assertEquals(emptySet(), connection.allowedLocalRouteURLs)
        assertEquals(
            listOf(hosted),
            connection.endpoints,
            "the pair advertisement must not persist refused endpoints behind the filtered view",
        )
        assertEquals(listOf(CompanionEndpointKind.HOSTED), connection.orderedEndpoints.map { it.kind })
        assertEquals(emptyList(), connection.hosts)

        connection = connection.reconciling(fullMetadata())
        assertEquals(
            listOf(hosted),
            connection.endpoints,
            "the refresh must not persist refused endpoints behind the filtered view",
        )
        assertEquals(listOf(CompanionEndpointKind.HOSTED), connection.orderedEndpoints.map { it.kind })
        assertEquals(listOf(CompanionEndpointKind.HOSTED), connection.automaticEndpoints.map { it.kind })
        assertEquals(emptyList(), connection.hosts)

        val refused = connection.copy(activeEndpoint = tailnet, host = tailnet.host, port = tailnet.port)
        assertNull(refused.baseUrl)
        assertNull(refused.httpEndpoint(Dns.SYSTEM))
        assertEquals(hosted, connection.dialing(tailnet).activeEndpoint)
    }

    @Test
    fun explicitTailscaleInviteAllowsOnlyTailnetAndHosted() {
        var connection = Connection(
            name = "Mac",
            host = tailnet.host,
            port = tailnet.port,
            activeEndpoint = tailnet,
            endpoints = listOf(tailnet, hosted),
        ).establishingRoutePolicyFromInvite()

        connection = connection.applyingPairingAdvertisement(
            advertisedHosts = listOf(tailnet.host, local.host),
            advertisedEndpoints = listOf(hosted, tailnet, local),
        )

        assertEquals(listOf(hosted, tailnet), connection.endpoints)
        assertEquals(listOf(tailnet.host), connection.hosts)

        connection = connection.reconciling(fullMetadata())

        assertEquals(
            setOf(CompanionEndpointKind.TAILNET, CompanionEndpointKind.HOSTED),
            connection.allowedRouteKinds,
        )
        assertEquals(emptySet(), connection.allowedLocalRouteURLs)
        assertEquals(listOf(tailnet, hosted), connection.endpoints)
        assertEquals(
            listOf(CompanionEndpointKind.HOSTED, CompanionEndpointKind.TAILNET),
            connection.orderedEndpoints.map { it.kind },
        )
        assertEquals(
            listOf(CompanionEndpointKind.HOSTED, CompanionEndpointKind.TAILNET),
            connection.automaticEndpoints.map { it.kind },
        )
        assertEquals(listOf(tailnet.host), connection.hosts)
        assertFalse(connection.orderedEndpoints.any { it.kind == CompanionEndpointKind.LAN })
    }

    @Test
    fun forbiddenCleartextHeadCannotInfluenceProtectedRouteOrdering() {
        val priorityZeroLan = requireNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 0),
        )
        val hostedAfterLan = requireNotNull(
            CompanionEndpoint.create("https://mac.companion.example", CompanionEndpointKind.HOSTED, 50),
        )
        val activeTailnet = requireNotNull(
            CompanionEndpoint.create(
                "http://mac.tail1234.ts.net:8810",
                CompanionEndpointKind.TAILNET,
                100,
            ),
        )
        val connection = Connection(
            name = "Mac",
            host = activeTailnet.host,
            port = activeTailnet.port,
            activeEndpoint = activeTailnet,
            endpoints = listOf(priorityZeroLan, hostedAfterLan, activeTailnet),
            allowedRouteKinds = setOf(CompanionEndpointKind.HOSTED, CompanionEndpointKind.TAILNET),
            allowedLocalRouteURLs = emptySet(),
        )

        assertEquals(
            listOf(hostedAfterLan, activeTailnet),
            connection.orderedEndpoints,
            "a cleartext route refused by policy must neither lead nor hoist tailnet above HTTPS",
        )
        assertEquals(listOf(hostedAfterLan, activeTailnet), connection.automaticEndpoints)
    }

    @Test
    fun explicitLocalInviteNeverLearnsTailscaleOrAnotherLanOrigin() {
        var connection = Connection(
            name = "Mac",
            host = local.host,
            port = local.port,
            activeEndpoint = local,
            endpoints = listOf(local, tailnet, hosted, otherLocal),
        ).establishingRoutePolicyFromInvite()

        connection = connection.applyingPairingAdvertisement(
            advertisedHosts = listOf(tailnet.host, local.host),
            advertisedEndpoints = listOf(hosted, tailnet, otherLocal, local),
        )

        assertEquals(
            listOf(hosted, local),
            connection.endpoints,
            "the pair advertisement must persist only the exact consented local origin and hosted",
        )
        assertEquals(listOf(local.host), connection.hosts)

        connection = connection.reconciling(fullMetadata())

        assertEquals(
            setOf(CompanionEndpointKind.LAN, CompanionEndpointKind.HOSTED),
            connection.allowedRouteKinds,
        )
        assertEquals(setOf(local.url), connection.allowedLocalRouteURLs)
        assertEquals(
            listOf(local, hosted),
            connection.endpoints,
            "the refresh must not persist tailnet or another LAN origin behind the filtered view",
        )
        assertFalse(connection.orderedEndpoints.any { it.kind == CompanionEndpointKind.TAILNET })
        assertEquals(
            listOf(CompanionEndpointKind.HOSTED, CompanionEndpointKind.LAN),
            connection.orderedEndpoints.map { it.kind },
        )
        assertFalse(connection.orderedEndpoints.any { it.url == otherLocal.url })
        assertEquals(listOf(local.host), connection.hosts)
    }

    @Test
    fun savedConnectionWithoutPolicyRetainsLegacyProtectedFailover() {
        var connection = CompanionJson.decodeFromString<Connection>(
            """
            {
              "id":"legacy","name":"Mac","host":"mac.companion.example","port":443,
              "activeEndpoint":{"url":"https://mac.companion.example","kind":"hosted","priority":0},
              "endpoints":[
                {"url":"https://mac.companion.example","kind":"hosted","priority":0},
                {"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100}
              ]
            }
            """.trimIndent(),
        )
        assertNull(connection.allowedRouteKinds)
        assertNull(connection.allowedLocalRouteURLs)

        connection = connection.reconciling(fullMetadata())

        assertEquals(
            listOf(otherLocal, tailnet, local, hosted),
            connection.endpoints,
            "a connection saved without a policy keeps the whole refreshed snapshot on disk",
        )
        assertEquals(
            listOf(otherLocal.host, local.host, tailnet.host),
            connection.hosts,
            "including the advertised legacy host list it is allowed to fail over across",
        )
        assertEquals(
            listOf(CompanionEndpointKind.HOSTED, CompanionEndpointKind.TAILNET),
            connection.automaticEndpoints.map { it.kind },
        )
    }

    @Test
    fun everyParsedPairingInviteCarriesANonNullPolicy() {
        val hostedInvite = requireNotNull(
            PairingInvite.parse(URI("astra://pair?address=https%3A%2F%2Fmac.example&code=123456")),
        )
        val tailnetInvite = requireNotNull(
            PairingInvite.parse(URI("astra://pair?address=mac.tail1234.ts.net%3A8810&code=123456")),
        )
        val localInvite = requireNotNull(
            PairingInvite.parse(URI("astra://pair?address=192.168.1.42%3A8810&code=123456")),
        )

        assertEquals(setOf(CompanionEndpointKind.HOSTED), hostedInvite.connection.allowedRouteKinds)
        assertEquals(
            setOf(CompanionEndpointKind.TAILNET, CompanionEndpointKind.HOSTED),
            tailnetInvite.connection.allowedRouteKinds,
        )
        assertEquals(
            setOf(CompanionEndpointKind.LAN, CompanionEndpointKind.HOSTED),
            localInvite.connection.allowedRouteKinds,
        )
        assertEquals(setOf(local.url), localInvite.connection.allowedLocalRouteURLs)
    }

    @Test
    fun nonNullRoutePolicyRoundTripsWithThePersistedConnection() {
        val connection = Connection(
            id = "policy",
            name = "Mac",
            host = local.host,
            port = local.port,
            activeEndpoint = local,
            endpoints = listOf(local, hosted),
        ).establishingRoutePolicyFromInvite()

        val encoded = CompanionJson.encodeToString(connection)
        val restored = CompanionJson.decodeFromString<Connection>(encoded)

        assertEquals(connection.allowedRouteKinds, restored.allowedRouteKinds)
        assertEquals(connection.allowedLocalRouteURLs, restored.allowedLocalRouteURLs)
        assertEquals(setOf(local.url), restored.allowedLocalRouteURLs)
    }

    @Test
    fun manualAddressSelectionResetsInsteadOfWideningRoutePolicy() {
        val selectedTailnet = requireNotNull(
            CompanionEndpoint.create(tailnet.url, CompanionEndpointKind.TAILNET, 0),
        )
        val selectedLocal = requireNotNull(
            CompanionEndpoint.create(local.url, CompanionEndpointKind.LAN, 0),
        )
        var connection = Connection(
            name = "Mac",
            host = hosted.host,
            port = hosted.port,
            activeEndpoint = hosted,
            endpoints = listOf(hosted),
            allowedRouteKinds = setOf(CompanionEndpointKind.HOSTED),
            allowedLocalRouteURLs = emptySet(),
        )

        connection = connection.resettingRoutePolicy(selectedTailnet)
        assertEquals(
            setOf(CompanionEndpointKind.TAILNET, CompanionEndpointKind.HOSTED),
            connection.allowedRouteKinds,
        )
        assertEquals(emptySet(), connection.allowedLocalRouteURLs)
        assertEquals(
            listOf(selectedTailnet, hosted),
            connection.endpoints,
            "the hand-entered route leads the persisted list, with hosted still consented behind it",
        )
        assertEquals(listOf(selectedTailnet.host), connection.hosts)
        assertEquals(
            listOf(CompanionEndpointKind.TAILNET, CompanionEndpointKind.HOSTED),
            connection.orderedEndpoints.map { it.kind },
        )

        connection = connection.resettingRoutePolicy(selectedLocal)
        assertEquals(
            setOf(CompanionEndpointKind.LAN, CompanionEndpointKind.HOSTED),
            connection.allowedRouteKinds,
        )
        assertEquals(setOf(selectedLocal.url), connection.allowedLocalRouteURLs)
        assertEquals(
            listOf(selectedLocal, hosted),
            connection.endpoints,
            "narrowing to a local route must drop the tailnet authority from the persisted list, " +
                "not only from the filtered view",
        )
        assertEquals(
            listOf(selectedLocal.host),
            connection.hosts,
            "and the tailnet host must not survive in the persisted host list either",
        )
        assertEquals(
            listOf(CompanionEndpointKind.LAN, CompanionEndpointKind.HOSTED),
            connection.orderedEndpoints.map { it.kind },
        )
        assertFalse(connection.orderedEndpoints.any { it.kind == CompanionEndpointKind.TAILNET })
        assertEquals(connection, connection.dialing(tailnet))
        assertEquals(connection, connection.dialing(otherLocal))
        assertEquals(connection, connection.promoting(tailnet))
        assertEquals(connection, connection.promoting(otherLocal))

        val refused = connection.copy(
            host = otherLocal.host,
            port = otherLocal.port,
            activeEndpoint = otherLocal,
        )
        assertNull(refused.baseUrl)
        assertNull(refused.httpEndpoint(Dns.SYSTEM))
    }

    @Test
    fun stringPromotionRejectsBeforePersistingAnUnconsentedHost() {
        val connection = Connection(
            name = "Mac",
            host = hosted.host,
            port = hosted.port,
            hosts = emptyList(),
            activeEndpoint = hosted,
            endpoints = listOf(hosted),
        ).establishingRoutePolicyFromInvite()

        val refused = connection.promoting(tailnet.host)

        assertEquals(connection, refused)
        assertEquals(
            emptyList(),
            refused.hosts,
            "a refused string winner must not be copied into the persisted host list",
        )
    }

    private fun fullMetadata() = CompanionConnectionMetadata(
        serverName = "Mac",
        hosts = listOf(otherLocal.host, local.host, tailnet.host),
        endpoints = listOf(otherLocal, tailnet, local, hosted),
    )
}
