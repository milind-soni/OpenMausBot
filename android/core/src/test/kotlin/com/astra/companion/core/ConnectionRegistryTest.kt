package com.astra.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConnectionRegistryTest {
    private val air = Connection(id = "air", name = "MacBook Air", host = "air.local", port = 8810)
    private val pro = Connection(id = "pro", name = "MacBook Pro", host = "pro.local", port = 8810)

    @Test
    fun upsertSelectAndRemoveKeepIndependentComputers() {
        val registry = ConnectionRegistry()
            .upsert(air)
            .upsert(pro)

        assertEquals(listOf(air, pro), registry.connections)
        assertEquals(pro, registry.activeConnection)
        assertEquals(air, registry.select(air.id)?.activeConnection)
        assertNull(registry.select("missing"))
        assertEquals(pro, registry.select(air.id)?.remove(air.id)?.activeConnection)
    }

    @Test
    fun matchingUsesAdvertisedRoutesNotTheDisplayName() {
        val sameComputerNewPairing = Connection(
            id = "new-id",
            name = "Renamed laptop",
            host = "air.local",
            port = 8810,
        )
        val registry = ConnectionRegistry(listOf(air, pro), air.id)

        assertEquals(air, registry.matchingConnection(sameComputerNewPairing))
        assertNull(registry.matchingConnection(Connection(name = air.name, host = "third.local", port = 8810)))
    }

    @Test
    fun restoringNormalizesBadPersistedSelectionAndDuplicates() {
        val raw = CompanionJson.encodeToString(
            ConnectionRegistry(connections = listOf(air, air, pro), activeConnectionId = "missing"),
        )
        val decoded = CompanionJson.decodeFromString<ConnectionRegistry>(raw).normalized()

        assertEquals(listOf(air, pro), decoded.connections)
        assertEquals(air, decoded.activeConnection)
    }

    @Test
    fun compatibilityStoreExposesItsSingleConnectionAsARegistry() = kotlinx.coroutines.test.runTest {
        val legacy = object : ConnectionStore {
            override suspend fun load(): Connection = air
            override suspend fun save(connection: Connection) = Unit
            override suspend fun clear() = Unit
        }

        val restored = legacy.loadRegistry()
        assertFalse(restored.migratedLegacyConnection)
        assertEquals(air, restored.registry.activeConnection)
        assertFalse(restored.registry.connections.isEmpty())
    }
}
