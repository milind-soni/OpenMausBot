// The widget's own network reach: one route loop for the requests a
// home-screen answer needs, and the refresh that follows a landed answer.
//
// A widget answer runs in the extension process, which has no Session to
// lean on — only the pairing metadata in the App Group and the token in
// the shared keychain. So the intent brings a miniature of the app's cold
// hydration: try the connection's automatic routes in order until one
// answers, fold the fleet exactly as a launch would, and publish the
// snapshot the same way the app's bridge does. A refresh that cannot
// reach the computer is never an error to surface — the widget keeps the
// snapshot it already has, minus the row the answer removed.
import CompanionCore
import Foundation
import WidgetKit

extension WidgetSnapshotStore {
    /// The store over the App Group container the app publishes into, or
    /// nil when the group is unavailable (an unsigned preview). Every
    /// reader and writer in the extension goes through this one door.
    static func makeAppGroupStore() -> WidgetSnapshotStore? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: OpenMausSharedConfiguration.appGroupIdentifier
        ).map { WidgetSnapshotStore(directory: $0) }
    }
}

/// One request, tried across the connection's automatic routes in order.
///
/// The loop is serial on purpose. An answer is a write, and spraying one
/// at every route in parallel could submit the same response twice. The
/// failover rule is the app's: only a transport failure or a gateway
/// error belongs to the route — anything the harness itself said (a
/// rejected token, a request already gone) is authoritative and final.
enum WidgetRouteRequest {
    static func perform<T: Sendable>(
        connection: Connection,
        token: String,
        operation: @escaping @Sendable (CompanionClient) async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for endpoint in connection.automaticEndpoints {
            try Task.checkCancellation()
            let client = CompanionClient(
                connection: connection.dialing(endpoint),
                token: token,
                requestTimeout: 7
            )
            do {
                return try await operation(client)
            } catch {
                if Task.isCancelled { throw CancellationError() }
                lastError = error
                guard ConnectionAdvice.shouldTryAnotherRoute(after: error) else { throw error }
            }
        }
        throw lastError ?? APIError.transport("This computer is offline.")
    }
}

/// Pulls the fleet fresh and republishes the snapshot — for the moment a
/// widget answer has just landed and the file on disk no longer matches
/// the world. Best effort by design: the caller has already removed the
/// answered row locally, so a refresh that fails anywhere simply leaves
/// that truthfully-older snapshot standing.
enum WidgetSnapshotRefresh {
    static func refresh(connection: Connection, token: String, store: WidgetSnapshotStore?) async {
        guard let store else { return }
        guard
            let pulled = try? await WidgetRouteRequest.perform(
                connection: connection,
                token: token,
                operation: { client in try await client.fleetForHydration(messages: 50) }
            )
        else { return }
        var state = CompanionState()
        state.hydrate(pulled.fleet, waitingThreads: pulled.waitingThreads)
        // Seed the elapsed clock from the snapshot being replaced, so a
        // refresh never resets a working bot's timer to now.
        var sinceClock = WidgetSinceClock(seed: store.read())
        let snapshot = state.widgetSnapshot(connectionID: connection.id) { chat in
            MausState.forChat(chat, in: state).rawValue
        } since: { update in
            sinceClock.stamp(for: update.chat, kind: update.kind)
        }
        try? store.write(snapshot)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
