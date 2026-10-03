// The home-screen widgets' data path: the app's own updates, published.
//
// A widget extension is a separate process on a system budget, so it cannot
// subscribe to the session. Instead the app freezes the same `updates` the
// pill reads into the App Group whenever they change — the same 400 ms
// window the Dynamic Island rides — and tells WidgetKit to reload only
// when the payload differs, or its unchanged timestamp needs a minute's
// renewal. Once the app is gone they age the last snapshot and say so.
import Combine
import CompanionCore
import Foundation
import UIKit
import WidgetKit

@MainActor
final class WidgetSyncBridge {
    private let writer: WidgetSnapshotWriter?
    private var cancellable: AnyCancellable?
    /// The per-chat elapsed clock, seeded from the last snapshot so work
    /// that began before this launch keeps its true start.
    private var sinceClock = WidgetSinceClock()
    private var clockConnectionID: String?
    private var backgroundWrite: UIBackgroundTaskIdentifier = .invalid
    private var flushGeneration = 0

    init(store: WidgetSnapshotStore?) {
        writer = store.map(WidgetSnapshotWriter.init(store:))
        let seed = store?.read()
        sinceClock = WidgetSinceClock(seed: seed)
        clockConnectionID = seed?.connectionID
    }

    /// The bridge over the App Group container the widget extension reads.
    /// A nil store when the group is unavailable (unsigned previews) makes
    /// the whole bridge a no-op rather than a crash in a development build.
    static func makeAppGroupBridge() -> WidgetSyncBridge {
        let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: OpenMausSharedConfiguration.appGroupIdentifier
        )
        return WidgetSyncBridge(store: container.map { WidgetSnapshotStore(directory: $0) })
    }

    func attach(to session: Session) {
        // Both the fleet and the connection matter: an unpaired app must
        // clear the snapshot even when no state change would have said so.
        // A fixed window keeps startup's grace without waiting forever for
        // a busy fleet to go quiet. Empty windows publish nothing.
        cancellable = Publishers.CombineLatest(session.$state, session.$connection)
            .collect(.byTime(DispatchQueue.main, .milliseconds(400)))
            .compactMap(\.last)
            .sink { [weak self] state, connection in
                self?.sync(state, connectionID: connection?.id)
            }
    }

    /// The last write before suspension. The current window may not yet
    /// have published the newest state, and a snapshot one ask behind is the
    /// difference between answering from the home screen and opening a
    /// chat that has already moved on.
    func flush(_ state: CompanionState, connectionID: String?) {
        guard writer != nil else { return }
        flushGeneration &+= 1
        let generation = flushGeneration
        if backgroundWrite == .invalid {
            backgroundWrite = UIApplication.shared.beginBackgroundTask(withName: "widget.snapshot") { [weak self] in
                self?.endBackgroundWrite()
            }
        }
        sync(state, connectionID: connectionID, flushGeneration: generation)
    }

    private func sync(_ state: CompanionState, connectionID: String?, flushGeneration: Int? = nil) {
        guard writer != nil else { return }
        guard let connectionID else {
            // Unpaired: no snapshot at all beats a stale one claiming a
            // connection that no longer exists — the widgets fall back to
            // their pairing placeholder.
            // The clock dies with the session it measured: a re-paired
            // computer's work starts when it starts, not when the last
            // one did.
            sinceClock = WidgetSinceClock()
            clockConnectionID = nil
            publish(nil, flushGeneration: flushGeneration)
            return
        }
        if clockConnectionID != connectionID {
            sinceClock = WidgetSinceClock()
            clockConnectionID = connectionID
        }
        let snapshot = state.widgetSnapshot(connectionID: connectionID, detail: .stored) { chat in
            MausState.forChat(chat, in: state).rawValue
        } since: { update in
            sinceClock.stamp(for: update.chat, kind: update.kind)
        }
        sinceClock.forget(absentFrom: snapshot.rows.map(\.chat))
        publish(snapshot, flushGeneration: flushGeneration)
    }

    private func publish(_ snapshot: WidgetSnapshot?, flushGeneration: Int?) {
        writer?.publish(snapshot) { [weak self] changed in
            Task { @MainActor in
                if changed { WidgetCenter.shared.reloadAllTimelines() }
                if let flushGeneration, self?.flushGeneration == flushGeneration {
                    self?.endBackgroundWrite()
                }
            }
        }
    }

    private func endBackgroundWrite() {
        guard backgroundWrite != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundWrite)
        backgroundWrite = .invalid
    }
}
