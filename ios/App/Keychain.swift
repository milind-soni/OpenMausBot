// Device tokens, in the keychain.
//
// The token is the whole credential: anyone holding it can talk to the
// user's harness, which runs shell commands on their laptop. UserDefaults
// would be wrong for it, and so would anything that lands in an iCloud or
// iTunes backup — hence `ThisDeviceOnly`, which also matches the server's
// model, where a token belongs to one paired device and is revoked per
// device.
import Foundation
import Security

enum Keychain {
    private static let service = "com.openmausbot.companion.token"

    static func save(_ token: String, for connectionId: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        // Add first, and only delete when the add says something is already
        // there. Deleting up front is the tidier-looking order and it is the
        // wrong one: if the add then fails — the device locked before first
        // unlock, the keychain is unavailable mid-restore — the old token is
        // already gone, and the phone is signed out of a computer it was
        // perfectly able to reach a second ago. The failure this guards is
        // the one where re-pairing hurts, because the user has to walk to the
        // machine to get a new code.
        var status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // Update in place rather than delete-then-add: it is one atomic
            // step, so there is no window in which no token exists at all.
            let identity: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: connectionId,
            ]
            status = SecItemUpdate(
                identity as CFDictionary,
                [
                    kSecValueData as String: data,
                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                ] as CFDictionary
            )
            // An item that exists for `add` and is missing for `update` means
            // something else removed it in between. Adding again is the whole
            // recovery, and by now nothing is being lost by trying.
            if status == errSecItemNotFound {
                status = SecItemAdd(query as CFDictionary, nil)
            }
        }
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        // An item that is present but unreadable is a corrupt store, not an
        // absent pairing — say so rather than silently re-pairing.
        guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainError(status: errSecDecode)
        }
        return token
    }

    @discardableResult
    static func remove(_ connectionId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionId,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return "Couldn't access the pairing securely: \(detail)"
    }

    /// The keychain is not available *yet* rather than not holding this token.
    /// True in the window after a reboot before the first unlock, when the
    /// right move is to wait rather than to treat the phone as unpaired.
    var isLocked: Bool {
        status == errSecInteractionNotAllowed
    }
}
