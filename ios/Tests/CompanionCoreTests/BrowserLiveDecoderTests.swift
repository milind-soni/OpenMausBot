import XCTest
@testable import CompanionCore

/// The message type travels in the SSE `event:` name, never in the payload:
/// the server strips it before writing the frame. Every case here passes the
/// name separately for that reason — an earlier version keyed on the payload
/// and decoded precisely nothing.
final class BrowserLiveDecoderTests: XCTestCase {
    func testDecodesAFrameWithItsDeviceSize() {
        let json = #"{"seq":7,"data":"/9j/abc","format":"jpeg","metadata":{"deviceWidth":1280,"deviceHeight":720}}"#

        guard case let .frame(frame)? = BrowserLiveDecoder.message(event: "frame", data: json) else {
            return XCTFail("expected a frame")
        }
        XCTAssertEqual(frame.seq, 7)
        XCTAssertEqual(frame.data, "/9j/abc")
        XCTAssertEqual(frame.deviceWidth, 1280)
        XCTAssertEqual(frame.deviceHeight, 720)
    }

    /// JSONSerialization types an integer literal as Int and a decimal one as
    /// Double; a viewport must survive either.
    func testDecodesIntegerAndDecimalMetadataAlike() {
        let decimal = #"{"seq":1,"data":"x","metadata":{"deviceWidth":1280.0,"deviceHeight":720.5}}"#

        guard case let .frame(frame)? = BrowserLiveDecoder.message(event: "frame", data: decimal) else {
            return XCTFail("expected a frame")
        }
        XCTAssertEqual(frame.deviceHeight, 720.5)
    }

    /// The viewport is what the sink denormalises against, so a status that
    /// loses it would put every click in the wrong place.
    func testDecodesStatusWithTheViewport() {
        let json = #"{"connected":true,"screencasting":true,"viewportWidth":1512,"viewportHeight":982}"#

        guard case let .status(status)? = BrowserLiveDecoder.message(event: "status", data: json) else {
            return XCTFail("expected a status")
        }
        XCTAssertTrue(status.connected)
        XCTAssertEqual(status.viewportWidth, 1512)
        XCTAssertEqual(status.viewportHeight, 982)
    }

    /// `ready` is the server's name for it, and the only place a viewer id
    /// ever arrives. Without it there is nothing to post an action against.
    func testDecodesReadyAsTheViewerId() {
        guard case let .ready(id)? = BrowserLiveDecoder.message(event: "ready", data: #"{"viewerId":"v-1"}"#) else {
            return XCTFail("expected ready")
        }
        XCTAssertEqual(id, "v-1")
    }

    func testDecodesUrlAndTabs() {
        guard case let .url(url)? = BrowserLiveDecoder.message(event: "url", data: #"{"url":"https://example.test/"}"#) else {
            return XCTFail("expected a url")
        }
        XCTAssertEqual(url, "https://example.test/")

        let tabsJSON = #"{"tabs":[{"tabId":"t1","title":"One","url":"https://a.test/","active":true},{"tabId":"t2","title":"","url":"","active":false}]}"#
        guard case let .tabs(tabs)? = BrowserLiveDecoder.message(event: "tabs", data: tabsJSON) else {
            return XCTFail("expected tabs")
        }
        XCTAssertEqual(tabs.map(\.tabId), ["t1", "t2"])
        XCTAssertTrue(tabs[0].active)
    }

    func testDecodesControlAndHeartbeat() {
        guard case let .control(controlling, held)? = BrowserLiveDecoder.message(
            event: "control", data: #"{"controlling":true,"held":false,"owned":true}"#
        ) else { return XCTFail("expected control") }
        XCTAssertTrue(controlling)
        XCTAssertFalse(held)

        XCTAssertEqual(BrowserLiveDecoder.message(event: "heartbeat", data: "{}"), .heartbeat)
    }

    func testDecodesAnErrorWithAFallbackMessage() {
        guard case let .error(message)? = BrowserLiveDecoder.message(event: "error", data: "{}") else {
            return XCTFail("expected an error")
        }
        XCTAssertFalse(message.isEmpty)
    }

    /// A name we have never seen is a protocol change, not a reason to tear
    /// down a stream the person is watching.
    func testAnUnknownOrMissingEventNameIsDropped() {
        XCTAssertNil(BrowserLiveDecoder.message(event: "something-new", data: "{}"))
        XCTAssertNil(BrowserLiveDecoder.message(event: nil, data: #"{"type":"frame"}"#))
    }

    func testMalformedInputIsRejectedWithoutThrowing() {
        XCTAssertNil(BrowserLiveDecoder.message(event: "frame", data: "not json"))
        // A frame without its metadata cannot be mapped to coordinates.
        XCTAssertNil(BrowserLiveDecoder.message(event: "frame", data: #"{"seq":1,"data":"x"}"#))
    }

    func testFrameBytesDecodeFromBase64() {
        let json = #"{"seq":1,"data":"aGVsbG8=","metadata":{"deviceWidth":10,"deviceHeight":10}}"#

        guard case let .frame(frame)? = BrowserLiveDecoder.message(event: "frame", data: json) else {
            return XCTFail("expected a frame")
        }
        XCTAssertEqual(frame.bytes.flatMap { String(data: $0, encoding: .utf8) }, "hello")
    }
}

final class BrowserLiveErrorTextTests: XCTestCase {
    /// The server's own sentence must reach the person. Before this, the
    /// stream threw a bare status and every 403 read as "browser control is
    /// off", whatever the server actually said.
    func testReadsTheServersRefusal() {
        let body = Data(#"{"error":"Enable this bot's browser in its profile first."}"#.utf8)
        XCTAssertEqual(BrowserLiveClient.errorText(body), "Enable this bot's browser in its profile first.")
    }

    func testANonJSONBodyYieldsNothingRatherThanGarbage() {
        XCTAssertNil(BrowserLiveClient.errorText(Data("<html>".utf8)))
    }
}
