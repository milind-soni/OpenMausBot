// The VNC client's protocol half, byte for byte: handshake, authentication,
// the picture, and input. No sockets.
import XCTest
@testable import CompanionCore

final class RFBTests: XCTestCase {
    private func serverInit(width: UInt16, height: UInt16, name: String = "VM") -> Data {
        var data = Data()
        data.append(contentsOf: [UInt8(width >> 8), UInt8(width & 0xFF), UInt8(height >> 8), UInt8(height & 0xFF)])
        data.append(contentsOf: [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
        let bytes = Array(name.utf8)
        data.append(contentsOf: [0, 0, UInt8(bytes.count >> 8), UInt8(bytes.count & 0xFF)])
        data.append(contentsOf: bytes)
        return data
    }

    private func u16(_ value: Int) -> [UInt8] { [UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)] }
    private func s32(_ value: Int32) -> [UInt8] {
        let bits = UInt32(bitPattern: value)
        return [UInt8(bits >> 24), UInt8(bits >> 16 & 0xFF), UInt8(bits >> 8 & 0xFF), UInt8(bits & 0xFF)]
    }

    /// A client through the 3.8 handshake with no password, framebuffer `w`×`h`.
    private func connected(width: Int = 4, height: Int = 3) throws -> RFBClient {
        let client = RFBClient(password: nil)
        try client.receive(Data("RFB 003.008\n".utf8))
        try client.receive(Data([1, 1]))
        try client.receive(Data([0, 0, 0, 0]))
        let events = try client.receive(serverInit(width: UInt16(width), height: UInt16(height)))
        XCTAssertEqual(events, [.connected(width: width, height: height, name: "VM")])
        _ = client.takeOutgoing()
        return client
    }

    func testNegotiates38WithoutAPasswordAndAsksForBGRXPixels() throws {
        let client = RFBClient(password: nil)
        XCTAssertEqual(try client.receive(Data("RFB 003.008\n".utf8)), [])
        XCTAssertEqual(client.takeOutgoing(), Data("RFB 003.008\n".utf8))

        try client.receive(Data([2, 1, 16])) // None and Tight offered
        XCTAssertEqual(client.takeOutgoing(), Data([1]))

        try client.receive(Data([0, 0, 0, 0]))
        XCTAssertEqual(client.takeOutgoing(), Data([1]), "ClientInit shares the desktop")

        let events = try client.receive(serverInit(width: 1280, height: 800, name: "Local VM"))
        XCTAssertEqual(events, [.connected(width: 1280, height: 800, name: "Local VM")])
        XCTAssertTrue(client.isConnected)
        XCTAssertEqual(client.framebuffer.count, 1280 * 800 * 4)

        let out = [UInt8](client.takeOutgoing())
        // SetPixelFormat: 32 bpp, depth 24, little-endian, true colour, BGRX.
        XCTAssertEqual(Array(out[0 ..< 20]), [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])
        // SetEncodings: CopyRect, Raw, DesktopSize.
        XCTAssertEqual(Array(out[20 ..< 36]), [2, 0, 0, 3] + s32(1) + s32(0) + s32(-223))
        // A full, non-incremental first request.
        XCTAssertEqual(Array(out[36 ..< 46]), [3, 0, 0, 0, 0, 0] + u16(1280) + u16(800))
    }

    func testAnswersAVNCPasswordChallenge() throws {
        let client = RFBClient(password: "password")
        try client.receive(Data("RFB 003.008\n".utf8))
        _ = client.takeOutgoing()
        try client.receive(Data([2, 1, 2]))
        XCTAssertEqual(client.takeOutgoing(), Data([2]), "prefers VNC auth when it has a password")

        try client.receive(Data("0123456789abcdef".utf8))
        // Independently computed: DES-ECB of the challenge under "password"
        // with each key byte's bits reversed.
        XCTAssertEqual(client.takeOutgoing().map { String(format: "%02x", $0) }.joined(), "5645abeb5f1e6475e8feb11beb66ea19")

        try client.receive(Data([0, 0, 0, 0]))
        XCTAssertEqual(client.takeOutgoing(), Data([1]))
    }

    func testReportsTheServersReasonWhenAuthenticationFails() {
        let client = RFBClient(password: "wrong")
        XCTAssertNoThrow(try client.receive(Data("RFB 003.008\n".utf8) + Data([1, 2]) + Data(repeating: 7, count: 16)))
        let reason = Array("Authentication failed".utf8)
        XCTAssertThrowsError(try client.receive(Data([0, 0, 0, 1, 0, 0, 0, UInt8(reason.count)] + reason))) { error in
            XCTAssertEqual(error as? RFBError, .authenticationFailed("Authentication failed"))
        }
    }

    func testRefusesAPasswordServerWithoutAPassword() {
        let client = RFBClient(password: nil)
        XCTAssertThrowsError(try client.receive(Data("RFB 003.008\n".utf8) + Data([1, 2]))) { error in
            XCTAssertEqual(error as? RFBError, .passwordRequired)
        }
    }

    func testSpeaks33WhereTheServerChoosesSecurity() throws {
        let client = RFBClient(password: nil)
        try client.receive(Data("RFB 003.003\n".utf8))
        XCTAssertEqual(client.takeOutgoing(), Data("RFB 003.003\n".utf8))
        try client.receive(Data([0, 0, 0, 1]))
        XCTAssertEqual(client.takeOutgoing(), Data([1]), "None needs no result in 3.3; straight to ClientInit")
        XCTAssertEqual(try client.receive(serverInit(width: 2, height: 2)), [.connected(width: 2, height: 2, name: "VM")])
    }

    func testRefusesAnUnknownProtocol() {
        let client = RFBClient(password: nil)
        XCTAssertThrowsError(try client.receive(Data("HTTP/1.1 200\n".utf8)))
    }

    func testAppliesARawRectangleOnlyOnceItHasAllArrived() throws {
        let client = try connected(width: 4, height: 3)
        var update: [UInt8] = [0, 0] + u16(1) + u16(1) + u16(1) + u16(2) + u16(2) + s32(0)
        update += [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0]
        // Split mid-rectangle, the way WebSocket messages arrive.
        XCTAssertEqual(try client.receive(Data(update.prefix(20))), [])
        XCTAssertEqual(client.framebuffer, [UInt8](repeating: 0, count: 48), "a partial update draws nothing")
        XCTAssertEqual(try client.receive(Data(update.dropFirst(20))), [.updated(resized: false)])

        let row1 = Array(client.framebuffer[16 ..< 32])
        let row2 = Array(client.framebuffer[32 ..< 48])
        XCTAssertEqual(row1, [0, 0, 0, 0, 1, 2, 3, 0, 4, 5, 6, 0, 0, 0, 0, 0])
        XCTAssertEqual(row2, [0, 0, 0, 0, 7, 8, 9, 0, 10, 11, 12, 0, 0, 0, 0, 0])
        XCTAssertEqual(client.takeOutgoing(), Data([3, 1, 0, 0, 0, 0] + u16(4) + u16(3)), "asks for the next change")
    }

    func testCopiesARectangleAndFollowsADesktopResize() throws {
        let client = try connected(width: 2, height: 1)
        try client.receive(Data([0, 0] + u16(1) + u16(0) + u16(0) + u16(1) + u16(1) + s32(0) + [9, 8, 7, 0]))
        try client.receive(Data([0, 0] + u16(1) + u16(1) + u16(0) + u16(1) + u16(1) + s32(1) + u16(0) + u16(0)))
        XCTAssertEqual(client.framebuffer, [9, 8, 7, 0, 9, 8, 7, 0])

        let events = try client.receive(Data([0, 0] + u16(1) + u16(0) + u16(0) + u16(3) + u16(2) + s32(-223)))
        XCTAssertEqual(events, [.updated(resized: true)])
        XCTAssertEqual(client.width, 3)
        XCTAssertEqual(client.height, 2)
        XCTAssertEqual(client.framebuffer.count, 3 * 2 * 4)
    }

    func testRefusesAnEncodingItDidNotAskFor() throws {
        let client = try connected()
        XCTAssertThrowsError(try client.receive(Data([0, 0] + u16(1) + u16(0) + u16(0) + u16(1) + u16(1) + s32(7)))) { error in
            XCTAssertEqual(error as? RFBError, .unsupportedEncoding(7))
        }
    }

    func testReadsBellAndLatin1Clipboard() throws {
        let client = try connected()
        let events = try client.receive(Data([2, 3, 0, 0, 0, 0, 0, 0, 3, 0x63, 0x61, 0xE9]))
        XCTAssertEqual(events, [.bell, .clipboard("caé")])
    }

    func testSendsPointerAndKeysClampedToTheDesktop() throws {
        let client = try connected(width: 100, height: 50)
        client.pointer(x: 150, y: -4, buttons: [.left])
        XCTAssertEqual(client.takeOutgoing(), Data([5, 1] + u16(99) + u16(0)))
        client.tap(RFBKey.returnKey)
        XCTAssertEqual(client.takeOutgoing(), Data([4, 1, 0, 0, 0, 0, 0xFF, 0x0D, 4, 0, 0, 0, 0, 0, 0xFF, 0x0D]))
    }

    func testSendsNothingBeforeTheHandshakeFinishes() {
        let client = RFBClient(password: nil)
        client.pointer(x: 1, y: 1, buttons: [])
        client.key(0x61, down: true)
        client.requestUpdate()
        XCTAssertTrue(client.takeOutgoing().isEmpty)
    }

    func testMapsTypedCharactersToKeysyms() {
        XCTAssertEqual(RFBKey.keysym(for: "a"), 0x61)
        XCTAssertEqual(RFBKey.keysym(for: "é"), 0xE9)
        XCTAssertEqual(RFBKey.keysym(for: "\n"), RFBKey.returnKey)
        XCTAssertEqual(RFBKey.keysym(for: "世"), 0x0100_4E16)
        XCTAssertNil(RFBKey.keysym(for: "👍🏽"))
    }
}
