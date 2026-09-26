import XCTest
@testable import CompanionCore

/// The parity harness.
///
/// Both platforms run this same fixture file, so a behaviour added on one and
/// not the other fails here rather than in a bug report six weeks later. The
/// Kotlin runner in `android/core` decodes the identical schema.
final class RemoteGestureParityTests: XCTestCase {
    func testEveryFixtureCaseProducesItsDocumentedIntents() throws {
        let suite = try loadSuite()
        XCTAssertFalse(suite.cases.isEmpty, "an empty fixture would pass without proving anything")

        for testCase in suite.cases {
            var core = GestureCore(mode: testCase.mode, mapping: ViewportMapping(
                viewWidth: testCase.view[0], viewHeight: testCase.view[1],
                frameWidth: testCase.frame[0], frameHeight: testCase.frame[1],
                transform: .identity
            ))
            core.driving = testCase.driving

            var produced: [GestureIntent] = []
            for step in testCase.steps {
                if let touch = step.touch { produced += core.handle(touch) }
                if let tick = step.tick { produced += core.tick(at: tick) }
            }

            XCTAssertEqual(produced.count, testCase.expect.count, "\(testCase.name): \(produced)")
            guard produced.count == testCase.expect.count else { continue }
            for (index, expected) in testCase.expect.enumerated() {
                XCTAssertTrue(
                    matches(produced[index], expected),
                    "\(testCase.name) step \(index): \(produced[index]) is not \(expected)"
                )
            }
        }
    }

    /// The fixture must be reachable, and its absence must fail loudly rather
    /// than silently testing nothing.
    func testTheFixtureIsOnTheTestBundle() throws {
        XCTAssertNoThrow(try loadSuite())
    }

    private func loadSuite() throws -> ParitySuite {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "gesture-parity", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "gesture-parity", withExtension: "json"),
            "gesture-parity.json is not in the test bundle"
        )
        return try JSONDecoder().decode(ParitySuite.self, from: Data(contentsOf: url))
    }

    /// Compared with tolerance, never `==`. Normalising a coordinate through a
    /// division yields -0.09999999999999998 and a signed -0.0, and Swift and
    /// Kotlin will not round identically — an exact match would make the
    /// parity gate fail on arithmetic instead of on behaviour.
    private func matches(_ produced: GestureIntent, _ expected: GestureIntent) -> Bool {
        let tolerance = 0.0001
        switch (produced, expected) {
        case let (.move(ax, ay), .move(bx, by)):
            return abs(ax - bx) < tolerance && abs(ay - by) < tolerance
        case let (.scroll(ax, ay), .scroll(bx, by)):
            return abs(ax - bx) < tolerance && abs(ay - by) < tolerance
        case let (.press(ab, ac), .press(bb, bc)):
            return ab == bb && ac == bc
        case let (.release(ab), .release(bb)):
            return ab == bb
        case let (.text(a), .text(b)):
            return a == b
        case let (.key(an, am), .key(bn, bm)):
            return an == bn && am == bm
        default:
            return false
        }
    }
}

struct ParitySuite: Decodable {
    let cases: [ParityCase]
}

struct ParityCase: Decodable {
    let name: String
    let mode: GestureMode
    let view: [Double]
    let frame: [Double]
    let driving: Bool
    let steps: [ParityStep]
    let expect: [GestureIntent]
}

struct ParityStep: Decodable {
    let touch: TouchSample?
    let tick: Double?
}
