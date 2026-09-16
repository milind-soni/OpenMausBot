/// Main-app compatibility facade. The implementation lives in AppShared so
/// trusted extensions see the same credential rather than a target-private
/// keychain item.
enum Keychain {
    static func save(_ token: String, for connectionId: String) throws {
        try AstraSharedKeychain.save(token, for: connectionId)
    }

    /// The stored token: nil only when there genuinely is not one.
    ///
    /// The distinction between "no token" and "cannot read the token" matters
    /// far more than it looks. `SecItemCopyMatching` answers
    /// `errSecInteractionNotAllowed` while the keychain is unavailable — the
    /// window after a reboot before the phone's first unlock, which is exactly
    /// when iOS starts apps in the background. Folding that into nil made it
    /// indistinguishable from "this phone was never paired", so the app
    /// discarded a perfectly good connection and showed the pairing screen to
    /// someone who had done nothing but restart their phone. Getting back in
    /// means walking to the computer for a new code.
    ///
    /// So: `errSecItemNotFound` is the only nil. Everything else throws, and
    /// the caller decides whether to wait or to give up.
    static func token(for connectionId: String) throws -> String? {
        try AstraSharedKeychain.tokenMigratingLegacyItem(for: connectionId)
    }

    @discardableResult
    static func remove(_ connectionId: String) -> Bool {
        AstraSharedKeychain.removeIncludingLegacyItem(connectionId)
    }
}

typealias KeychainError = AstraSharedKeychainError
