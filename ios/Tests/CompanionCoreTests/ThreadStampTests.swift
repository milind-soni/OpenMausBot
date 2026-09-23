import XCTest
@testable import CompanionCore

final class ThreadStampTests: XCTestCase {
    func testUpdateStampFollowsTheTimeZoneItIsGiven() {
        let at: Double = 1_758_518_400_000
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        let newYork = TimeZone(identifier: "America/New_York")!
        let locale = Locale(identifier: "en_US")
        XCTAssertNotEqual(
            ThreadStamp.updated(at, timeZone: tokyo, locale: locale),
            ThreadStamp.updated(at, timeZone: newYork, locale: locale)
        )
    }

    func testMissingStampIsBlankAndTheDefaultZoneIsTheOperatingSystem() {
        let at: Double = 1_758_518_400_000
        XCTAssertEqual(ThreadStamp.updated(0), "")
        XCTAssertEqual(ThreadStamp.updated(-1), "")
        XCTAssertEqual(ThreadStamp.updated(at), ThreadStamp.updated(at, timeZone: .current, locale: .current))
    }
}
