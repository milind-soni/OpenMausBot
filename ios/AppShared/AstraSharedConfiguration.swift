import Foundation

/// Values shared by the main app and its extensions.
///
/// Keep the group identifier in one source file rather than repeating it in
/// the app and extension. The matching capabilities still live in the Xcode
/// project, where iOS verifies them against the provisioning profile.
enum AstraSharedConfiguration {
    static let appGroupIdentifier = "group.com.astra.shared"
    static let legacyAppBundleIdentifier = "com.astra.app"
    static let keychainAccessGroupInfoKey = "AstraKeychainAccessGroup"

    /// The shared suite can be unavailable in unsigned previews and local
    /// tests. Callers which need compatibility with an already-installed app
    /// retain `UserDefaults.standard` as a fallback instead of treating that
    /// development-only state as data loss.
    static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }

    /// Xcode expands `$(AppIdentifierPrefix)` in this Info.plist value. A
    /// fully-qualified value is required by `kSecAttrAccessGroup`; using the
    /// unprefixed group name fails with `errSecMissingEntitlement` on-device.
    static var keychainAccessGroup: String? {
        guard let value = Bundle.main.object(
            forInfoDictionaryKey: keychainAccessGroupInfoKey
        ) as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        return trimmed
    }

    /// Existing releases wrote tokens into the application's default group,
    /// whose fully-qualified name is the signing prefix plus its bundle id.
    /// Derive the same prefix from the configured shared group so migration
    /// remains correct even after adding a second keychain entitlement.
    static var legacyAppKeychainAccessGroup: String? {
        guard let shared = keychainAccessGroup,
              shared.hasSuffix(appGroupIdentifier) else { return nil }
        let prefix = shared.dropLast(appGroupIdentifier.count)
        return "\(prefix)\(legacyAppBundleIdentifier)"
    }
}
