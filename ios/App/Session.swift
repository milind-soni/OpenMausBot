// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// part that cannot be unit-tested and is the actual hard problem in a phone
// client — lifecycle. A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Foundation
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.openmausbot.companion", category: "stream")

private final class CachedAttachmentDownload: NSObject {
    let value: DownloadedFile

    init(_ value: DownloadedFile) {
        self.value = value
    }
}

/// An immutable, ciphertext-only credential write prepared on the main
/// actor before any asynchronous work begins. HPKE uses fresh randomness for
/// every seal, so retries must reuse this exact value rather than encrypting
/// the same credential again after an ambiguous network failure.
struct PreparedPhoneCredential: Equatable, Sendable {
    fileprivate let requestIdentity: String
    fileprivate let connectionID: String
    fileprivate let botID: String
    fileprivate let messageID: String
    fileprivate let envelope: PhoneSecretEnvelope
}

@MainActor
final class Session: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
    }

    @Published private(set) var state = CompanionState()
    @Published private(set) var connection: Connection?
    @Published private(set) var connections: [Connection] = []
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?
    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// Distinguishes a real `.notDetermined` result from the in-memory value
    /// used while notification settings are still loading at launch.
    @Published private(set) var notificationAuthorizationResolved = false
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?
    /// Pairing can be opened while another computer remains connected. The
    /// working session is only replaced after the new credential commits.
    @Published private(set) var pairingRequested = false
    /// Views with sensitive input observe this value so an explicit runtime
    /// disconnect clears the field even when the selected connection itself
    /// has not changed.
    @Published private(set) var credentialEntryResetGeneration = 0

    /// A notification response that should be pushed by the roster's
    /// NavigationStack after the exact detached task has been activated.
    @Published private(set) var notificationChat: Chat?

    private var client: CompanionClient?
    /// Ciphertext-only operations survive navigation and transient
    /// disconnects so a retry cannot accidentally reseal the same value with
    /// a different HPKE operation id. Nothing here is persisted to disk.
    private var preparedPhoneCredentials: [String: PreparedPhoneCredential] = [:]
    /// The device token, kept in memory so the client can be rebuilt when the
    /// dial moves to another stored host. The keychain remains the only place
    /// it is persisted.
    private var token: String?
    /// Which of the connection's stored hosts the next attempt dials. The
    /// walk advances on address-shaped failures and the winner is promoted —
    /// and persisted — when a stream goes live.
    private var rotation = CandidateRotation(hosts: [])
    private var streamTask: Task<Void, Never>?
    /// Best-effort authenticated route refresh started by the latest live SSE
    /// hello. Kept separate so endpoint discovery never stalls event delivery.
    private var endpointRefreshTask: Task<Void, Never>?
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    private var reconnectDelay: UInt64 = 0
    /// How many computer panels are open. A count rather than a flag: the
    /// panel can be pushed twice in a navigation stack, and the last one to
    /// close is the one that should turn screens back off.
    private var screenWatchers = 0
    /// Authenticated avatar bytes shared by roster, header, group and task
    /// surfaces. Both entry count and byte cost are bounded because one valid
    /// uploaded image may be 10 MB.
    private let avatarCache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.countLimit = 64
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    /// Concurrent first renders share one download. The id prevents an old
    /// request finishing after sign-out from removing a newer pairing's task
    /// for the same attachment path.
    private var avatarFetches: [String: (id: UUID, task: Task<Data?, Never>)] = [:]
    private var avatarCacheGeneration = 0
    /// Full image bytes are already fetched to draw a thumbnail. Keep a small,
    /// cost-bounded window so tapping that thumbnail opens immediately instead
    /// of downloading the same image twice.
    private let attachmentCache: NSCache<NSString, CachedAttachmentDownload> = {
        let cache = NSCache<NSString, CachedAttachmentDownload>()
        cache.countLimit = 12
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    private var attachmentCacheGeneration = 0
    /// An ambiguous network failure may happen after the server accepted a
    /// message. Reusing this id for the exact same retained draft makes Retry
    /// idempotent instead of sending the attachment twice.
    private var attachmentSendIDs: [AttachmentDraftKey: String] = [:]
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false
    /// A notification can cold-launch the app before protected Keychain data
    /// is available. Retain the last explicitly tapped destination until the
    /// paired client can be rebuilt after unlock.
    private var pendingNotification: NotificationTarget?

    /// The exact route the current client will use for a credential write.
    var phoneCredentialTransportIsProtected: Bool {
        client?.connection.activeEndpoint?.protectsCredentials == true
    }

    private struct AttachmentDraftKey: Hashable {
        let destination: MessageDestination
        let text: String
        let attachmentIDs: [UUID]
    }

    private var registry = CompanionConnectionRegistry()
    // MARK: - Pairing

    init() {
        Self.removeStaleFilePreviews()
        _ = NotificationCoordinator.shared
        NotificationCoordinator.shared.responseHandler = { [weak self] target in
            Task { @MainActor in await self?.openNotification(target) }
        }
#if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if (arguments.contains("-store-preview") || arguments.contains("-computer-switcher-preview")),
           let url = Bundle.main.url(forResource: "StorePreview", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            let preview = Connection(
                id: "preview-current",
                name: "Milind’s MacBook Pro",
                host: "preview.tailnet.ts.net",
                port: 8810
            )
            connection = preview
            if arguments.contains("-computer-switcher-preview") {
                let other = Connection(
                    id: "preview-other",
                    name: "MacBook Air",
                    host: "air.tailnet.ts.net",
                    port: 8810
                )
                registry = CompanionConnectionRegistry(
                    connections: [preview, other],
                    activeConnectionID: preview.id
                )
                connections = registry.connections
            } else {
                connections = [preview]
            }
            state.hydrate(fleet)
            status = .live
            return
        }
#endif
        restore()
        Task { await refreshNotificationAuthorization() }
    }

    /// Rebuild the selected connection at launch, migrating the previous
    /// single-computer record the first time a multi-computer build runs.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        registry = OpenMausSharedConnectionStore.loadRegistry()
        connections = registry.connections
        // The Share extension can target any saved computer, not only the
        // one active at launch. Move every inactive pre-extension token into
        // the shared Keychain group now; the active token is read below so
        // its locked/error state can still drive the visible connection UI.
        for saved in registry.connections where saved.id != registry.activeConnectionID {
            _ = try? Keychain.token(for: saved.id)
        }
        restoreSelectedConnection()
    }

    /// Find the first selected pairing whose Keychain token still exists.
    /// A missing token is a genuinely unusable saved record; a locked
    /// Keychain is temporary and must leave the record untouched.
    private func restoreSelectedConnection() {
        guard let saved = registry.activeConnection else {
            clearActiveConnection()
            return
        }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this device to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else {
            registry.remove(id: saved.id)
            persistRegistry()
            connections = registry.connections
            restoreSelectedConnection()
            return
        }

        configureActiveConnection(saved, token: stored)
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(
        with connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String
    ) async throws {
        var invited = connection
        // QR invites already carry this policy. Manual entry reaches the
        // session as a parsed Connection, so establish the same consent
        // boundary here before any health probe or credential redemption.
        if invited.allowedRouteKinds == nil {
            invited.establishRoutePolicyFromInvite()
        }
        // A 12-character code pairs with a server directly (its own sessions,
        // a client-scope bearer); anything else is the companion sidecar's.
        if let code = PairingInvite.normalizedServerCode(credential) {
            let paired = try await CompanionClient.pairWithServer(
                connection: invited,
                code: code,
                label: deviceName,
                attemptId: pairRequestId
            )
            var stored = invited
            if !paired.environment.label.isEmpty { stored.name = paired.environment.label }
            stored.serverEnvironmentId = paired.environment.environmentId
            stored.companionDeviceId = nil
            if let existing = registry.matchingConnection(for: stored) {
                stored.id = existing.id
            }
            try commitPairing(stored, token: paired.token)
            return
        }
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: invited,
            credential: credential,
            deviceName: deviceName,
            pairRequestId: pairRequestId
        )
        let paired = outcome.response
        // prefer the name the computer calls itself over the Bonjour label
        var stored = outcome.connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }
        stored.companionDeviceId = paired.device.id
        // The computer knows every address it answers on, but redemption may
        // not widen the explicit route consent carried by the invite.
        stored.applyPairingAdvertisement(hosts: paired.hosts, endpoints: paired.endpoints)
        let winner = outcome.connection.activeEndpoint ?? CompanionEndpoint.direct(
            host: outcome.connection.host,
            port: outcome.connection.port,
            priority: 10_000
        )
        if let winner { stored.promote(winner) }
        if stored.endpoints?.isEmpty != false {
            stored.hosts = Array(stored.orderedHosts.prefix(8))
        }
        if let existing = registry.matchingConnection(for: stored) {
            stored.id = existing.id
        }
        try commitPairing(stored, token: paired.token, winner: winner)
    }

    /// The device token goes to the keychain and the connection to defaults —
    /// deliberately apart, so the thing that gets backed up is never the
    /// credential. Shared by companion and server pairing; `winner` is the
    /// route that answered, which a server pairing (one route) has no use for.
    private func commitPairing(_ stored: Connection, token: String, winner: CompanionEndpoint? = nil) throws {
        try Keychain.save(token, for: stored.id)
        let firstPairing = registry.connections.isEmpty
        var updatedRegistry = registry
        updatedRegistry.upsert(stored)
        // Write the first-pair education marker before making the connection
        // restorable. If the process stops between these writes, an orphan
        // marker is harmless while unpaired; the reverse order could restore
        // a pairing which permanently skipped this step.
        // RootView may not have received iOS's notification status yet, and
        // the app may be relaunched before that asynchronous lookup finishes.
        CompanionPairingCommitSequence.persist {
            if firstPairing {
                UserDefaults.standard.set(
                    true,
                    forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
                )
            }
        } saveConnection: {
            OpenMausSharedConnectionStore.saveRegistry(updatedRegistry)
        }

        stopActiveRuntime()
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .pairingSucceeded
        )
        pairingRequested = false
        registry = updatedRegistry
        connections = registry.connections
        self.connection = stored
        self.token = token
        let liveRoutes = winner.map { route in
            [route] + stored.orderedEndpoints.filter { $0.url != route.url }
        } ?? stored.orderedEndpoints
        self.rotation = CandidateRotation(endpoints: liveRoutes)
        self.client = CompanionClient(
            connection: winner.map(stored.dialing) ?? stored,
            token: token
        )
        self.state = CompanionState()
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
    }

    func receivePairingURL(_ url: URL) {
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .received(invite)
        )
        pairingRequested = true
    }

    func beginPairing() {
        pairingRequested = true
    }

    func endPairing() {
        pairingRequested = false
        consumePairingInvite()
    }

    func consumePairingInvite() {
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .consumed
        )
    }

    func switchComputer(to id: String) {
        guard let saved = registry.connection(id: id) else { return }
        if connection?.id == id {
            restartStream()
            connect()
            return
        }

        let stored: String?
        do {
            stored = try Keychain.token(for: id)
        } catch {
            actionError = (error as? KeychainError)?.isLocked == true
                ? "Unlock this device, then try switching computers again."
                : error.localizedDescription
            return
        }
        guard let stored else {
            actionError = "This saved connection is no longer available on this device. Remove it and pair again."
            return
        }

        stopActiveRuntime()
        registry.select(id: id)
        persistRegistry()
        connections = registry.connections
        configureActiveConnection(saved, token: stored)
        connect()
    }

    func forgetConnection(id: String) {
        guard let forgotten = registry.connection(id: id) else { return }
        let wasActive = registry.activeConnectionID == id
        // A server session is ended on the server too, best effort: the
        // bearer is discarded locally either way.
        if forgotten.pairedWithServer, let token = try? Keychain.token(for: id) {
            let client = CompanionClient(connection: forgotten, token: token)
            Task.detached { try? await client.logout() }
        }
        if wasActive { stopActiveRuntime() }
        preparedPhoneCredentials = preparedPhoneCredentials.filter { $0.value.connectionID != id }
        Keychain.remove(id)
        registry.remove(id: id)
        persistRegistry()
        connections = registry.connections
        guard wasActive else { return }

        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        restoreSelectedConnection()
        if connection != nil { connect() }
        if connections.isEmpty {
            UserDefaults.standard.removeObject(
                forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
            )
        }
    }

    /// Compatibility for the existing revoked-pairing and detail actions:
    /// sign out now means remove only the selected computer.
    func signOut() {
        guard let id = connection?.id ?? registry.activeConnectionID else {
            clearActiveConnection()
            return
        }
        forgetConnection(id: id)
    }

    private func clearActiveConnection() {
        resetCredentialEntry()
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        restorePending = false
        pendingNotification = nil
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .signedOut
        )
        pairingRequested = false
        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        resetAvatarCache()
        resetAttachmentCache()
        attachmentSendIDs.removeAll()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
    }

    private func configureActiveConnection(_ saved: Connection, token stored: String) {
        connection = saved
        token = stored
        // New connections honor the desktop's transport policy. Automatic
        // walking is credential-safe: protected routes stay protected, while
        // a legacy/local route is only tried when it was the exact saved route.
        rotation = CandidateRotation(endpoints: saved.orderedEndpoints)
        let first = rotation.currentEndpoint.map(saved.dialing) ?? saved
        client = CompanionClient(connection: first, token: stored)
        status = .connecting
    }

    private func stopActiveRuntime() {
        resetCredentialEntry()
        streamGeneration += 1
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        restorePending = false
        endLinger()
        pendingNotification = nil
        screenWatchers = 0
        client = nil
        token = nil
        state = CompanionState()
        resetAvatarCache()
        resetAttachmentCache()
        attachmentSendIDs.removeAll()
        NotificationCoordinator.shared.setBadge(0)
    }

    private func persistRegistry() {
        OpenMausSharedConnectionStore.saveRegistry(registry)
    }

    private func persistActiveConnection(_ updated: Connection) {
        registry.upsert(updated, makeActive: false)
        connection = updated
        connections = registry.connections
        persistRegistry()
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        if client != nil, let pendingNotification {
            self.pendingNotification = nil
            Task { [weak self] in await self?.openNotification(pendingNotification) }
        }
        // back before the grace period ran out: keep the stream, drop the task
        endLinger()
        guard client != nil, streamTask == nil else { return }
        reconnectDelay = 0
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run()
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        screenWatchers += 1
        if screenWatchers == 1 { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        screenWatchers = max(0, screenWatchers - 1)
        if screenWatchers == 0 {
            state.clearScreen(botId)
            restartStream()
        }
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        streamTask?.cancel()
        streamTask = nil
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        resetCredentialEntry()
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        endLinger()
    }

    private func resetCredentialEntry() {
        credentialEntryResetGeneration &+= 1
    }

    private var lingerTask: UIBackgroundTaskIdentifier = .invalid
    private var lingerSleep: Task<Void, Never>?

    /// Leaving the screen: keep the stream alive for the grace period iOS
    /// allows (~30 s) rather than cutting it at once, so an approval that
    /// lands right after you swipe home still reaches the Live Activity and
    /// the island. After that, iOS suspends us anyway; disconnect cleanly so
    /// the cursor is written down at a known point.
    func linger() {
        guard streamTask != nil, lingerTask == .invalid else { disconnect(); return }
        // A previous request can leave a sleeper behind when iOS refuses the
        // background assertion. Never let it outlive the assertion it belongs
        // to or disconnect a later linger window.
        lingerSleep?.cancel()
        lingerSleep = nil
        let task = UIApplication.shared.beginBackgroundTask(withName: "companion.linger") { [weak self] in
            // time is up before our own timer — the system wants us gone now
            self?.disconnect()
        }
        guard task != .invalid else { disconnect(); return }
        lingerTask = task
        lingerSleep = Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard !Task.isCancelled, let self, self.lingerTask != .invalid else { return }
            self.disconnect()
        }
    }

    private func endLinger() {
        lingerSleep?.cancel()
        lingerSleep = nil
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    private func run() async {
        while !Task.isCancelled {
            guard let client else { return }
            status = .connecting
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(since: state.cursor, screens: screenWatchers > 0) {
                    if Task.isCancelled { return }
                    reconnectDelay = 0

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            try await hydrate()
                            state.resetCursor(cursor)
                        }
                        status = .live
                        // Remember what actually carried the stream for
                        // display and legacy ordering. Typed routes retain
                        // their explicit security priority next launch.
                        rememberWorkingRoute()
                        refreshConnectionMetadata(using: client)
                        continue
                    }
                    state.apply(frame)
                    if case let .notify(notification) = frame.frame {
                        NotificationCoordinator.shared.deliver(notification, sequence: frame.seq)
                    }
                    NotificationCoordinator.shared.setBadge(state.unreadCount)
                    state.advance(to: frame.seq)
                }
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                status = .offline("Lost the connection.")
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                status = .offline(failureMessage(for: error))
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s. A phone that woke on a network which is
            // not the laptop's should not hammer it.
            reconnectDelay = reconnectDelay == 0 ? 1 : min(reconnectDelay * 2, 15)
            try? await Task.sleep(nanoseconds: reconnectDelay * 1_000_000_000)
        }
    }

    private func hydrate() async throws {
        guard let client else { return }
        let fleet = try await client.fleet(messages: 50)
        log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
        state.hydrate(fleet)
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    // MARK: - Which address to dial

    /// Turn a stream failure into advice a person can act on — and, when the
    /// failure is about the address rather than the pairing, move the dial to
    /// the next stored host so the retry that follows tries somewhere new.
    /// A 401 never reaches here: the unauthorized path returns above, which
    /// is what keeps a token problem from masquerading as an address walk.
    private func failureMessage(for error: Error) -> String {
        guard let connection else { return error.localizedDescription }
        let failed = rotation.currentEndpoint ?? connection.activeEndpoint ??
            CompanionEndpoint.direct(host: connection.host, port: connection.port, priority: 10_000)
        var next: String?
        if let candidate = rotation.advanceEndpoint(after: error), let token {
            client = CompanionClient(connection: connection.dialing(candidate), token: token)
            next = candidate.displayAddress
            log.info("advancing to companion route \(candidate.url, privacy: .public)")
        }
        if let urlError = error as? URLError {
            return ConnectionAdvice.message(
                for: urlError.code,
                host: failed?.displayAddress ?? connection.host,
                port: failed?.port ?? connection.port,
                tryingNext: next
            )
        }
        if let apiError = error as? APIError,
           case let .status(code, _) = apiError,
           ConnectionAdvice.shouldTryAnotherRoute(after: error) {
            return ConnectionAdvice.message(
                forGatewayStatus: code,
                host: failed?.displayAddress ?? connection.host,
                tryingNext: next
            )
        }
        return error.localizedDescription
    }

    /// Persist the route that carried a live stream. Legacy host lists promote
    /// it for the next launch; typed lists keep their explicit policy order.
    private func rememberWorkingRoute() {
        guard let winner = rotation.currentEndpoint, var updated = connection,
              updated.activeEndpoint?.url != winner.url else { return }
        updated.promote(winner)
        persistActiveConnection(updated)
    }

    /// Learn routes enabled after this phone originally paired. The endpoint
    /// response is authenticated with the existing device token and is a
    /// replacement snapshot, but failure is deliberately non-fatal: older
    /// sidecars return 404 and a transient refresh error must not tear down a
    /// perfectly healthy event stream.
    private func refreshConnectionMetadata(using sourceClient: CompanionClient) {
        guard let connectionID = connection?.id else { return }
        let workingEndpoint = rotation.currentEndpoint ?? sourceClient.connection.activeEndpoint
        endpointRefreshTask?.cancel()
        endpointRefreshTask = Task { [weak self] in
            do {
                let metadata = try await sourceClient.connectionMetadata()
                try Task.checkCancellation()
                guard let self,
                      self.connection?.id == connectionID,
                      self.client?.connection.baseURL == sourceClient.connection.baseURL,
                      var updated = self.connection
                else { return }

                updated.reconcile(metadata)
                self.persistActiveConnection(updated)

                // Keep the currently live route first until this stream ends.
                // CandidateRotation applies the same no-downgrade policy used
                // by pairing, while the saved connection uses advertised
                // security priorities on the next launch.
                let liveRoutes = workingEndpoint.map { route in
                    [route] + updated.orderedEndpoints.filter { $0.url != route.url }
                } ?? updated.orderedEndpoints
                self.rotation = CandidateRotation(endpoints: liveRoutes)
                log.info("refreshed \(metadata.endpoints.count, privacy: .public) companion routes")
            } catch is CancellationError {
                return
            } catch {
                log.debug("endpoint refresh unavailable: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Replace the stored address by hand, keeping the pairing and its token.
    /// False when the text does not parse as a host or host:port.
    @discardableResult
    func updateAddress(_ text: String) -> Bool {
        guard var updated = connection, let parsed = Connection.parse(text) else { return false }
        guard let endpoint = parsed.activeEndpoint ?? CompanionEndpoint.direct(
            host: parsed.host,
            port: parsed.port,
            priority: 0
        ) else { return false }
        updated.resetRoutePolicy(selecting: endpoint)
        persistActiveConnection(updated)
        rotation = CandidateRotation(endpoints: updated.orderedEndpoints)
        if let token {
            client = CompanionClient(connection: updated.dialing(endpoint), token: token)
        }
        // Dial the new address now rather than on the next backoff tick —
        // someone who just typed an address is watching the banner.
        restartStream()
        connect()
        return true
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. Nothing here writes to `state` optimistically: the harness is
    // the source of truth, and a phone that draws its own version of events
    // is a phone that disagrees with the laptop.

    func send(_ text: String, to chat: Chat) async {
        await perform {
            switch chat {
            case let .bot(bot): try await $0.send(text: text, toBot: bot.id)
            case let .room(room): try await $0.send(text: text, toRoom: room.id)
            }
        }
    }

    /// Send a composer draft with app-owned attachments. The destination
    /// includes the exact active thread at tap time, so neither a desktop task
    /// switch nor an upload delay can move the message elsewhere. Callers only
    /// clear their draft when this returns true.
    func send(
        text: String,
        attachments: [PendingMessageAttachment],
        to chat: Chat
    ) async -> Bool {
        guard let client else {
            actionError = "This computer is offline."
            return false
        }
        actionError = nil
        do {
            try AttachmentPolicy.validate(attachments)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty || !attachments.isEmpty else {
                actionError = "Write a message or attach a file first."
                return false
            }

            if attachments.contains(where: { $0.kind == .image }) {
                let capable: Set<String>
                do {
                    capable = try await client.imageCapableInstanceIDs()
                } catch APIError.status(code: 404, message: _) {
                    actionError = "Update OpenMausBot on this computer before sending images."
                    return false
                }
                guard imageSupported(by: chat, capableInstances: capable) else {
                    actionError = imageCompatibilityMessage(for: chat)
                    return false
                }
            }

            let destination: MessageDestination
            switch chat {
            case let .bot(bot):
                destination = .bot(id: bot.id, threadId: bot.threadId)
            case let .room(room):
                destination = .room(id: room.id, threadId: room.threadId)
            }
            let draftKey = AttachmentDraftKey(
                destination: destination,
                text: text,
                attachmentIDs: attachments.map(\.id)
            )
            if attachmentSendIDs.count >= 20, attachmentSendIDs[draftKey] == nil {
                attachmentSendIDs.removeAll(keepingCapacity: true)
            }
            let sendID = attachmentSendIDs[draftKey] ?? UUID().uuidString
            attachmentSendIDs[draftKey] = sendID

            var uploaded: [SharedAttachmentReference] = []
            uploaded.reserveCapacity(attachments.count)
            for attachment in attachments {
                try Task.checkCancellation()
                let mime = AttachmentPolicy.normalizedMIME(attachment.mime)
                switch attachment.kind {
                case .image:
                    let path = try await client.uploadImage(
                        data: attachment.data,
                        mime: mime,
                        uploadId: attachment.id.uuidString
                    )
                    uploaded.append(SharedAttachmentReference(
                        path: path,
                        kind: .image,
                        displayName: attachment.name
                    ))
                case .file:
                    let file = try await client.uploadFile(
                        data: attachment.data,
                        name: attachment.name,
                        mime: mime,
                        uploadId: attachment.id.uuidString
                    )
                    uploaded.append(SharedAttachmentReference(
                        path: file.path,
                        kind: .file,
                        displayName: file.name
                    ))
                }
            }

            let message = SharedMessageComposer.compose(
                instruction: text,
                text: [],
                urls: [],
                attachments: uploaded
            )
            try await client.send(text: message, to: destination, sendId: sendID)
            attachmentSendIDs.removeValue(forKey: draftKey)
            actionError = nil
            return true
        } catch is CancellationError {
            return false
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            actionError = error.localizedDescription
            return false
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    private func imageSupported(by chat: Chat, capableInstances: Set<String>) -> Bool {
        switch chat {
        case let .bot(bot):
            return capableInstances.contains(bot.modelSelection.instanceId)
        case let .room(room):
            return !room.memberIds.isEmpty && room.memberIds.allSatisfy { id in
                guard let bot = state.bot(id) else { return false }
                return capableInstances.contains(bot.modelSelection.instanceId)
            }
        }
    }

    private func imageCompatibilityMessage(for chat: Chat) -> String {
        switch chat {
        case let .bot(bot):
            return "\(bot.name)'s current model doesn't support images. Choose another model or remove the image."
        case .room:
            return "Every bot that may answer in this channel must use a model that supports images."
        }
    }

    /// Fetch one app-owned attachment through the message that introduced it.
    /// The caller owns presentation errors so a failed thumbnail or preview can
    /// explain itself beside the attachment that was tapped.
    func fetchAttachment(
        threadId: String,
        messageId: String,
        path: String,
        cacheResult: Bool = false
    ) async throws -> DownloadedFile {
        guard let client else {
            throw APIError.transport("This computer is offline.")
        }
        let cacheKey = "\(threadId)\u{1F}\(messageId)\u{1F}\(path)"
        if cacheResult,
           let cached = attachmentCache.object(forKey: cacheKey as NSString) {
            return cached.value
        }
        let generation = attachmentCacheGeneration
        do {
            // Keep this structured. When the row scrolls away SwiftUI cancels
            // its task, which now propagates directly into URLSession instead
            // of leaving a shared unstructured download running.
            let download = try await client.downloadFile(
                threadId: threadId,
                messageId: messageId,
                path: path
            )
            try Task.checkCancellation()
            guard generation == attachmentCacheGeneration else { throw CancellationError() }
            if cacheResult {
                attachmentCache.setObject(
                    CachedAttachmentDownload(download),
                    forKey: cacheKey as NSString,
                    cost: download.data.count
                )
            }
            return download
        } catch let error as APIError where error.isUnauthorized {
            // A cancelled request from the previous computer may finish after
            // a switch. Its 401 belongs to that old token and must not evict
            // the current live session.
            guard generation == attachmentCacheGeneration, !Task.isCancelled else {
                throw CancellationError()
            }
            status = .unauthorized
            throw error
        } catch {
            if Task.isCancelled || generation != attachmentCacheGeneration {
                throw CancellationError()
            }
            throw error
        }
    }

    /// Fetch and materialize an attachment in a protected temporary directory
    /// for Quick Look, markdown/text preview, and the system share sheet.
    func prepareAttachmentPreview(
        threadId: String,
        messageId: String,
        path: String,
        cacheResult: Bool = false
    ) async throws -> DownloadedFile {
        let download = try await fetchAttachment(
            threadId: threadId,
            messageId: messageId,
            path: path,
            cacheResult: cacheResult
        )
        try Task.checkCancellation()
        let preparation = Task.detached(priority: .userInitiated) {
            // Content-Disposition is the server's canonical, sanitised name.
            // The transport tag's `name` is presentation-only and must never
            // choose the on-disk preview/share filename.
            try Self.materializePreview(download: download, filename: download.filename)
        }
        let prepared = try await withTaskCancellationHandler {
            try await preparation.value
        } onCancel: {
            preparation.cancel()
        }
        do {
            try Task.checkCancellation()
            return prepared
        } catch {
            Self.removePreview(at: prepared.localURL)
            throw error
        }
    }

    /// Compatibility for file links in assistant markdown. User attachment
    /// cards use the throwing API above so their feedback remains local.
    func downloadFile(
        threadId: String,
        messageId: String,
        path: String
    ) async -> DownloadedFile? {
        actionError = nil
        do {
            let download = try await prepareAttachmentPreview(
                threadId: threadId,
                messageId: messageId,
                path: path
            )
            actionError = nil
            return download
        } catch is CancellationError {
            return nil
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    private func resetAttachmentCache() {
        attachmentCacheGeneration += 1
        attachmentCache.removeAllObjects()
    }

    nonisolated private static func materializePreview(
        download: DownloadedFile,
        filename: String
    ) throws -> DownloadedFile {
        let manager = FileManager.default
        let root = manager.temporaryDirectory
            .appendingPathComponent("OpenMausBotFilePreviews", isDirectory: true)
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try Task.checkCancellation()
        try manager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)
        do {
            try download.data.write(
                to: fileURL,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            try Task.checkCancellation()
            return DownloadedFile(
                data: download.data,
                filename: filename,
                contentType: download.contentType,
                localURL: fileURL
            )
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }

    nonisolated private static func removePreview(at fileURL: URL?) {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    private static func removeStaleFilePreviews() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenMausBotFilePreviews", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
    }

    func answer(chat: Chat, card: OptionCard, choice: String, rememberingPermission: Bool = true) async {
        guard let requestId = card.requestId else { return }
        if rememberingPermission, card.shouldRememberPermission(for: choice), case let .bot(bot) = chat {
            await alwaysAllow(bot: bot, card: card)
        }
        await answer(
            threadId: chat.threadId,
            requestId: requestId,
            choice: choice,
            isPermission: card.isPermission,
            reviewedSha256: card.skillRequest?.reviewedSha256
        )
    }

    /// Synchronously seal a credential before the caller starts an async
    /// request. The caller can then erase its input immediately and retain
    /// only this ciphertext value for an exact, idempotent retry.
    func prepareCredential(
        _ value: String,
        chat: Chat,
        message: Message,
        secret: SecretRequestCardData
    ) throws -> PreparedPhoneCredential {
        guard let client, let connection else {
            throw APIError.transport("This computer is offline.")
        }
        guard let publicKey = connection.secretPublicKey,
              let deviceId = connection.companionDeviceId,
              let target = secret.target,
              let requestKey = secret.requestKey
        else { throw PhoneSecretError.unavailable }
        guard client.connection.activeEndpoint?.protectsCredentials == true else {
            throw PhoneSecretError.insecureTransport
        }

        let botId = try credentialBotID(chat: chat, message: message)
        let context = PhoneSecretRequestContext(
            deviceId: deviceId,
            botId: botId,
            threadId: chat.threadId,
            messageId: message.id,
            target: target,
            requestKey: requestKey
        )
        let keyId = try PhoneSecretCrypto.publicKeyId(publicKey)
        let requestIdentity = phoneCredentialRequestIdentity(
            connectionID: connection.id,
            botID: botId,
            context: context,
            keyID: keyId
        )
        if let prepared = preparedPhoneCredentials[requestIdentity] {
            return prepared
        }
        let envelope = try PhoneSecretCrypto.encrypt(
            value,
            publicKey: publicKey,
            context: context
        )

        let prepared = PreparedPhoneCredential(
            requestIdentity: requestIdentity,
            connectionID: connection.id,
            botID: botId,
            messageID: message.id,
            envelope: envelope
        )
        preparedPhoneCredentials[requestIdentity] = prepared
        return prepared
    }

    /// Recover an ambiguous ciphertext-only operation when a card view is
    /// recreated. This is deliberately in-memory: a force-quit forgets it,
    /// while ordinary navigation, AutoFill, and reconnects do not.
    func preparedCredential(
        chat: Chat,
        message: Message,
        secret: SecretRequestCardData
    ) -> PreparedPhoneCredential? {
        guard let connection,
              let publicKey = connection.secretPublicKey,
              let deviceId = connection.companionDeviceId,
              let target = secret.target,
              let requestKey = secret.requestKey,
              let botId = try? credentialBotID(chat: chat, message: message),
              let keyId = try? PhoneSecretCrypto.publicKeyId(publicKey)
        else { return nil }
        let context = PhoneSecretRequestContext(
            deviceId: deviceId,
            botId: botId,
            threadId: chat.threadId,
            messageId: message.id,
            target: target,
            requestKey: requestKey
        )
        return preparedPhoneCredentials[phoneCredentialRequestIdentity(
            connectionID: connection.id,
            botID: botId,
            context: context,
            keyID: keyId
        )]
    }

    func discardPreparedCredential(_ prepared: PreparedPhoneCredential) {
        if preparedPhoneCredentials[prepared.requestIdentity] == prepared {
            preparedPhoneCredentials.removeValue(forKey: prepared.requestIdentity)
        }
    }

    private func credentialBotID(chat: Chat, message: Message) throws -> String {
        switch chat {
        case let .bot(bot): return bot.id
        case .room:
            guard let sender = message.from?.botId else {
                throw PhoneSecretError.invalidRequest
            }
            return sender
        }
    }

    private func phoneCredentialRequestIdentity(
        connectionID: String,
        botID: String,
        context: PhoneSecretRequestContext,
        keyID: String
    ) -> String {
        [
            connectionID,
            keyID,
            botID,
            context.threadId,
            context.messageId,
            context.target,
            context.requestKey,
        ].joined(separator: "\u{0}")
    }

    /// Send one already-sealed operation. A retry deliberately reuses the
    /// same HPKE envelope; the desktop derives its idempotency key from these
    /// bytes, so a lost response cannot cause a second provider save.
    func provideCredential(_ prepared: PreparedPhoneCredential) async throws {
        guard let client, let connection else {
            throw APIError.transport("This computer is offline.")
        }
        guard connection.id == prepared.connectionID,
              connection.companionDeviceId == prepared.envelope.deviceId,
              let publicKey = connection.secretPublicKey,
              (try? PhoneSecretCrypto.publicKeyId(publicKey)) == prepared.envelope.keyId
        else { throw PhoneSecretError.unavailable }
        guard client.connection.activeEndpoint?.protectsCredentials == true else {
            throw PhoneSecretError.insecureTransport
        }

        do {
            try await client.provideCredential(
                botId: prepared.botID,
                messageId: prepared.messageID,
                envelope: prepared.envelope
            )
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    /// The same answer, from something that only has the ids — the Live
    /// Activity's buttons.
    func answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Bool,
        reviewedSha256: String? = nil
    ) async {
        await perform {
            // Permission cards answer allow/deny; a question answers with
            // the chosen text. The harness tells them apart by `behavior`.
            let behavior = OptionCard.responseBehavior(for: choice, isPermission: isPermission)
            if behavior != "answer" {
                try await $0.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: behavior,
                    reviewedSha256: behavior == "allow" ? reviewedSha256 : nil
                )
            } else {
                try await $0.respond(threadId: threadId, requestId: requestId, behavior: "answer", message: choice)
            }
        }
    }

    /// "Always allow" — the grant key comes from the card, never from
    /// anything derived here, so the phone and the harness cannot disagree
    /// about what was just permitted.
    func alwaysAllow(bot: Bot, card: OptionCard) async {
        guard let key = card.allowKey else { return }
        await perform { try await $0.alwaysAllow(botId: bot.id, key: key) }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        do {
            let bot = try await client.createBot()
            state.apply(.bot(bot))
            return bot
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Make a room from the phone. Same shape as `createBot`: fold it in
    /// rather than wait for a broadcast, and hand it back so it can be opened.
    @discardableResult
    func createRoom(name: String?, memberIds: [String]) async -> Room? {
        guard let client else { return nil }
        do {
            let room = try await client.createRoom(name: name, memberIds: memberIds)
            state.apply(.room(room))
            return room
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Create a sidebar section by assigning its complete starting set in one
    /// request. The server commits the batch before returning, then these
    /// folds make the roster move immediately instead of waiting for SSE.
    @discardableResult
    func assignSection(name: String, botIds: [String]) async -> [Bot]? {
        guard let client else { return nil }
        do {
            let bots = try await client.assignSection(name: name, botIds: botIds)
            for bot in bots { state.apply(.bot(bot)) }
            return bots
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        await perform { try await $0.interrupt(botId: bot.id) }
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.cloudDesktop(botId: bot.id).url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    func markRead(_ chat: Chat) async {
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
        } catch {
            actionError = error.localizedDescription
        }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        try? await client?.image(threadId: threadId, messageId: messageId)
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        do { return try await client.search(trimmed) }
        catch {
            actionError = error.localizedDescription
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId)
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               var room = state.rooms.first(where: { $0.id == groupId }) {
                if room.threadId != hit.threadId {
                    room = try await client.switchTask(groupId: room.id, threadId: hit.threadId)
                    state.apply(.room(room))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.rooms.first(where: { $0.id == groupId }).map(Chat.room)
            }
        } catch { actionError = error.localizedDescription }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    func createTask(for bot: Bot, title: String?) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.createTask(botId: bot.id, title: title))) }
        catch { actionError = error.localizedDescription }
    }

    func switchTask(_ task: BotTask, for bot: Bot) async {
        guard let client, task.threadId != bot.threadId else { return }
        do { state.apply(.bot(try await client.switchTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func renameTask(_ task: BotTask, for bot: Bot, title: String) async {
        guard let client else { return }
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            await refresh()
        } catch { actionError = error.localizedDescription }
    }

    func deleteTask(_ task: BotTask, for bot: Bot) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.deleteTask(botId: bot.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func createTask(for room: Room, title: String?) async {
        guard let client else { return }
        do { state.apply(.room(try await client.createTask(groupId: room.id, title: title))) }
        catch { actionError = error.localizedDescription }
    }

    func switchTask(_ task: BotTask, for room: Room) async {
        guard let client, task.threadId != room.threadId else { return }
        do { state.apply(.room(try await client.switchTask(groupId: room.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    func renameTask(_ task: BotTask, for room: Room, title: String) async {
        guard let client else { return }
        do {
            try await client.renameTask(groupId: room.id, threadId: task.threadId, title: title)
            await refresh()
        } catch { actionError = error.localizedDescription }
    }

    func deleteTask(_ task: BotTask, for room: Room) async {
        guard let client else { return }
        do { state.apply(.room(try await client.deleteTask(groupId: room.id, threadId: task.threadId))) }
        catch { actionError = error.localizedDescription }
    }

    // MARK: - Agent profile

    /// The model catalog lives on the paired computer because availability
    /// depends on which engines are installed and signed in there.
    func modelInstances() async -> [Instance] {
        guard let client else { return [] }
        do {
            return try await client.instances()
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return []
        }
    }

    func updateModel(_ selection: ModelSelection, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateModel(botId: bot.id, selection: selection)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func updateProfile(_ patch: BotProfilePatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateProfile(botId: bot.id, patch: patch)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func uploadAvatar(_ data: Data, mime: String, for bot: Bot, crop: AvatarCrop) async -> Bot? {
        guard let client else { return nil }
        do {
            let avatarUrl = try await client.uploadAvatar(data: data, mime: mime)
            guard !Task.isCancelled else { return nil }
            let current = state.bot(bot.id) ?? bot
            return await updateProfile(
                BotProfilePatch(avatarUrl: .set(avatarUrl), avatarCrop: crop),
                for: current
            )
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func generateAvatar(prompt: String, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.generateAvatar(botId: bot.id, prompt: prompt)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            if !Task.isCancelled { actionError = error.localizedDescription }
            return nil
        }
    }

    func avatarData(for bot: Bot) async -> Data? {
        guard let path = bot.avatarUrl, let client else { return nil }
        let key = path as NSString
        if let cached = avatarCache.object(forKey: key) { return cached as Data }
        let generation = avatarCacheGeneration
        let fetch: (id: UUID, task: Task<Data?, Never>)
        if let pending = avatarFetches[path] {
            fetch = pending
        } else {
            let pending = (
                id: UUID(),
                task: Task<Data?, Never> { try? await client.avatar(path: path) }
            )
            avatarFetches[path] = pending
            fetch = pending
        }
        let data = await fetch.task.value
        if avatarFetches[path]?.id == fetch.id { avatarFetches.removeValue(forKey: path) }
        guard !Task.isCancelled, generation == avatarCacheGeneration, let data else { return nil }
        avatarCache.setObject(data as NSData, forKey: key, cost: data.count)
        return data
    }

    private func resetAvatarCache() {
        avatarCacheGeneration += 1
        for fetch in avatarFetches.values { fetch.task.cancel() }
        avatarFetches.removeAll()
        avatarCache.removeAllObjects()
    }

    func voiceOptions() async -> [Voice] {
        guard let client else { return [] }
        do { return try await client.voices() }
        catch { actionError = error.localizedDescription; return [] }
    }

    func previewVoice(_ voiceId: String, for bot: Bot) async -> Data? {
        guard let client else { return nil }
        do { return try await client.previewVoice(text: "Hello, I'm \(bot.name).", voiceId: voiceId) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func configStatus() async -> ConfigStatus? {
        guard let client else { return nil }
        return try? await client.config()
    }

    func botOverview(for bot: Bot) async -> BotOverview? {
        guard let client else { return nil }
        let connectionID = connection?.id
        do {
            let overview = try await client.overview(botId: bot.id)
            guard !Task.isCancelled, connection?.id == connectionID else { return nil }
            return overview
        } catch {
            guard !Task.isCancelled, connection?.id == connectionID else { return nil }
            guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return nil }
            actionError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Routines

    func loadRoutines() async -> (routines: [Routine], runs: [RoutineRun]) {
        guard let client else { return ([], []) }
        do { return try await client.routines() }
        catch { actionError = error.localizedDescription; return ([], []) }
    }

    func loadRoutineRunAvailability() async -> RoutineRunAvailability? {
        guard let client else { return nil }
        do {
            async let config = client.config()
            async let instances = client.instances()
            return try await RoutineRunAvailability(config: config, instances: instances)
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func saveRoutine(_ input: RoutineInput, id: String?) async -> Routine? {
        guard let client else { return nil }
        do {
            if let id { return try await client.updateRoutine(id: id, input: input) }
            return try await client.createRoutine(input)
        } catch { actionError = error.localizedDescription; return nil }
    }

    func setRoutineEnabled(_ routine: Routine, enabled: Bool) async -> Routine? {
        guard let client else { return nil }
        do { return try await client.setRoutineEnabled(id: routine.id, enabled: enabled) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func runRoutine(_ routine: Routine) async -> RoutineRun? {
        guard let client else { return nil }
        do { return try await client.runRoutine(id: routine.id) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func deleteRoutine(_ routine: Routine) async -> Bool {
        guard let client else { return false }
        do { try await client.deleteRoutine(id: routine.id); return true }
        catch { actionError = error.localizedDescription; return false }
    }

    // MARK: - Notification navigation

    func openNotification(_ target: NotificationTarget) async {
        guard let client else {
            // Do not carry a stale destination into a future, unrelated
            // pairing. Only a saved connection waiting for Keychain access is
            // eligible for replay.
            if restorePending {
                pendingNotification = target
                connect()
            } else {
                actionError = "Pair this device with your computer to open that task."
            }
            return
        }
        pendingNotification = nil
        do {
            var bot = state.bot(target.botId)
            if bot == nil {
                let fleet = try await client.fleet(messages: 50)
                state.hydrate(fleet)
                bot = state.bot(target.botId)
            }
            // A room's approval/question notification carries the asker bot
            // with the ROOM's thread id — open the room rather than asking
            // the bot to switch to a thread it does not own (a 404).
            if var room = state.rooms.first(where: {
                $0.threadId == target.threadId || ($0.tasks ?? []).contains(where: { $0.threadId == target.threadId })
            }) {
                if room.threadId != target.threadId {
                    do {
                        room = try await client.switchTask(groupId: room.id, threadId: target.threadId)
                        state.apply(.room(room))
                    } catch {
                        // A stale notification should still open the channel's
                        // current task instead of leaving the person nowhere.
                    }
                }
                notificationChat = .room(room)
                return
            }
            guard var selected = bot else { throw APIError.status(code: 404, message: "That agent no longer exists.") }
            if target.requiresTaskSwitch(activeThreadId: selected.threadId) {
                do {
                    selected = try await client.switchTask(botId: selected.id, threadId: target.threadId)
                    state.apply(.bot(selected))
                } catch {
                    // The thread may be gone (task deleted, stale payload).
                    // Landing in the bot's current chat still beats an error
                    // banner and no navigation at all.
                }
            }
            notificationChat = .bot(selected)
        } catch { actionError = error.localizedDescription }
    }

    func consumeNotificationChat() { notificationChat = nil }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            state.apply(.messagePatch(threadId: threadId, message: patched))
        } catch { actionError = error.localizedDescription }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id)
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { actionError = error.localizedDescription }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Connected apps

    func loadConnectorCatalog() async -> ConnectorCatalog? {
        guard let client else { return nil }
        do { return try await client.connectorCatalog() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func loadAllConnectorStatuses() async -> ConnectorStatuses? {
        guard let client else { return nil }
        do { return try await client.allConnectorStatuses() }
        catch { actionError = error.localizedDescription; return nil }
    }

    func authorizeConnector(_ slug: String, alias: String?) async -> URL? {
        guard let client else { return nil }
        do { return try await client.authorizeConnector(slug: slug, alias: alias) }
        catch { actionError = error.localizedDescription; return nil }
    }

    func refreshNotificationAuthorization() async {
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
        notificationAuthorizationResolved = true
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async {
        guard let client else { return }
        do {
            try await body(client)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch {
            if !quietly { actionError = error.localizedDescription }
        }
    }
}

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
enum Chat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var isBot: Bool {
        if case .bot = self { return true }
        return false
    }

    var supportsTasks: Bool {
        switch self {
        case .bot: return true
        // `tasks == nil` means an older paired desktop. Hide the affordance
        // instead of sending it a route it does not know yet.
        case let .room(room): return room.dm != true && room.tasks != nil
        }
    }

    var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.busyBotId != nil
        }
    }

    var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when the thread last moved. Both come out
/// of the same message — the last one in the transcript.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.id }
}

extension CompanionState {
    /// Everything worth showing in the chat list: pinned first, then unread,
    /// then most recently active. Hidden bots stay hidden.
    ///
    /// The derived fields are computed once here rather than asked for as the
    /// list is sorted and filtered. Each one walks a thread's messages to
    /// reach the last of them, and a comparator is called O(n log n) times
    /// while the search predicate runs over every chat on every keystroke —
    /// so the same transcript was being traversed dozens of times per frame
    /// to produce an answer that had not changed. One pass, then sort the
    /// results.
    /// - Parameter activity: how much of a bot's working-out the reader has
    ///   asked to see. The preview honours it the same way the transcript
    ///   does; `lastActivity` deliberately does not, because a thread that
    ///   just ran a tool has still moved and should still rise in the list.
    func chatSummaries(activity: ActivityDetail = .full) -> [ChatSummary] {
        let bots = self.bots.filter { $0.hidden != true }.map(Chat.bot)
        let rooms = self.rooms.map(Chat.room)
        return (bots + rooms)
            .map { chat in
                let messages = visibleTranscript(forThread: chat.threadId)
                return ChatSummary(
                    chat: chat,
                    preview: rosterPreview(messages, detail: activity),
                    lastActivity: messages.last?.at ?? 0,
                    pinned: Self.pinned(chat)
                )
            }
            .sorted { left, right in
                if left.pinned != right.pinned { return left.pinned }
                if left.chat.unread != right.chat.unread { return left.chat.unread }
                return left.lastActivity > right.lastActivity
            }
    }

    private static func pinned(_ chat: Chat) -> Bool {
        if case let .bot(bot) = chat { return bot.pinned ?? false }
        return false
    }

}
