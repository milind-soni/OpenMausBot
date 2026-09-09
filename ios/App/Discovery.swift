// Finding computers on the network, so nobody types an IP address.
//
// The other half of `server/mdns.ts`: the harness advertises
// `_openmausbot._tcp` while its companion listener is up, and this browses
// for it. NWBrowser is first-party and does the mDNS work; all that is left
// is resolving each result to a host and port.
//
// Requires NSLocalNetworkUsageDescription and NSBonjourServices in the app's
// Info.plist — without them iOS returns no results at all, silently, which
// is a confusing hour if you don't know to look.
import Foundation
import Network
import CompanionCore
import SwiftUI

@MainActor
final class Discovery: ObservableObject {
    struct Found: Identifiable, Hashable {
        /// The Bonjour instance name — the human label the harness derived
        /// from the profile name, e.g. "Ada Lovelace's computer".
        let name: String
        let endpoint: NWEndpoint

        var id: String { name }
    }

    @Published private(set) var found: [Found] = []
    @Published private(set) var browsing = false
    /// Set when the browser could not start at all — almost always the
    /// missing Info.plist keys, so it is worth surfacing rather than
    /// showing an empty list forever.
    @Published private(set) var failure: LocalizedStringKey?

    private var browser: NWBrowser?
    private var retryTask: Task<Void, Never>?
    private var retryCount = 0
    private var generation = 0
    private var shouldBrowse = false

    func start() {
        guard !shouldBrowse else { return }
        shouldBrowse = true
        retryCount = 0
        startBrowser()
    }

    private func startBrowser() {
        guard shouldBrowse, browser == nil else { return }
        retryTask = nil
        generation += 1
        let currentGeneration = generation
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(
            for: .bonjour(type: "_openmausbot._tcp", domain: nil),
            using: parameters
        )

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.generation == currentGeneration else { return }
                switch state {
                case .ready:
                    self.retryCount = 0
                    self.browsing = true
                    self.failure = nil
                case let .waiting(error):
                    self.browsing = false
                    self.failure = Self.failureMessage(for: error)
                case let .failed(error):
                    self.handleFailure(error)
                case .cancelled:
                    self.browsing = false
                default:
                    break
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap { result -> Found? in
                guard case let .service(name, _, _, _) = result.endpoint else { return nil }
                return Found(name: name, endpoint: result.endpoint)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            Task { @MainActor in self?.found = found }
        }

        self.browser = browser
        browser.start(queue: .main)
    }

    func stop() {
        shouldBrowse = false
        retryTask?.cancel()
        retryTask = nil
        generation += 1
        browser?.cancel()
        browser = nil
        browsing = false
    }

    /// A defunct DNS-SD connection means the system browser disappeared, not
    /// that the companion or its Tailscale route is broken. Recreating the
    /// browser is the only useful recovery; keep it bounded so a persistent
    /// local-network problem does not turn into a retry loop.
    private func handleFailure(_ error: NWError) {
        browser?.cancel()
        browser = nil
        browsing = false
        found = []

        guard Self.isDefunct(error), retryCount < 3, shouldBrowse else {
            failure = Self.failureMessage(for: error)
            return
        }

        retryCount += 1
        failure = "Local discovery was interrupted. Retrying…"
        let delay = UInt64(retryCount) * 350_000_000
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.startBrowser() }
        }
    }

    private static func isDefunct(_ error: NWError) -> Bool {
        guard case let .dns(code) = error else { return false }
        return Int(code) == kDNSServiceErr_DefunctConnection
    }

    private static func failureMessage(for error: NWError) -> LocalizedStringKey {
        if case let .dns(code) = error,
           Int(code) == kDNSServiceErr_PolicyDenied {
            return "Local Network access is off. Enable it in Settings, or enter a Tailscale address below."
        }
        return "Local discovery isn't available right now. Enter the address shown in Phone settings."
    }

    /// Resolve a browse result to something `Connection` can hold.
    ///
    /// NWBrowser hands back a service endpoint, not an address: resolving
    /// means actually opening a connection and asking what it connected to.
    /// A ten-second ceiling keeps a half-present service from hanging the
    /// pairing screen forever.
    func resolve(_ service: Found) async throws -> Connection {
        let connection = NWConnection(to: service.endpoint, using: .tcp)
        defer { connection.cancel() }

        let resolved: NWEndpoint = try await withCheckedThrowingContinuation { continuation in
            var settled = false
            let finish: (Result<NWEndpoint, Error>) -> Void = { result in
                guard !settled else { return }
                settled = true
                continuation.resume(with: result)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let endpoint = connection.currentPath?.remoteEndpoint {
                        finish(.success(endpoint))
                    } else {
                        finish(.failure(APIError.transport("Couldn't work out that computer's address.")))
                    }
                case let .failed(error):
                    finish(.failure(APIError.transport(error.localizedDescription)))
                case .cancelled:
                    finish(.failure(APIError.transport("Connection cancelled.")))
                default:
                    break
                }
            }
            connection.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                finish(.failure(APIError.transport("That computer didn't answer.")))
            }
        }

        guard case let .hostPort(host, port) = resolved else {
            throw APIError.transport("Couldn't work out that computer's address.")
        }
        return Connection(name: service.name, host: Self.plainHost(host), port: Int(port.rawValue))
    }

    /// `NWEndpoint.Host` prints IPv6 with its scope zone attached
    /// ("fe80::1%en0"). Keep that zone — link-local IPv6 needs it — and wrap
    /// the literal in the form URLComponents accepts.
    static func plainHost(_ host: NWEndpoint.Host) -> String {
        Connection.urlHost("\(host)")
    }
}
