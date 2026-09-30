// What a home-screen widget is allowed to know, and when it stops being
// current.
//
// The provider never talks to the network — WidgetKit budgets the
// extension, and the app already publishes the exact updates the pill
// reads into the App Group. So the timeline is: read the snapshot, say
// how fresh it is, and schedule the one flip the widget can perform on
// its own — fresh to stale at the fifteen-minute mark — before handing
// the cadence back to the system.
import CompanionCore
import SwiftUI
import UIKit
import WidgetKit

/// The state a widget renders, freshness included. The distinction is the
/// honesty contract: a snapshot the app wrote moments ago is spoken as
/// fact; the same rows ten minutes later are qualified with how old they
/// are, because the computer may have moved on.
enum WidgetSnapshotState {
    /// Nothing on disk: the app has never published, or it came up
    /// unpaired and cleared what the last session left.
    case unpaired
    /// A published snapshot with nothing in it — genuinely all quiet,
    /// carried rather than summarized so the timeline can age it: an
    /// empty write crosses the same fresh-to-stale line a full one does,
    /// and a quiet widget past that line owes the same age disclaimer.
    case quiet(WidgetSnapshot)
    case fresh(WidgetSnapshot)
    case stale(WidgetSnapshot)

    /// How long a written snapshot is spoken of as current. The app
    /// republishes on every change while it runs; this covers the gap
    /// after it is gone, matching the Live Activity's staleness stance.
    static let freshnessInterval: TimeInterval = 15 * 60

    var snapshot: WidgetSnapshot? {
        switch self {
        case .unpaired: return nil
        case let .fresh(snapshot), let .stale(snapshot): return snapshot
        case let .quiet(snapshot): return snapshot
        }
    }

    static func classify(_ snapshot: WidgetSnapshot?, now: Date) -> WidgetSnapshotState {
        guard let snapshot else { return .unpaired }
        let isFresh = now.timeIntervalSince(snapshot.writtenAt) < freshnessInterval
        guard !snapshot.rows.isEmpty else { return isFresh ? .quiet(snapshot) : .stale(snapshot) }
        return isFresh ? .fresh(snapshot) : .stale(snapshot)
    }
}

/// One rendered moment: when, what, and how much it should count for
/// against everything else on the home screen.
struct UpdatesSnapshotEntry: TimelineEntry {
    let date: Date
    let state: WidgetSnapshotState

    var relevance: TimelineEntryRelevance? {
        switch state {
        case .unpaired:
            return TimelineEntryRelevance(score: 0)
        case .quiet:
            return TimelineEntryRelevance(score: 0.2)
        case .fresh(let snapshot), .stale(let snapshot):
            // Kind is ranked most-urgent-first, so the minimum is the
            // headline: an ask outranks progress, progress outranks a
            // review waiting to be read.
            let score: Float
            switch snapshot.rows.map(\.kind).min() {
            case .needsYou: score = 1
            case .working: score = 0.6
            case .toReview: score = 0.35
            case nil: score = 0.2
            }
            return TimelineEntryRelevance(score: score)
        }
    }
}

/// Reads the published snapshot and turns it into a timeline. The only
/// future entry is the fresh-to-stale flip: WidgetKit owns the rest of
/// the cadence, and the app republishes on every real change.
struct UpdatesSnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> UpdatesSnapshotEntry {
        UpdatesSnapshotEntry(date: Date(), state: .quiet(WidgetSnapshot.empty()))
    }

    func getSnapshot(in context: Context, completion: @escaping (UpdatesSnapshotEntry) -> Void) {
        completion(UpdatesSnapshotEntry(date: Date(), state: current(now: Date())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UpdatesSnapshotEntry>) -> Void) {
        let now = Date()
        let state = current(now: now)
        var entries = [UpdatesSnapshotEntry(date: now, state: state)]
        switch state {
        case let .fresh(snapshot):
            // Pills stop answering at the trust window's end; schedule
            // that moment so the buttons leave when taps stop working,
            // not five minutes later at the stale flip.
            let answersExpireAt = snapshot.writtenAt.addingTimeInterval(WidgetSnapshot.answerMaximumAge)
            if answersExpireAt > now {
                entries.append(UpdatesSnapshotEntry(date: answersExpireAt, state: .fresh(snapshot)))
            }
            fallthrough
        case let .quiet(snapshot):
            // The one flip the widget can perform on its own — fresh to
            // stale at the fifteen-minute mark — includes empty writes:
            // a quiet widget stops claiming an unqualified all-clear
            // once the picture behind it has aged.
            entries.append(
                UpdatesSnapshotEntry(
                    date: snapshot.writtenAt.addingTimeInterval(WidgetSnapshotState.freshnessInterval),
                    state: .stale(snapshot)
                )
            )
        default:
            break
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
    }

    private func current(now: Date) -> WidgetSnapshotState {
        WidgetSnapshotState.classify(WidgetSnapshotStore.makeAppGroupStore()?.read(), now: now)
    }
}

/// Where a widget tap lands: the chat the row is about. The shape is the
/// one the app's CompanionDeepLink parses — openmausbot://chat/<id> —
/// with the id encoded so strictly that no thread id can smuggle a path
/// or a query of its own.
enum WidgetChatLink {
    static func url(threadId: String) -> URL? {
        guard let encoded = threadId.addingPercentEncoding(withAllowedCharacters: unreserved) else { return nil }
        var components = URLComponents()
        components.scheme = "openmausbot"
        components.host = "chat"
        components.path = "/" + encoded
        return components.url
    }

    /// RFC 3986 unreserved characters — everything a path segment may
    /// hold without becoming something else.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )
}

/// The background every home-screen widget in this extension draws. iOS
/// 17 requires a widget to opt in to its container background or render
/// with none at all; below 17 the system draws it for us.
extension View {
    @ViewBuilder
    func widgetContainerBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        } else {
            self
        }
    }

    /// The background a lock-screen accessory draws: nothing of its own, so
    /// the system's accessory material shows through. Accessories opt in
    /// explicitly on iOS 17 for the same reason home-screen widgets do —
    /// below it the system already draws one.
    @ViewBuilder
    func widgetAccessoryBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(for: .widget) { Color.clear }
        } else {
            self
        }
    }
}
