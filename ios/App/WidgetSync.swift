// The home-screen widgets' data path: the app's own updates, published.
//
// A widget extension is a separate process on a system budget, so it cannot
// subscribe to the session. Instead the app freezes the same `updates` the
// pill reads into the App Group whenever they change — the same 400 ms
// debounce the Dynamic Island rides — and tells WidgetKit to reload only
// when the payload actually differs. While the app is alive the widgets are
// exact; once it is gone they age the last snapshot and say so.
import Combine
import CompanionCore
import Foundation
import WidgetKit

@MainActor
final class WidgetSyncBridge {
    private let store: WidgetSnapshotStore?
    private var cancellable: AnyCancellable?
    /// The last snapshot this bridge wrote; an equal payload is neither
    /// rewritten nor allowed to cost the widget a reload.
    private var lastWritten: WidgetSnapshot?
    /// The per-chat elapsed clock, seeded from the last snapshot so work
    /// that began before this launch keeps its true start.
    private var sinceClock = WidgetSinceClock()
    /// Whether the unpaired state is already what is on disk. Starts false —
    /// at launch nothing is known about the file — so an app that comes up
    /// unpaired still clears whatever the last session left behind, once.
    private var publishedUnpaired = false

    init(store: WidgetSnapshotStore?) {
        self.store = store
        sinceClock = WidgetSinceClock(seed: store?.read())
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
        cancellable = Publishers.CombineLatest(session.$state, session.$connection)
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state, connection in
                self?.sync(state, connectionID: connection?.id)
            }
    }

    /// The last write before suspension. The debounced stream may never
    /// fire for the newest state, and a snapshot one ask behind is the
    /// difference between answering from the home screen and opening a
    /// chat that has already moved on.
    func flush(_ state: CompanionState, connectionID: String?) {
        sync(state, connectionID: connectionID)
    }

    private func sync(_ state: CompanionState, connectionID: String?) {
        guard let store else { return }
        guard let connectionID else {
            // Unpaired: no snapshot at all beats a stale one claiming a
            // connection that no longer exists — the widgets fall back to
            // their pairing placeholder.
            guard !publishedUnpaired else { return }
            store.remove()
            lastWritten = nil
            // The clock dies with the session it measured: a re-paired
            // computer's work starts when it starts, not when the last
            // one did.
            sinceClock = WidgetSinceClock()
            publishedUnpaired = true
            WidgetCenter.shared.reloadAllTimelines()
            return
        }
        publishedUnpaired = false
        let snapshot = state.widgetSnapshot(connectionID: connectionID) { chat in
            MausState.forChat(chat, in: state).rawValue
        } since: { update in
            sinceClock.stamp(for: update.chat, kind: update.kind)
        }
        sinceClock.forget(absentFrom: state.updates.map(\.chat))
        guard snapshot != lastWritten else { return }
        do {
            try store.write(snapshot)
            lastWritten = snapshot
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            // A failed write — an unsigned preview, a full container — must
            // not take the app down with it; the widget keeps whatever
            // the previous write left.
        }
    }
}
