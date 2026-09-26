import XCTest
@testable import CompanionCore

final class BrowserLiveSinkTests: XCTestCase {
    private func sink() -> BrowserLiveSink {
        BrowserLiveSink(frameWidth: 1280, frameHeight: 720)
    }

    /// Intents are normalised; the protocol is in device pixels. This is the
    /// only place that conversion happens, so it is the only place it can go
    /// wrong.
    func testMoveDenormalisesToDevicePixels() {
        var sink = sink()

        let body = sink.bodies(for: .move(x: 0.5, y: 0.25)).first

        XCTAssertEqual(body?.type, "input_mouse")
        XCTAssertEqual(body?.eventType, "mouseMoved")
        XCTAssertEqual(body?.x ?? .nan, 640, accuracy: 0.001)
        XCTAssertEqual(body?.y ?? .nan, 180, accuracy: 0.001)
        XCTAssertEqual(body?.button, "none")
    }

    /// A wheel event must carry a position and a scroll intent has none, so
    /// the last move supplies it.
    func testScrollCarriesTheLastPointerPositionAndPixelDeltas() {
        var sink = sink()

        _ = sink.bodies(for: .move(x: 0.5, y: 0.5))
        let body = sink.bodies(for: .scroll(dx: 0, dy: -0.1)).first

        XCTAssertEqual(body?.eventType, "mouseWheel")
        XCTAssertEqual(body?.x ?? .nan, 640, accuracy: 0.001)
        XCTAssertEqual(body?.deltaY ?? .nan, -72, accuracy: 0.001)
    }

    /// While a button is down, a move must say so: the server distinguishes a
    /// drag from a hover by the button on the move event.
    func testMovesReportTheHeldButtonWhileDragging() {
        var sink = sink()

        _ = sink.bodies(for: .press(button: .left, clicks: 1))
        XCTAssertEqual(sink.bodies(for: .move(x: 0.6, y: 0.6)).first?.button, "left")

        _ = sink.bodies(for: .release(button: .left))
        XCTAssertEqual(sink.bodies(for: .move(x: 0.7, y: 0.7)).first?.button, "none")
    }

    func testPressCarriesTheClickCountClampedToWhatTheServerAccepts() {
        var sink = sink()

        XCTAssertEqual(sink.bodies(for: .press(button: .right, clicks: 2)).first?.clickCount, 2)
        XCTAssertEqual(sink.bodies(for: .press(button: .left, clicks: 99)).first?.clickCount, 3)
        XCTAssertEqual(sink.bodies(for: .press(button: .left, clicks: 0)).first?.clickCount, 1)
    }

    func testTypedTextBecomesACharEvent() {
        var sink = sink()

        let body = sink.bodies(for: .text("hello")).first

        XCTAssertEqual(body?.type, "input_keyboard")
        XCTAssertEqual(body?.eventType, "char")
        XCTAssertEqual(body?.text, "hello")
    }

    /// The server resolves a named or modified key into a complete press and
    /// acknowledges the pair itself, so only keyDown goes out.
    func testNamedAndModifiedKeysSendOnlyKeyDown() {
        var sink = sink()

        let enter = sink.bodies(for: .key(name: "Enter", modifiers: 0))
        XCTAssertEqual(enter.count, 1)
        XCTAssertEqual(enter.first?.eventType, "keyDown")
        XCTAssertEqual(enter.first?.key, "Enter")

        // Control is bit 2 in the contract bitmask.
        let chord = sink.bodies(for: .key(name: "c", modifiers: 2)).first
        XCTAssertEqual(chord?.key, "c")
        XCTAssertEqual(chord?.modifiers, 2)
    }

    /// An unmodified single character sent as a key would reach the server as
    /// a raw keyDown, enter its held-key set and never be released. Typing is
    /// what `char` is for, so route it there rather than leak a held key.
    func testAnUnmodifiedSingleCharacterKeyBecomesText() {
        var sink = sink()

        let body = sink.bodies(for: .key(name: "a", modifiers: 0)).first

        XCTAssertEqual(body?.eventType, "char")
        XCTAssertEqual(body?.text, "a")
    }

    func testEmptyTextAndEmptyKeysProduceNothing() {
        var sink = sink()

        XCTAssertTrue(sink.bodies(for: .text("")).isEmpty)
        XCTAssertTrue(sink.bodies(for: .key(name: "", modifiers: 2)).isEmpty)
    }

    /// The protocol refuses a coordinate over 8192, so a very large frame must
    /// not push every event out of range.
    func testCoordinatesStayInsideWhatTheProtocolAccepts() {
        var sink = BrowserLiveSink(frameWidth: 16_000, frameHeight: 12_000)

        let body = sink.bodies(for: .move(x: 1, y: 1)).first

        XCTAssertLessThanOrEqual(body?.x ?? .infinity, 8192)
        XCTAssertLessThanOrEqual(body?.y ?? .infinity, 8192)
    }

    func testScrollDeltasClampToTheProtocolLimit() {
        var sink = BrowserLiveSink(frameWidth: 100_000, frameHeight: 100_000)

        let body = sink.bodies(for: .scroll(dx: 1, dy: -1)).first

        XCTAssertEqual(body?.deltaX ?? .nan, 10_000, accuracy: 0.001)
        XCTAssertEqual(body?.deltaY ?? .nan, -10_000, accuracy: 0.001)
    }

    /// The queue decides what it may drop by asking the body, so these two
    /// classifiers are load-bearing.
    func testMovementAndReleaseAreClassifiedForTheQueue() {
        var sink = sink()

        XCTAssertTrue(sink.bodies(for: .move(x: 0.1, y: 0.1)).first!.isMovement)
        XCTAssertTrue(sink.bodies(for: .scroll(dx: 0, dy: 0.1)).first!.isMovement)
        XCTAssertFalse(sink.bodies(for: .press(button: .left, clicks: 1)).first!.isMovement)

        XCTAssertTrue(sink.bodies(for: .release(button: .left)).first!.isRelease)
        XCTAssertFalse(sink.bodies(for: .press(button: .left, clicks: 1)).first!.isRelease)
    }
}
