package com.astra.companion.core

import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URI
import java.util.Base64
import java.util.Collections
import java.util.concurrent.atomic.AtomicReference
import javax.net.SocketFactory
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import okhttp3.Call
import okhttp3.Dns
import okhttp3.EventListener
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConnectionTest {
    @Test
    fun parsesHostnamesAndPorts() {
        val implicit = Connection.parse("macbook.tailnet.ts.net")
        assertEquals("macbook.tailnet.ts.net", implicit?.host)
        assertEquals(8810, implicit?.port)
        val explicit = Connection.parse("http://192.168.1.42:9910/")
        assertEquals("192.168.1.42", explicit?.host)
        assertEquals(9910, explicit?.port)

        val hosted = Connection.parse("https://Companion.Example.com")
        assertEquals("companion.example.com", hosted?.host)
        assertEquals(443, hosted?.port)
        assertEquals("https://companion.example.com", hosted?.baseUrl.toString())
        assertEquals(CompanionEndpointKind.HOSTED, hosted?.activeEndpoint?.kind)

        val tailnet = Connection.parse("http://macbook.tailnet.ts.net:8810")
        assertEquals(CompanionEndpointKind.TAILNET, tailnet?.activeEndpoint?.kind)
        assertTrue(tailnet?.activeEndpoint?.protectsCredentials == true)
    }

    @Test
    fun legacyAndTypedLanUseTheSameDefaultPortDisplayAddress() {
        val legacy = Connection(name = "Mac", host = "192.168.1.42", port = 8810)
        val typed = requireNotNull(Connection.parse("http://192.168.1.42:8810"))

        assertEquals("192.168.1.42", legacy.displayAddress)
        assertEquals(typed.displayAddress, legacy.displayAddress)
    }

    @Test
    fun endpointValidationEnforcesKindAndAbsoluteAuthorityPolicy() {
        val hosted = assertNotNull(
            CompanionEndpoint.create("https://mac.example", CompanionEndpointKind.HOSTED, 0),
        )
        val tailnet = assertNotNull(
            CompanionEndpoint.create("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 1),
        )
        val lan = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 2),
        )
        val bonjour = assertNotNull(
            CompanionEndpoint.create("http://mac.local:8810", CompanionEndpointKind.BONJOUR, 3),
        )
        assertEquals(CompanionEndpointSecurityClass.PROTECTED, hosted.securityClass)
        assertEquals(CompanionEndpointSecurityClass.PROTECTED, tailnet.securityClass)
        assertEquals(CompanionEndpointSecurityClass.EXPLICIT_LOCAL, lan.securityClass)
        assertEquals(CompanionEndpointSecurityClass.EXPLICIT_LOCAL, bonjour.securityClass)

        listOf(
            Triple("http://public.example", CompanionEndpointKind.HOSTED, 0),
            Triple("https://mac.tail1234.ts.net", CompanionEndpointKind.TAILNET, 0),
            Triple("http://public.example", CompanionEndpointKind.TAILNET, 0),
            Triple("https://192.168.1.42", CompanionEndpointKind.LAN, 0),
            Triple("https://mac.local", CompanionEndpointKind.BONJOUR, 0),
            Triple("https://user:secret@public.example", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example/path", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example?query=1", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example#fragment", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example:0", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example:65536", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example:", CompanionEndpointKind.HOSTED, 0),
            Triple("https://public.example", CompanionEndpointKind.HOSTED, -1),
            Triple("https://public.example", CompanionEndpointKind.HOSTED, 1_000_001),
            Triple("https://${"a".repeat(2_048)}.example", CompanionEndpointKind.HOSTED, 0),
        ).forEach { (url, kind, priority) ->
            assertNull(CompanionEndpoint.create(url, kind, priority), "$kind accepted $url at $priority")
        }
    }

    @Test
    fun normalizesZonesOnlyForNonIpv6Hosts() {
        assertEquals("", Connection.urlHost(""))
        assertEquals("", Connection.urlHost("%"))
        assertEquals("192.168.1.3", Connection.urlHost("192.168.1.3%en0"))
        assertEquals("mac.local", Connection.urlHost("mac.local%en0"))
        assertEquals("[fe80::1%en0]", Connection.urlHost("fe80::1%en0"))
        assertEquals("[fe80::1%en0]", Connection.urlHost("[fe80::1%en0]"))
        assertEquals("192.168.1.3", Connection.urlHost("192.168.1.3"))
        assertEquals("mac.local", Connection.urlHost("mac.local"))
    }

    @Test
    fun parsersNormalizeNonIpv6ZoneSuffixes() {
        val connection = Connection.parse("192.168.1.3%en0:9910")
        assertEquals("192.168.1.3", connection?.host)
        assertEquals(9910, connection?.port)

        val invite = PairingInvite.parse(
            URI("astra://pair?address=192.168.1.3%25en0%3A9910&code=004209"),
        )
        assertEquals("192.168.1.3", invite?.connection?.host)
        assertEquals(9910, invite?.connection?.port)
    }

    @Test
    fun parsesIpv6WithAndWithoutAnExplicitPort() {
        val bare = Connection.parse("2001:db8::1")
        assertEquals("[2001:db8::1]", bare?.host)
        assertEquals(8810, bare?.port)
        assertEquals("http://[2001:db8::1]:8810", bare?.baseUrl.toString())
        val explicit = Connection.parse("[2001:db8::1]:9910")
        assertEquals("[2001:db8::1]", explicit?.host)
        assertEquals(9910, explicit?.port)
        assertEquals("http://[2001:db8::1]:9910", explicit?.baseUrl.toString())
    }

    @Test
    fun retainsTheScopeZoneOnLinkLocalIpv6() {
        val connection = Connection.parse("[fe80::1%en0]:8810")
        assertEquals("[fe80::1%en0]", connection?.host)
        assertEquals("http://[fe80::1%25en0]:8810", connection?.baseUrl.toString())
    }

    @Test
    fun zonedIpv6UsesScopedAddressOnTheRealOkHttpConnectPath() = runBlocking {
        // Everything below needs a real interface name and index to build the
        // scoped address with. Where the JVM exposes no IPv6 interface, failing
        // here would measure the machine, not Connection — so skip instead.
        val ipv6Interface = Collections.list(NetworkInterface.getNetworkInterfaces())
            .firstOrNull { candidate ->
                Collections.list(candidate.inetAddresses).any { it is Inet6Address }
            }
        assumeTrue(ipv6Interface != null, "this JVM exposes no IPv6-capable interface")
        val networkInterface = assertNotNull(ipv6Interface)
        var fallbackCalled = false
        val fallback = object : Dns {
            override fun lookup(hostname: String) = emptyList<InetAddress>().also {
                fallbackCalled = true
            }
        }
        val connection = assertNotNull(Connection.parse("[fe80::1%${networkInterface.name}]:8810"))
        val endpoint = assertNotNull(connection.httpEndpoint(fallback))
        assertEquals(SCOPED_IPV6_HTTP_HOST, endpoint.baseUrl.host)

        val route = RecordingRouteListener()
        val sockets = RecordingSocketFactory()
        val okHttp = OkHttpClient.Builder()
            .dns(fallback)
            .eventListener(route)
            .socketFactory(sockets)
            .build()
        assertFailsWith<APIError.Transport> {
            CompanionClient(connection, null, okHttp).health()
        }

        assertEquals(SCOPED_IPV6_HTTP_HOST, route.dnsHost.get())
        val resolved = assertNotNull(route.dnsAddresses.get()?.single() as? Inet6Address)
        assertEquals(networkInterface.index, resolved.scopeId)
        assertEquals(networkInterface.name, resolved.scopedInterface?.name)
        val connectTarget = assertNotNull(sockets.connectTarget.get())
        assertEquals(resolved, connectTarget.address)
        assertFalse(fallbackCalled, "the scoped literal must not fall through to ordinary DNS")
    }

    @Test
    fun okHttpEndpointPreservesTypedHttpsSchemeAndDefaultPort() {
        val connection = assertNotNull(Connection.parse("https://mac.example"))
        val endpoint = assertNotNull(connection.httpEndpoint(Dns.SYSTEM))
        assertEquals("https", endpoint.baseUrl.scheme)
        assertEquals("mac.example", endpoint.baseUrl.host)
        assertEquals(443, endpoint.baseUrl.port)
    }

    @Test
    fun olderSavedIpv6ConnectionIsNormalizedWhenUsed() {
        val saved = CompanionJson.decodeFromString<Connection>(
            """{"id":"saved","name":"Mac","host":"::1","port":8810}""",
        )
        assertEquals("http://[::1]:8810", saved.baseUrl.toString())
    }

    @Test
    fun rejectsAmbiguousOrUnsafeAddresses() {
        assertNull(Connection.parse("host:not-a-port"))
        assertNull(Connection.parse("[::1]:not-a-port"))
        assertNull(Connection.parse("[::1]:70000"))
        assertNull(Connection.parse("host/path"))
        assertNull(Connection.parse("host name"))
    }

    @Test
    fun parsesADesktopPairingInvite() {
        val token = "omb_pair_" + "a".repeat(43)
        val invite = PairingInvite.parse(
            URI("astra://pair?address=macbook.tail1234.ts.net%3A8810&token=$token&code=004209&name=Milind%27s%20Mac"),
        )!!
        assertEquals("macbook.tail1234.ts.net", invite.connection.host)
        assertEquals(8810, invite.connection.port)
        assertEquals("Milind's Mac", invite.connection.name)
        assertEquals(token, invite.credential)
    }

    @Test
    fun literalPlusInPairingInviteNameIsPreserved() {
        val invite = PairingInvite.parse(
            URI("astra://pair?address=mac.local&code=004209&name=Ada%27s+Mac"),
        )
        assertEquals("Ada's+Mac", invite?.connection?.name)
    }

    @Test
    fun parsesAnOlderCodeOnlyPairingInvite() {
        val invite = PairingInvite.parse(URI("astra://pair?address=mac.local&code=004209"))
        assertEquals("004209", invite?.credential)
    }

    @Test
    fun pairingInviteKeepsOnlyFallbackHostsAllowedByItsSelectedRoute() {
        val invite = PairingInvite.parse(URI(
            "astra://pair?address=macbook.tail1234.ts.net%3A8810&code=004209" +
                "&hosts=macbook.tail1234.ts.net,192.168.1.42,astra-aa.local",
        ))!!
        assertEquals(
            listOf("macbook.tail1234.ts.net"),
            invite.connection.hosts,
        )
    }

    @Test
    fun typedInviteEstablishesPolicyFromItsSelectedEndpoint() {
        val routes = """
            [
              {"url":"http://192.168.1.42:8810","kind":"lan","priority":200},
              {"url":"https://MAC.example/","kind":"hosted","priority":0},
              {"url":"http://first.tail.ts.net:8810","kind":"tailnet","priority":100},
              {"url":"http://second.tail.ts.net:8810","kind":"tailnet","priority":100},
              {"url":"https://mac.example","kind":"hosted","priority":999}
            ]
        """.trimIndent()
        val token = "omb_pair_" + "a".repeat(43)
        val invite = assertNotNull(PairingInvite.parse(URI(
            "astra://pair?address=192.168.1.42%3A8810&token=$token&endpoints=${base64Url(routes)}",
        )))

        assertEquals("https://mac.example", invite.connection.baseUrl.toString())
        assertEquals(CompanionEndpointKind.HOSTED, invite.connection.activeEndpoint?.kind)
        assertEquals(
            listOf(CompanionEndpointKind.HOSTED),
            invite.connection.orderedEndpoints.map { it.kind },
        )
        assertEquals(setOf(CompanionEndpointKind.HOSTED), invite.connection.allowedRouteKinds)
    }

    @Test
    fun presentButInvalidTypedEndpointsRejectTheWholeInvite() {
        val token = "omb_pair_" + "a".repeat(43)
        val invalidRoutes = listOf(
            """[{"url":"http://public.example","kind":"hosted","priority":0}]""",
            """[{"url":"https://public.example","kind":"future-transport","priority":0}]""",
            """[{"url":"https://user:secret@public.example","kind":"hosted","priority":0}]""",
            """[{"url":"https://public.example/path","kind":"hosted","priority":0}]""",
            "[]",
            (0..8).joinToString(prefix = "[", postfix = "]") {
                """{"url":"http://192.168.1.${it + 1}:8810","kind":"lan","priority":$it}"""
            },
        )
        invalidRoutes.forEach { routes ->
            val invite = PairingInvite.parse(URI(
                "astra://pair?address=192.168.1.42%3A8810&token=$token&endpoints=${base64Url(routes)}",
            ))
            assertNull(invite, routes)
        }
        assertNull(PairingInvite.parse(URI(
            "astra://pair?address=192.168.1.42%3A8810&token=$token&endpoints=not-json",
        )))
        assertNull(PairingInvite.parse(URI(
            "astra://pair?address=192.168.1.42%3A8810&token=$token&endpoints=",
        )))
        assertNull(PairingInvite.parse(URI(
            "astra://pair?address=192.168.1.42%3A8810&token=$token&endpoints=${"a".repeat(8_193)}",
        )))
    }

    @Test
    fun dropsUnusableFallbackHostsWithoutRefusingTheInvite() {
        val invite = PairingInvite.parse(URI(
            "astra://pair?address=mac.local&code=004209&hosts=%20192.168.1.42%20,,bad%2Fslash,has%20space",
        ))!!
        assertEquals(emptyList(), invite.connection.hosts)
        val empty = PairingInvite.parse(
            URI("astra://pair?address=mac.local&code=004209&hosts=bad%2Fslash"),
        )
        assertNull(empty?.connection?.hosts)
    }

    @Test
    fun savedConnectionWithoutFallbacksStillDecodes() {
        val saved = CompanionJson.decodeFromString<Connection>(
            """{"id":"saved","name":"Mac","host":"mac.tail1234.ts.net","port":8810}""",
        )
        assertNull(saved.hosts)
        assertEquals(listOf("mac.tail1234.ts.net"), saved.orderedHosts)
        assertNull(saved.activeEndpoint)
        assertEquals("http://mac.tail1234.ts.net:8810", saved.baseUrl.toString())
    }

    @Test
    fun typedConnectionRoundTripsWithTheCompleteNonSecretUrl() {
        val connection = assertNotNull(Connection.parse("https://mac.example:9443"))
            .copy(id = "saved", name = "Mac")

        val encoded = CompanionJson.encodeToString(connection)
        val restored = CompanionJson.decodeFromString<Connection>(encoded)

        assertEquals(connection, restored)
        assertEquals("https://mac.example:9443", restored.activeEndpoint?.url)
        assertEquals("https://mac.example:9443", restored.baseUrl.toString())
        assertFalse(encoded.contains("token", ignoreCase = true))
    }

    @Test
    fun pairResponseWithAndWithoutHostsDecodes() {
        val older = CompanionJson.decodeFromString<PairResponse>(
            """{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac"}""",
        )
        assertNull(older.hosts)
        val newer = CompanionJson.decodeFromString<PairResponse>(
            """{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","hosts":["a.ts.net","192.168.1.42"]}""",
        )
        assertEquals(listOf("a.ts.net", "192.168.1.42"), newer.hosts)
        val typed = CompanionJson.decodeFromString<PairResponse>(
            """{"token":"omb_x","device":{"id":"d","name":"p","createdAt":1,"lastSeenAt":1},"serverName":"Mac","endpoints":[{"url":"https://mac.example","kind":"hosted","priority":0}]}""",
        )
        assertEquals("https://mac.example", typed.endpoints?.first()?.url)
        assertEquals(CompanionEndpointKind.HOSTED, typed.endpoints?.first()?.kind)
    }

    @Test
    fun refreshMetadataIsLossySortedAndRequiresAUsableRoute() {
        val metadata = CompanionJson.decodeFromString<CompanionConnectionMetadata>(
            """{"serverName":"Mac","endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},{"url":"https://future.example","kind":"future","priority":1},{"url":"https://mac.example","kind":"hosted","priority":0},{"url":"https://MAC.example/","kind":"hosted","priority":50}]}""",
        )
        assertEquals(
            listOf("https://mac.example", "http://192.168.1.42:8810"),
            metadata.endpoints.map { it.url },
        )
        assertFailsWith<SerializationException> {
            CompanionJson.decodeFromString<CompanionConnectionMetadata>(
                """{"serverName":"Mac","endpoints":[{"url":"https://future.example","kind":"future","priority":0}]}""",
            )
        }
        assertFailsWith<SerializationException> {
            CompanionJson.decodeFromString<CompanionConnectionMetadata>(
                """{"serverName":"Mac","endpoints":[]}""",
            )
        }
    }

    @Test
    fun anUpgradeToAProtectedRouteOutranksAStoredCleartextPriority() {
        // `Session.updateAddress` mints a hand-typed route at priority 0, so it leads the stored
        // order — that is the explicit choice being recorded. Once the walk has upgraded away
        // from it, that priority must stop meaning "this is the local route the person picked",
        // or the next launch hands the bearer straight back to cleartext.
        val local = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 0),
        )
        val hosted = assertNotNull(
            CompanionEndpoint.create("https://mac.example", CompanionEndpointKind.HOSTED, 100),
        )
        val chosen = Connection(
            name = "Mac",
            host = local.host,
            port = local.port,
            activeEndpoint = local,
            endpoints = listOf(local, hosted),
        )
        assertEquals(listOf(local, hosted), chosen.automaticEndpoints, "the typed route leads")

        val upgraded = chosen.promoting(hosted)

        assertEquals(listOf(hosted, local), upgraded.orderedEndpoints)
        assertEquals(listOf(hosted), upgraded.automaticEndpoints)
        assertTrue(
            upgraded.endpoints.orEmpty().any { it.url == local.url },
            "the superseded route is still stored, for display and a later explicit choice",
        )

        // And that later explicit choice still works: choosing the local route by hand makes it
        // the head again, so the person is never locked out of their own network.
        val rechosen = upgraded.promoting(local)
        assertEquals(listOf(local, hosted), rechosen.automaticEndpoints)
    }

    @Test
    fun advertisedPriorityGovernsBetweenEquallyProtectedRoutes() {
        // The computer says hosted first, tailnet second, and the LAN sits between them by
        // number. The session is on tailnet — a transient hosted outage failed over to it.
        // The cleartext route must fall behind both; the two protected routes must keep the
        // order the computer asked for, including the one that is currently carrying traffic.
        val hosted = assertNotNull(
            CompanionEndpoint.create("https://mac.example", CompanionEndpointKind.HOSTED, 0),
        )
        val lan = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 50),
        )
        val tailnet = assertNotNull(
            CompanionEndpoint.create("http://mac.tail1234.ts.net:8810", CompanionEndpointKind.TAILNET, 100),
        )
        val onTailnet = Connection(
            name = "Mac",
            host = tailnet.host,
            port = tailnet.port,
            activeEndpoint = tailnet,
            endpoints = listOf(hosted, lan, tailnet),
        )

        assertEquals(listOf(hosted, tailnet, lan), onTailnet.orderedEndpoints)
        assertEquals(
            listOf(hosted, tailnet),
            onTailnet.automaticEndpoints,
            "being active earns a protected route nothing: the desktop's priority still governs",
        )

        // The same connection restated by an authenticated snapshot keeps that answer, which is
        // the whole point of the refresh — the computer gets to reassert its transport policy.
        val restated = onTailnet.reconciling(
            CompanionJson.decodeFromString<CompanionConnectionMetadata>(
                """{"serverName":"Mac","endpoints":[{"url":"https://mac.example","kind":"hosted","priority":0},""" +
                    """{"url":"http://192.168.1.42:8810","kind":"lan","priority":50},""" +
                    """{"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100}]}""",
            ),
        )

        assertEquals(tailnet, restated.activeEndpoint, "the live route is not swapped by a refresh")
        assertEquals(listOf(hosted, tailnet, lan), restated.orderedEndpoints)
        assertEquals(listOf(hosted, tailnet), restated.automaticEndpoints)
    }

    @Test
    fun protectedConnectionDoesNotDowngradeWhenHostedIsWithdrawn() {
        val hosted = assertNotNull(
            CompanionEndpoint.create("https://mac.companion.example", CompanionEndpointKind.HOSTED, 0),
        )
        val lan = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200),
        )
        val connection = Connection(
            name = "Mac",
            host = hosted.host,
            port = hosted.port,
            activeEndpoint = hosted,
            endpoints = listOf(hosted, lan),
        )
        val metadata = CompanionJson.decodeFromString<CompanionConnectionMetadata>(
            """{"serverName":"Mac","hosts":["192.168.1.42"],"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200}]}""",
        )

        val reconciled = connection.reconciling(metadata)

        assertEquals(hosted, reconciled.activeEndpoint)
        assertEquals(listOf(hosted.url, lan.url), reconciled.orderedEndpoints.map { it.url })
        assertEquals(listOf(hosted), reconciled.automaticEndpoints)
    }

    @Test
    fun existingLocalPairingLearnsHostedWithoutRepairing() {
        val local = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200),
        )
        val connection = Connection(
            name = "Mac",
            host = local.host,
            port = local.port,
            activeEndpoint = local,
            endpoints = listOf(local),
        )
        val metadata = CompanionJson.decodeFromString<CompanionConnectionMetadata>(FULL_METADATA)

        val reconciled = connection.reconciling(metadata)

        assertEquals(local, reconciled.activeEndpoint, "the live local stream is not switched underneath itself")
        assertEquals("Milind's computer", reconciled.name)
        assertEquals(
            CompanionEndpointKind.HOSTED,
            reconciled.orderedEndpoints.first().kind,
            "the next launch upgrades to hosted HTTPS",
        )
        // A route advertised with an unusable authority for its kind never enters the snapshot.
        assertFalse(reconciled.orderedEndpoints.any { it.host == "not-a-tailnet.example" })

        val liveRotation = CandidateRotation(
            listOf(local) + reconciled.orderedEndpoints.filterNot { it.url == local.url },
        )
        assertEquals(local, liveRotation.currentEndpoint)
        assertEquals(
            CompanionEndpointKind.HOSTED,
            liveRotation.advanceEndpoint(SocketTimeoutException())?.kind,
            "this session may upgrade after its explicitly chosen local route fails",
        )
        assertTrue(liveRotation.endpoints.all { it.protectsCredentials })
    }

    @Test
    fun reconcilingKeepsTheExactPreviousRouteWhenNoProtectedReplacementIsOffered() {
        val local = assertNotNull(
            CompanionEndpoint.create("http://192.168.1.42:8810", CompanionEndpointKind.LAN, 200),
        )
        val connection = Connection(
            name = "Mac",
            host = local.host,
            port = local.port,
            activeEndpoint = local,
            endpoints = listOf(local),
        )
        val metadata = CompanionJson.decodeFromString<CompanionConnectionMetadata>(
            """{"serverName":"  ","hosts":["10.0.0.9","bad\u002Fslash","10.0.0.9"],"endpoints":[{"url":"http://10.0.0.9:8810","kind":"lan","priority":0}]}""",
        )

        val reconciled = connection.reconciling(metadata)

        // Retained at priority 0 so it still leads the order — same route, not a new authority.
        assertEquals(local.url, reconciled.activeEndpoint?.url, "another cleartext LAN address is not authorized")
        assertEquals(0, reconciled.activeEndpoint?.priority)
        assertEquals(
            listOf("http://192.168.1.42:8810", "http://10.0.0.9:8810"),
            reconciled.orderedEndpoints.map { it.url },
        )
        assertEquals("Mac", reconciled.name, "a blank advertised name never replaces the stored one")
        assertEquals(listOf("10.0.0.9"), reconciled.hosts)
    }

    @Test
    fun rejectsUntrustedOrMalformedPairingInvites() {
        listOf(
            "https://example.com/pair?address=mac.local&code=123456",
            "astra://pair?address=mac.local&code=12345",
            "astra://pair?address=mac.local&token=weak",
            "astra://pair?address=mac.local&token=weak&code=123456",
            "astra://pair?address=host%2Fpath&code=123456",
            "astra://pair?address=one.local&address=two.local&code=123456",
        ).forEach { assertNull(PairingInvite.parse(URI(it)), it) }
    }

    @Test
    fun acceptsOnlyAnHttpsCloudDesktopSession() {
        val valid = CompanionJson.decodeFromString<CloudDesktopSession>(
            """{"joinUrl":"https://desktop.example/session/fresh","state":"ready"}""",
        )
        assertEquals("https://desktop.example/session/fresh", valid.url.toString())
        listOf(
            "http://desktop.example/session",
            "javascript:alert(1)",
            "not a URL",
            "https:///missing-host",
        ).forEach { value ->
            assertFailsWith<SerializationException> {
                CompanionJson.decodeFromString<CloudDesktopSession>("""{"joinUrl":"$value"}""")
            }
        }
    }

    private class RecordingRouteListener : EventListener() {
        val dnsHost = AtomicReference<String>()
        val dnsAddresses = AtomicReference<List<InetAddress>>()

        override fun dnsStart(call: Call, domainName: String) {
            dnsHost.set(domainName)
        }

        override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
            dnsAddresses.set(inetAddressList)
        }
    }

    private companion object {
        private const val FULL_METADATA =
            """{"serverName":"Milind's computer","hosts":["mac.tail1234.ts.net","192.168.1.42"],""" +
                """"endpoints":[{"url":"http://192.168.1.42:8810","kind":"lan","priority":200},""" +
                """{"url":"http://not-a-tailnet.example:8810","kind":"tailnet","priority":50},""" +
                """{"url":"http://mac.tail1234.ts.net:8810","kind":"tailnet","priority":100},""" +
                """{"url":"https://mac.companion.example","kind":"hosted","priority":0}]}"""
    }

    private fun base64Url(value: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray())

    private class RecordingSocketFactory : SocketFactory() {
        val connectTarget = AtomicReference<InetSocketAddress>()

        override fun createSocket(): Socket = object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) {
                connectTarget.set(endpoint as InetSocketAddress)
                throw SocketException("connect target recorded")
            }
        }

        override fun createSocket(host: String, port: Int): Socket = unsupported()
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = unsupported()
        override fun createSocket(host: InetAddress, port: Int): Socket = unsupported()
        override fun createSocket(
            address: InetAddress,
            port: Int,
            localAddress: InetAddress,
            localPort: Int,
        ): Socket = unsupported()

        private fun unsupported(): Nothing = error("OkHttp must use createSocket() before connect")
    }
}
