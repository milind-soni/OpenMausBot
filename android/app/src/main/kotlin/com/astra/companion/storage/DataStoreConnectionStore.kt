package com.astra.companion.storage

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.astra.companion.core.CompanionJson
import com.astra.companion.core.Connection
import com.astra.companion.core.ConnectionRegistry
import com.astra.companion.core.ConnectionRegistryRestore
import com.astra.companion.core.ConnectionStore
import kotlinx.coroutines.flow.first
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

private val Context.connectionDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "companion_connection",
)

class DataStoreConnectionStore(
    private val dataStore: DataStore<Preferences>,
) : ConnectionStore {
    constructor(context: Context) : this(context.applicationContext.connectionDataStore)

    override suspend fun load(): Connection? {
        val raw = dataStore.data.first()[KEY] ?: return null
        return runCatching { CompanionJson.decodeFromString<Connection>(raw) }.getOrNull()
    }

    override suspend fun save(connection: Connection) {
        // Never write KEY: a legacy record left beside a later-corrupt v1
        // would resurrect a computer the user may have removed. One edit so
        // the upsert and the KEY wipe commit together.
        dataStore.edit { prefs ->
            writeRegistry(prefs, restoreFrom(prefs).registry.upsert(connection))
        }
    }

    override suspend fun clear() {
        clearRegistry()
    }

    /**
     * v1 is an index only; its records deliberately contain no device tokens.
     * On the first multi-computer build an old single record is lifted and then
     * the old key is removed in the same DataStore transaction as the v1 write.
     */
    override suspend fun loadRegistry(): ConnectionRegistryRestore {
        return restoreFrom(dataStore.data.first())
    }

    override suspend fun saveRegistry(registry: ConnectionRegistry) {
        dataStore.edit { prefs -> writeRegistry(prefs, registry) }
    }

    override suspend fun clearRegistry() {
        dataStore.edit { prefs ->
            prefs.remove(REGISTRY_KEY)
            prefs.remove(KEY)
        }
    }

    private fun restoreFrom(prefs: Preferences): ConnectionRegistryRestore {
        val current = prefs[REGISTRY_KEY]?.let { raw ->
            runCatching {
                CompanionJson.decodeFromString<ConnectionRegistry>(raw).normalized()
            }.getOrNull()
        }
        if (current != null) return ConnectionRegistryRestore(current, migratedLegacyConnection = false)

        val legacy = prefs[KEY]?.let { raw ->
            runCatching { CompanionJson.decodeFromString<Connection>(raw) }.getOrNull()
        }
        return if (legacy == null) {
            ConnectionRegistryRestore(ConnectionRegistry(), migratedLegacyConnection = false)
        } else {
            ConnectionRegistryRestore(
                ConnectionRegistry.restoring(listOf(legacy), legacy.id),
                migratedLegacyConnection = true,
            )
        }
    }

    private fun writeRegistry(prefs: MutablePreferences, registry: ConnectionRegistry) {
        val normalized = registry.normalized()
        if (normalized.connections.isEmpty()) {
            prefs.remove(REGISTRY_KEY)
        } else {
            prefs[REGISTRY_KEY] = CompanionJson.encodeToString(normalized)
        }
        // Once a registry has been written it is authoritative: preserving
        // the legacy record would make a future corrupt v1 decode silently
        // resurrect a computer the user had removed.
        prefs.remove(KEY)
    }

    companion object {
        /** Previous single-computer record, kept only for one-way migration. */
        val KEY = stringPreferencesKey("companion.connection")
        val REGISTRY_KEY = stringPreferencesKey("companion.connections.v1")
    }
}
