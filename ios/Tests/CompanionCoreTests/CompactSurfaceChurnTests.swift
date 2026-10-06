// How often the compact surfaces — home-screen widgets and Live Activities —
// are refreshed while a fleet streams. Each 50 ms batch grows every busy
// bot's streamed reply, and the app samples the newest state once per
// 400 ms window, exactly as `WidgetSyncBridge` and
// `LiveActivityCoordinator` do; what is counted is what those bridges
// would hand the system: a snapshot write (and a WidgetKit reload), or an
// `Activity.update`. "Before" is the gate with no pacing, which is exactly
// how both surfaces behaved until now.
import XCTest
@testable import CompanionCore

final class CompactSurfaceChurnTests: XCTestCase {
    private struct Counts: Equatable {
        var widgetWrites = 0
        var activityUpdates = 0
    }

    private let start = Date(timeIntervalSinceReferenceDate: 800_000_000)

    /// `count` bots, each busy in its own thread — the fixture's working
    /// bot, cloned.
    private func streamingFleet(count: Int) throws -> CompanionState {
        let url = try XCTUnwrap(Bundle.module.url(
            forResource: "updates-fleet", withExtension: "json", subdirectory: "Fixtures"
        ))
        let fleet = try JSONDecoder().decode(Fleet.self, from: Data(contentsOf: url))
        let template = try XCTUnwrap(fleet.bots.first { $0.id == "bot-busy" })
        let bots = (0..<count).map { index -> Bot in
            var bot = template
            bot.id = "bot-\(index)"
            bot.threadId = "t-\(index)"
            bot.name = "Bot \(index)"
            bot.tasks = bot.tasks?.map { task in
                var task = task
                task.threadId = "t-\(index)"
                return task
            }
            bot.messages = nil
            bot.activeLeafId = nil
            return bot
        }
        var state = CompanionState()
        state.hydrate(Fleet(bots: bots, groups: []))
        return state
    }

    /// Runs `seconds` of every bot streaming, one batch per 50 ms, and
    /// counts what each surface sends. `change` may alter the state at a
    /// given millisecond; the returned windows say when each surface
    /// first saw a change after it.
    private func simulate(
        seconds: Int = 60,
        bots: Int = 5,
        widgetLineInterval: TimeInterval = WidgetSnapshot.workingLineInterval,
        islandLineInterval: TimeInterval = LiveActivityPacer.workingLineInterval,
        change: (Int, inout CompanionState) -> Void = { _, _ in },
        observe: (Int, _ widgetWrote: Bool, _ sentBots: Set<String>) -> Void = { _, _, _ in }
    ) throws -> Counts {
        var state = try streamingFleet(count: bots)
        var written: WidgetSnapshot?
        var pacer = LiveActivityPacer(workingLineInterval: islandLineInterval)
        var counts = Counts()
        for batch in 1...(seconds * 1000 / 50) {
            let millisecond = batch * 50
            for index in 0..<bots {
                state.streaming["t-\(index)", default: ""] += " token\(batch)"
            }
            change(millisecond, &state)
            guard millisecond % 400 == 0 else { continue }
            let now = start.addingTimeInterval(Double(millisecond) / 1000)

            let snapshot = state.widgetSnapshot(connectionID: "computer-1", detail: .full, now: now) { _ in "working" }
            let widgetWrote = snapshot.shouldReplace(written, workingLineInterval: widgetLineInterval)
            if widgetWrote {
                written = snapshot
                counts.widgetWrites += 1
            }

            var sent = Set<String>()
            for update in state.liveActivityUpdates(detail: .full) {
                let content = BotActivityContent(update: update, face: "working", since: start)
                guard pacer.decision(for: content, bot: update.chat.id, at: now) == .send else { continue }
                pacer.record(content, bot: update.chat.id, at: now)
                sent.insert(update.chat.id)
                counts.activityUpdates += 1
            }
            observe(millisecond, widgetWrote, sent)
        }
        return counts
    }

    func testAStreamingFleetRefreshesTheCompactSurfacesSecondsApartNotEveryWindow() throws {
        let before = try simulate(widgetLineInterval: 0, islandLineInterval: 0)
        let after = try simulate()
        print("compact-surface churn, 5 bots streaming for 60 s at 50 ms batches:"
            + " widget writes+reloads \(before.widgetWrites) -> \(after.widgetWrites),"
            + " Live Activity updates \(before.activityUpdates) -> \(after.activityUpdates)")
        // Unpaced, every 400 ms window rewrote the widget file and updated
        // every streaming bot's activity.
        XCTAssertEqual(before, Counts(widgetWrites: 150, activityUpdates: 750))
        // Paced: the widget writes on the first window and once the 30 s
        // narration interval has run; each activity once per five seconds.
        XCTAssertEqual(after, Counts(widgetWrites: 2, activityUpdates: 60))
    }

    func testAnAskMidStreamReachesBothSurfacesInItsOwnWindow() throws {
        // Bot 0 stops for an answer 10 s in — long after both surfaces last
        // sent, and well inside both narration intervals.
        var askWindow: (widget: Bool, island: Set<String>)?
        var finishWindow: (widget: Bool, island: Set<String>)?
        _ = try simulate(change: { millisecond, state in
            if millisecond == 10_000 {
                state.bots[0].tasks?[0].busy = false
                state.bots[0].tasks?[0].activity = "waiting-on-you"
            }
            if millisecond == 20_000 {
                // Bot 1 finishes with something unread.
                state.bots[1].tasks?[0].busy = false
                state.bots[1].tasks?[0].unread = true
                state.streaming["t-1"] = nil
            }
        }, observe: { millisecond, widgetWrote, sent in
            if millisecond == 10_000 { askWindow = (widgetWrote, sent) }
            if millisecond == 20_000 { finishWindow = (widgetWrote, sent) }
        })
        XCTAssertEqual(askWindow?.widget, true, "an ask must not wait out the widget's narration interval")
        XCTAssertEqual(askWindow?.island, ["bot-0"], "only the asking bot's activity changes in that window")
        XCTAssertEqual(finishWindow?.widget, true, "a finished bot must not wait out the narration interval")
    }

    func testNarrationAloneIsHeldButNeverLost() throws {
        // Every window after the first carries new narration; the widget
        // writes it at 30 s, each activity at 5 s — never longer than one
        // interval plus a window behind.
        var widgetWrites: [Int] = []
        var botZeroSends: [Int] = []
        _ = try simulate(seconds: 40, observe: { millisecond, widgetWrote, sent in
            if widgetWrote { widgetWrites.append(millisecond) }
            if sent.contains("bot-0") { botZeroSends.append(millisecond) }
        })
        XCTAssertEqual(widgetWrites.first, 400)
        XCTAssertEqual(widgetWrites.count, 2)
        let widgetGap = try XCTUnwrap(widgetWrites.last) - 400
        XCTAssertGreaterThanOrEqual(widgetGap, 30_000)
        XCTAssertLessThanOrEqual(widgetGap, 30_400)
        for (earlier, later) in zip(botZeroSends, botZeroSends.dropFirst()) {
            XCTAssertGreaterThanOrEqual(later - earlier, 5_000)
            XCTAssertLessThanOrEqual(later - earlier, 5_400)
        }
    }
}
