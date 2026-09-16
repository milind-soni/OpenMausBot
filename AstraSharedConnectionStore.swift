import CompanionCore
import Foundation

/// Where a restored registry was found. This makes the migration decision a
/// pure value operation which can be unit-tested without mutating defaults.
enum AstraConnectionRegistrySource: Equatable {
    case sharedRegistry
    case fallbackRegistry
    case legacyConnection
    case empty
}

struct AstraConnectionRegistryResolution: Equatable {
    let registry: CompanionConnectionRegistry
    let source: AstraConnectionRegistrySource
}

/// Non-secret pairing metadata shared with extensions.
///
/// Tokens never enter defaults; they live in `AstraSharedKeychain`. The
/// standard suite is dual-written as a compatibility fallback so an unsigned
/// preview or a temporary App Group entitlement mistake cannot erase the
/// non-secret connection list. Pairing tokens intentionally migrate forward
/// into the shared Keychain group; downgrading across that migration may
/// require pairing again.
enum AstraSharedConnectionStore {
    static let registryKey = "companion.connections.v1"
    static let legacyConnectionKey = "companion.connection"

    static func resolve(
        sharedRegistryData: Data?,
        fallbackRegistryData: Data?,
        legacyConnectionData: Data?
    ) -> AstraConnectionRegistryResolution {
        let decoder = JSONDecoder()
        if let sharedRegistryData,
           let registry = try? decoder.decode(
               CompanionConnectionRegistry.self,
               from: sharedRegistryData
           ) {
            return AstraConnectionRegistryResolution(
                registry: registry,
                source: .sharedRegistry
            )
        }
        if let fallbackRegistryData,
           let registry = try? decoder.decode(
               CompanionConnectionRegistry.self,
               from: fallbackRegistryData
           ) {
            return AstraConnectionRegistryResolution(
                registry: registry,
                source: .fallbackRegistry
            )
        }
        let legacy = CompanionConnectionRegistryMigration.restore(
            registryData: nil,
            legacyConnectionData: legacyConnectionData
        )
        return AstraConnectionRegistryResolution(
            registry: legacy.registry,
            source: legacy.migratedLegacyConnection ? .legacyConnection : .empty
        )
    }

    /// Load the registry, preferring the app-group copy and migrating older
    /// app-only storage into it on first use.
    static func loadRegistry(
        sharedDefaults: UserDefaults? = AstraSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard
    ) -> CompanionConnectionRegistry {
        let resolution = resolve(
            sharedRegistryData: sharedDefaults?.data(forKey: registryKey),
            fallbackRegistryData: fallbackDefaults.data(forKey: registryKey),
            legacyConnectionData: fallbackDefaults.data(forKey: legacyConnectionKey)
        )
        if resolution.source != .sharedRegistry {
            saveRegistry(
                resolution.registry,
                sharedDefaults: sharedDefaults,
                fallbackDefaults: fallbackDefaults
            )
        }
        return resolution.registry
    }

    static func loadActiveConnection(
        sharedDefaults: UserDefaults? = AstraSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard
    ) -> Connection? {
        loadRegistry(
            sharedDefaults: sharedDefaults,
            fallbackDefaults: fallbackDefaults
        ).activeConnection
    }

    static func saveRegistry(
        _ registry: CompanionConnectionRegistry,
        sharedDefaults: UserDefaults? = AstraSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard
    ) {
        guard !registry.connections.isEmpty else {
            sharedDefaults?.removeObject(forKey: registryKey)
            fallbackDefaults.removeObject(forKey: registryKey)
            sharedDefaults?.removeObject(forKey: legacyConnectionKey)
            fallbackDefaults.removeObject(forKey: legacyConnectionKey)
            return
        }
        guard let encoded = try? JSONEncoder().encode(registry) else { return }
        sharedDefaults?.set(encoded, forKey: registryKey)
        fallbackDefaults.set(encoded, forKey: registryKey)
        // The registry is now the safe fallback too, so the obsolete
        // single-computer record can no longer resurrect a forgotten Mac.
        sharedDefaults?.removeObject(forKey: legacyConnectionKey)
        fallbackDefaults.removeObject(forKey: legacyConnectionKey)
    }
}
