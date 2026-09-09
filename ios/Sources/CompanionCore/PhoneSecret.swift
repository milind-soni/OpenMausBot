import CryptoKit
import Foundation

public enum PhoneSecretError: Error, LocalizedError, Equatable, Sendable {
    case unavailable
    case insecureTransport
    case invalidRequest
    case invalidPublicKey
    case invalidCredential
    case encryptionFailed

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "Pair this phone again by QR code to enable secure credential entry."
        case .insecureTransport:
            return "Use secure phone access or Tailscale before sending a credential from this phone."
        case .invalidRequest:
            return "This credential request is no longer valid."
        case .invalidPublicKey:
            return "This computer’s secure pairing key is invalid. Pair it again."
        case .invalidCredential:
            return "Enter a credential between 1 and 4096 bytes."
        case .encryptionFailed:
            return "The credential could not be encrypted for this computer. Pair it again and retry."
        }
    }
}

/// The only phone-to-desktop credential wire format. It uses the RFC 9180
/// suite built into CryptoKit on iOS 17: P-256, HKDF-SHA256 and AES-GCM-256.
/// The companion relay receives these fields but cannot open `ciphertext`.
public struct PhoneSecretEnvelope: Codable, Equatable, Sendable {
    public let version: Int
    public let threadId: String
    public let keyId: String
    public let deviceId: String
    public let target: String
    public let requestKey: String
    public let encapsulatedKey: String
    public let ciphertext: String
}

public struct PhoneSecretRequestContext: Equatable, Sendable {
    public let deviceId: String
    public let botId: String
    public let threadId: String
    public let messageId: String
    public let target: String
    public let requestKey: String

    public init(
        deviceId: String,
        botId: String,
        threadId: String,
        messageId: String,
        target: String,
        requestKey: String
    ) {
        self.deviceId = deviceId
        self.botId = botId
        self.threadId = threadId
        self.messageId = messageId
        self.target = target
        self.requestKey = requestKey
    }
}

public enum PhoneSecretCrypto {
    public static let version = 1
    public static let maximumCredentialBytes = 4_096
    public static let info = "OpenMausBot phone credential v1"

    /// Validate and return the canonical unpadded base64url P-256 point used
    /// in a QR. This function deliberately works below the HPKE availability
    /// floor so pairing/model tests can still run with CompanionCore's macOS
    /// 13 package target; the app itself deploys to iOS 17.
    public static func normalizedPublicKey(_ encoded: String) -> String? {
        guard let raw = decodeBase64URL(encoded),
              raw.count == 65,
              raw.first == 4,
              (try? P256.KeyAgreement.PublicKey(x963Representation: raw)) != nil,
              encodeBase64URL(raw) == encoded
        else { return nil }
        return encoded
    }

    public static func publicKeyId(_ encoded: String) throws -> String {
        guard let normalized = normalizedPublicKey(encoded),
              let raw = decodeBase64URL(normalized)
        else { throw PhoneSecretError.invalidPublicKey }
        return encodeBase64URL(Data(SHA256.hash(data: raw).prefix(16)))
    }

    public static func authenticatedData(
        keyId: String,
        context: PhoneSecretRequestContext
    ) throws -> Data {
        guard isBase64URL(keyId, count: 22),
              [context.deviceId, context.botId, context.threadId, context.messageId, context.requestKey]
                .allSatisfy({ isRouteID($0) }),
              isTargetID(context.target)
        else { throw PhoneSecretError.invalidRequest }
        return Data([
            "openmausbot-phone-credential-v1",
            keyId,
            context.deviceId,
            context.botId,
            context.threadId,
            context.messageId,
            context.target,
            context.requestKey,
        ].joined(separator: "\n").utf8)
    }

    @available(iOS 17.0, macOS 14.0, *)
    public static func encrypt(
        _ rawValue: String,
        publicKey encodedPublicKey: String,
        context: PhoneSecretRequestContext
    ) throws -> PhoneSecretEnvelope {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let plaintext = Data(value.utf8)
        guard !plaintext.isEmpty, plaintext.count <= maximumCredentialBytes else {
            throw PhoneSecretError.invalidCredential
        }
        guard let normalized = normalizedPublicKey(encodedPublicKey),
              let publicKeyData = decodeBase64URL(normalized)
        else { throw PhoneSecretError.invalidPublicKey }

        do {
            let key = try P256.KeyAgreement.PublicKey(x963Representation: publicKeyData)
            let keyId = try publicKeyId(normalized)
            let aad = try authenticatedData(keyId: keyId, context: context)
            var sender = try HPKE.Sender(
                recipientKey: key,
                ciphersuite: .P256_SHA256_AES_GCM_256,
                info: Data(info.utf8)
            )
            let ciphertext = try sender.seal(plaintext, authenticating: aad)
            return PhoneSecretEnvelope(
                version: version,
                threadId: context.threadId,
                keyId: keyId,
                deviceId: context.deviceId,
                target: context.target,
                requestKey: context.requestKey,
                encapsulatedKey: encodeBase64URL(sender.encapsulatedKey),
                ciphertext: encodeBase64URL(ciphertext)
            )
        } catch let error as PhoneSecretError {
            throw error
        } catch {
            throw PhoneSecretError.encryptionFailed
        }
    }

    private static func isRouteID(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 128 else { return false }
        return value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) ||
                (97...122).contains(byte) || byte == 45 || byte == 95
        }
    }

    private static func isTargetID(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard let first = bytes.first, bytes.count <= 64,
              (65...90).contains(first) || (97...122).contains(first)
        else { return false }
        return bytes.dropFirst().allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
        }
    }

    private static func isBase64URL(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) ||
                (97...122).contains(byte) || byte == 45 || byte == 95
        }
    }

    private static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        guard !value.isEmpty,
              value.utf8.allSatisfy({ byte in
                  (48...57).contains(byte) || (65...90).contains(byte) ||
                      (97...122).contains(byte) || byte == 45 || byte == 95
              })
        else { return nil }
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }
}
