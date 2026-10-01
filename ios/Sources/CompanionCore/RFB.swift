// The client half of RFB (the VNC protocol), as far as the phone needs it to
// look at and drive a bot's Local VM through the sidecar's viewer relay.
//
// This is the protocol only: bytes in, bytes out, and a framebuffer. The
// WebSocket that carries it lives in the app, which is what keeps this
// testable byte for byte with `swift test`.
//
// Deliberately small. It speaks 3.3, 3.7 and 3.8; offers None and VNC
// authentication; asks the server for 32-bit little-endian BGRX pixels so the
// framebuffer is already in the layout Core Graphics wants; and understands
// Raw, CopyRect and DesktopSize. Raw is what every server can send, and on the
// LAN or a tailnet it is fine. A compressed encoding is the obvious next step
// for cellular, and the place it would slot in is `rectangleLength`.
import CommonCrypto
import Foundation

public enum RFBError: Error, Equatable, LocalizedError, Sendable {
    case unsupportedVersion(String)
    case noUsableSecurity([UInt8])
    case passwordRequired
    case authenticationFailed(String)
    case unsupportedEncoding(Int32)
    case unexpectedMessage(UInt8)
    case malformed(String)

    public var errorDescription: String? {
        switch self {
        case let .unsupportedVersion(version): return "The desktop speaks an unsupported VNC version (\(version))."
        case .noUsableSecurity: return "The desktop asked for a sign-in method this app does not support."
        case .passwordRequired: return "The desktop asked for a password the computer did not provide."
        case let .authenticationFailed(reason): return reason.isEmpty ? "The desktop refused the connection." : reason
        case let .unsupportedEncoding(encoding): return "The desktop sent an unsupported picture format (\(encoding))."
        case let .unexpectedMessage(type): return "The desktop sent an unexpected message (\(type))."
        case let .malformed(what): return "The desktop sent a malformed \(what)."
        }
    }
}

/// X11 keysyms for the keys a phone keyboard can produce beyond printable
/// characters.
public enum RFBKey {
    public static let backspace: UInt32 = 0xFF08
    public static let tab: UInt32 = 0xFF09
    public static let returnKey: UInt32 = 0xFF0D
    public static let escape: UInt32 = 0xFF1B
    public static let delete: UInt32 = 0xFFFF
    public static let left: UInt32 = 0xFF51
    public static let up: UInt32 = 0xFF52
    public static let right: UInt32 = 0xFF53
    public static let down: UInt32 = 0xFF54
    public static let shift: UInt32 = 0xFFE1
    public static let control: UInt32 = 0xFFE3
    public static let alt: UInt32 = 0xFFE9
    public static let superKey: UInt32 = 0xFFEB

    /// The keysym for one typed character: Latin-1 maps to itself, a newline
    /// is Return, and everything else uses the Unicode keysym range.
    public static func keysym(for character: Character) -> UInt32? {
        if character == "\n" || character == "\r\n" { return returnKey }
        if character == "\t" { return tab }
        guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first else { return nil }
        let value = scalar.value
        if (0x20...0x7E).contains(value) || (0xA0...0xFF).contains(value) { return value }
        if value < 0x20 || value == 0x7F { return nil }
        return 0x0100_0000 | value
    }
}

/// Mouse buttons in RFB's pointer mask.
public struct RFBButtons: OptionSet, Sendable, Hashable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }
    public static let left = RFBButtons(rawValue: 1)
    public static let middle = RFBButtons(rawValue: 2)
    public static let right = RFBButtons(rawValue: 4)
    public static let scrollUp = RFBButtons(rawValue: 8)
    public static let scrollDown = RFBButtons(rawValue: 16)
    public static let scrollLeft = RFBButtons(rawValue: 32)
    public static let scrollRight = RFBButtons(rawValue: 64)
}

public enum RFBEvent: Equatable, Sendable {
    /// The handshake finished; the framebuffer has this size.
    case connected(width: Int, height: Int, name: String)
    /// One FramebufferUpdate was applied. `resized` when its size changed.
    case updated(resized: Bool)
    case bell
    case clipboard(String)
}

public final class RFBClient {
    private enum Phase {
        case version
        case securityTypes
        case securityType33
        case challenge
        case securityResult
        case serverInit
        case normal
    }

    static let encodingRaw: Int32 = 0
    static let encodingCopyRect: Int32 = 1
    static let encodingDesktopSize: Int32 = -223

    private let password: String?
    private var phase = Phase.version
    private var minor = 8
    private var pending = Data()
    private var outgoing = Data()

    public private(set) var width = 0
    public private(set) var height = 0
    public private(set) var name = ""
    /// 32-bit little-endian BGRX, row-major, `width * 4` bytes per row.
    public private(set) var framebuffer: [UInt8] = []

    public var isConnected: Bool { phase == .normal }

    public init(password: String?) {
        self.password = password
    }

    /// Bytes to send, in order. Draining clears them.
    public func takeOutgoing() -> Data {
        defer { outgoing.removeAll(keepingCapacity: true) }
        return outgoing
    }

    /// Feed bytes from the server. Returns what happened, in order; throws
    /// when the session cannot continue.
    @discardableResult
    public func receive(_ data: Data) throws -> [RFBEvent] {
        pending.append(data)
        var events: [RFBEvent] = []
        while let event = try step() {
            if case .some(let happened) = event { events.append(happened) }
        }
        return events
    }

    // MARK: - Input

    public func pointer(x: Int, y: Int, buttons: RFBButtons) {
        guard isConnected else { return }
        var message = Data([5, buttons.rawValue])
        message.appendUInt16(UInt16(clamping: max(0, min(x, width - 1))))
        message.appendUInt16(UInt16(clamping: max(0, min(y, height - 1))))
        outgoing.append(message)
    }

    public func key(_ keysym: UInt32, down: Bool) {
        guard isConnected else { return }
        var message = Data([4, down ? 1 : 0, 0, 0])
        message.appendUInt32(keysym)
        outgoing.append(message)
    }

    /// Press and release, for typed text.
    public func tap(_ keysym: UInt32) {
        key(keysym, down: true)
        key(keysym, down: false)
    }

    public func requestUpdate(incremental: Bool = true) {
        guard isConnected else { return }
        var message = Data([3, incremental ? 1 : 0])
        message.appendUInt16(0)
        message.appendUInt16(0)
        message.appendUInt16(UInt16(clamping: width))
        message.appendUInt16(UInt16(clamping: height))
        outgoing.append(message)
    }

    // MARK: - Protocol

    /// One message, if enough bytes are here. `nil` means wait for more;
    /// `.some(nil)` means a message was handled with nothing to report.
    private func step() throws -> RFBEvent?? {
        switch phase {
        case .version:
            guard pending.count >= 12 else { return nil }
            let text = String(decoding: pending.prefix(12), as: UTF8.self)
            consume(12)
            guard text.hasPrefix("RFB "), text.hasSuffix("\n"),
                  let major = Int(text.dropFirst(4).prefix(3)), let serverMinor = Int(text.dropFirst(8).prefix(3)),
                  major == 3
            else { throw RFBError.unsupportedVersion(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
            // 3.3, 3.7 and 3.8 are the versions there are; a higher minor
            // from a newer server is answered with the newest we speak.
            minor = serverMinor >= 8 ? 8 : serverMinor >= 7 ? 7 : 3
            outgoing.append(Data("RFB 003.00\(minor)\n".utf8))
            phase = minor == 3 ? .securityType33 : .securityTypes
            return .some(nil)

        case .securityType33:
            guard pending.count >= 4 else { return nil }
            let type = pending.readUInt32(at: 0)
            if type == 0 {
                guard let reason = try reasonString(at: 4) else { return nil }
                throw RFBError.authenticationFailed(reason)
            }
            consume(4)
            switch type {
            case 1: return try finishSecurity()
            case 2:
                guard password != nil else { throw RFBError.passwordRequired }
                phase = .challenge
                return .some(nil)
            default: throw RFBError.noUsableSecurity([UInt8(truncatingIfNeeded: type)])
            }

        case .securityTypes:
            guard let count = pending.first else { return nil }
            if count == 0 {
                guard let reason = try reasonString(at: 1) else { return nil }
                throw RFBError.authenticationFailed(reason)
            }
            guard pending.count >= 1 + Int(count) else { return nil }
            let offered = Array(pending[pending.startIndex + 1 ..< pending.startIndex + 1 + Int(count)])
            consume(1 + Int(count))
            if offered.contains(2), password != nil {
                outgoing.append(Data([2]))
                phase = .challenge
            } else if offered.contains(1) {
                outgoing.append(Data([1]))
                // 3.7 sends no SecurityResult after None.
                return minor == 8 ? waitForResult() : try finishSecurity()
            } else if offered.contains(2) {
                throw RFBError.passwordRequired
            } else {
                throw RFBError.noUsableSecurity(offered)
            }
            return .some(nil)

        case .challenge:
            guard pending.count >= 16 else { return nil }
            let challenge = Data(pending.prefix(16))
            consume(16)
            outgoing.append(try Self.vncAuthResponse(challenge: challenge, password: password ?? ""))
            return waitForResult()

        case .securityResult:
            guard pending.count >= 4 else { return nil }
            let result = pending.readUInt32(at: 0)
            if result != 0 {
                // Only 3.8 explains itself.
                if minor == 8 {
                    guard let reason = try reasonString(at: 4) else { return nil }
                    throw RFBError.authenticationFailed(reason)
                }
                throw RFBError.authenticationFailed("")
            }
            consume(4)
            return try finishSecurity()

        case .serverInit:
            guard pending.count >= 24 else { return nil }
            let nameLength = Int(pending.readUInt32(at: 20))
            guard nameLength <= 4096 else { throw RFBError.malformed("desktop name") }
            guard pending.count >= 24 + nameLength else { return nil }
            width = Int(pending.readUInt16(at: 0))
            height = Int(pending.readUInt16(at: 2))
            name = String(decoding: pending.subdata(in: pending.startIndex + 24 ..< pending.startIndex + 24 + nameLength), as: UTF8.self)
            consume(24 + nameLength)
            framebuffer = [UInt8](repeating: 0, count: width * height * 4)
            phase = .normal
            sendSetPixelFormat()
            sendSetEncodings()
            requestUpdate(incremental: false)
            return .some(.connected(width: width, height: height, name: name))

        case .normal:
            guard let type = pending.first else { return nil }
            switch type {
            case 0: return try framebufferUpdate()
            case 1:
                // SetColourMapEntries: never asked for with true colour; skip.
                guard pending.count >= 6 else { return nil }
                let length = 6 + Int(pending.readUInt16(at: 4)) * 6
                guard pending.count >= length else { return nil }
                consume(length)
                return .some(nil)
            case 2:
                consume(1)
                return .some(.bell)
            case 3:
                guard pending.count >= 8 else { return nil }
                let length = Int(pending.readUInt32(at: 4))
                guard length <= 1 << 20 else { throw RFBError.malformed("clipboard") }
                guard pending.count >= 8 + length else { return nil }
                // ServerCutText is Latin-1 by definition.
                let bytes = pending.subdata(in: pending.startIndex + 8 ..< pending.startIndex + 8 + length)
                let text = String(data: bytes, encoding: .isoLatin1) ?? ""
                consume(8 + length)
                return .some(.clipboard(text))
            default:
                throw RFBError.unexpectedMessage(type)
            }
        }
    }

    private func waitForResult() -> RFBEvent?? {
        phase = .securityResult
        return .some(nil)
    }

    private func finishSecurity() throws -> RFBEvent?? {
        // ClientInit: share the desktop, so the bot's own session survives.
        outgoing.append(Data([1]))
        phase = .serverInit
        return .some(nil)
    }

    /// A length-prefixed reason at `offset`, or nil until it has arrived.
    private func reasonString(at offset: Int) throws -> String? {
        guard pending.count >= offset + 4 else { return nil }
        let length = Int(pending.readUInt32(at: offset))
        guard length <= 4096 else { throw RFBError.malformed("refusal") }
        guard pending.count >= offset + 4 + length else { return nil }
        return String(decoding: pending.subdata(in: pending.startIndex + offset + 4 ..< pending.startIndex + offset + 4 + length), as: UTF8.self)
    }

    /// A whole FramebufferUpdate, applied only once every rectangle has
    /// arrived, so a partial message never leaves half a picture.
    private func framebufferUpdate() throws -> RFBEvent?? {
        guard pending.count >= 4 else { return nil }
        let count = Int(pending.readUInt16(at: 2))
        var offset = 4
        var rects: [(x: Int, y: Int, w: Int, h: Int, encoding: Int32, data: Int)] = []
        for _ in 0 ..< count {
            guard pending.count >= offset + 12 else { return nil }
            let x = Int(pending.readUInt16(at: offset))
            let y = Int(pending.readUInt16(at: offset + 2))
            let w = Int(pending.readUInt16(at: offset + 4))
            let h = Int(pending.readUInt16(at: offset + 6))
            let encoding = Int32(bitPattern: pending.readUInt32(at: offset + 8))
            let body = try rectangleLength(width: w, height: h, encoding: encoding)
            guard pending.count >= offset + 12 + body else { return nil }
            rects.append((x, y, w, h, encoding, offset + 12))
            offset += 12 + body
        }
        var resized = false
        for rect in rects {
            switch rect.encoding {
            case Self.encodingDesktopSize:
                width = rect.w
                height = rect.h
                framebuffer = [UInt8](repeating: 0, count: width * height * 4)
                resized = true
            case Self.encodingCopyRect:
                let sourceX = Int(pending.readUInt16(at: rect.data))
                let sourceY = Int(pending.readUInt16(at: rect.data + 2))
                copyRect(x: rect.x, y: rect.y, w: rect.w, h: rect.h, fromX: sourceX, fromY: sourceY)
            default:
                blit(x: rect.x, y: rect.y, w: rect.w, h: rect.h, at: rect.data)
            }
        }
        consume(offset)
        // Keep the picture coming: one incremental request per update.
        requestUpdate(incremental: true)
        return .some(.updated(resized: resized))
    }

    private func rectangleLength(width w: Int, height h: Int, encoding: Int32) throws -> Int {
        switch encoding {
        case Self.encodingRaw: return w * h * 4
        case Self.encodingCopyRect: return 4
        case Self.encodingDesktopSize: return 0
        default: throw RFBError.unsupportedEncoding(encoding)
        }
    }

    private func blit(x: Int, y: Int, w: Int, h: Int, at offset: Int) {
        guard w > 0, h > 0 else { return }
        pending.withUnsafeBytes { raw in
            let source = raw.baseAddress!.advanced(by: offset).assumingMemoryBound(to: UInt8.self)
            framebuffer.withUnsafeMutableBufferPointer { target in
                for row in 0 ..< h where y + row < height {
                    let columns = max(0, min(w, width - x))
                    guard columns > 0 else { continue }
                    let from = source.advanced(by: row * w * 4)
                    let to = target.baseAddress!.advanced(by: ((y + row) * width + x) * 4)
                    to.update(from: from, count: columns * 4)
                }
            }
        }
    }

    private func copyRect(x: Int, y: Int, w: Int, h: Int, fromX: Int, fromY: Int) {
        guard w > 0, h > 0, x + w <= width, y + h <= height, fromX + w <= width, fromY + h <= height else { return }
        let rowBytes = w * 4
        let copy = framebuffer
        for row in 0 ..< h {
            let from = ((fromY + row) * width + fromX) * 4
            let to = ((y + row) * width + x) * 4
            framebuffer.replaceSubrange(to ..< to + rowBytes, with: copy[from ..< from + rowBytes])
        }
    }

    private func sendSetPixelFormat() {
        var message = Data([0, 0, 0, 0])
        // 32 bpp, depth 24, little-endian, true colour, 8 bits per channel,
        // red at 16, green at 8, blue at 0: BGRX in memory.
        message.append(contentsOf: [32, 24, 0, 1])
        message.appendUInt16(255)
        message.appendUInt16(255)
        message.appendUInt16(255)
        message.append(contentsOf: [16, 8, 0, 0, 0, 0])
        outgoing.append(message)
    }

    private func sendSetEncodings() {
        let encodings = [Self.encodingCopyRect, Self.encodingRaw, Self.encodingDesktopSize]
        var message = Data([2, 0])
        message.appendUInt16(UInt16(encodings.count))
        for encoding in encodings { message.appendUInt32(UInt32(bitPattern: encoding)) }
        outgoing.append(message)
    }

    private func consume(_ count: Int) {
        pending.removeFirst(count)
    }

    /// VNC authentication: DES-encrypt the 16-byte challenge with the first
    /// eight bytes of the password, each byte's bits reversed (the protocol's
    /// historical quirk).
    static func vncAuthResponse(challenge: Data, password: String) throws -> Data {
        var key = [UInt8](repeating: 0, count: 8)
        for (index, byte) in Array(password.utf8.prefix(8)).enumerated() {
            var reversed: UInt8 = 0
            for bit in 0 ..< 8 where byte & (1 << bit) != 0 { reversed |= 1 << (7 - bit) }
            key[index] = reversed
        }
        var output = [UInt8](repeating: 0, count: 16)
        var written = 0
        let status = challenge.withUnsafeBytes { input in
            CCCrypt(
                CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmDES), CCOptions(kCCOptionECBMode),
                key, kCCKeySizeDES, nil,
                input.baseAddress, 16,
                &output, 16, &written
            )
        }
        guard status == kCCSuccess, written == 16 else { throw RFBError.malformed("authentication challenge") }
        return Data(output)
    }
}

private extension Data {
    func readUInt16(at offset: Int) -> UInt16 {
        let base = startIndex + offset
        return UInt16(self[base]) << 8 | UInt16(self[base + 1])
    }

    func readUInt32(at offset: Int) -> UInt32 {
        let base = startIndex + offset
        return UInt32(self[base]) << 24 | UInt32(self[base + 1]) << 16 | UInt32(self[base + 2]) << 8 | UInt32(self[base + 3])
    }

    mutating func appendUInt16(_ value: UInt16) {
        append(contentsOf: [UInt8(value >> 8), UInt8(value & 0xFF)])
    }

    mutating func appendUInt32(_ value: UInt32) {
        append(contentsOf: [UInt8(value >> 24), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)])
    }
}
