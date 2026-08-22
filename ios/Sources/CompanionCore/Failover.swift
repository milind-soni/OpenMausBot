// Reaching the same computer at whichever of its addresses still works.
//
// Pairing stores one host, and one host is one point of failure: a phone
// paired over the tailnet keeps a MagicDNS name that stops resolving the
// moment either device leaves the tailnet — while the same computer sits
// reachable on the LAN right there. The fix is late binding: the connection
// carries every address the computer answered on at pairing time, and the
// dial walks that list when a failure is about the *address* rather than the
// pairing. Both halves are pure — no sockets, no clocks — so the rules can
// be tested without a network; `Session` owns when they run.
import Foundation

/// The ordered walk through a connection's stored hosts.
///
/// Advance on an address-shaped failure, promote on success. Advancing wraps
/// rather than giving up, because the retry loop it lives in already backs
/// off between attempts and a network that comes back deserves a second lap.
public struct CandidateRotation: Equatable, Sendable {
    public private(set) var hosts: [String]
    private var index: Int

    public init(hosts: [String]) {
        self.hosts = hosts
        index = 0
    }

    /// The host the next attempt should dial. Empty only when there are no
    /// hosts at all, which a real connection never produces.
    public var current: String {
        hosts.indices.contains(index) ? hosts[index] : ""
    }

    public var count: Int { hosts.count }

    /// Move to the next candidate and return it, wrapping past the end.
    @discardableResult
    public mutating func advance() -> String {
        guard !hosts.isEmpty else { return "" }
        index = (index + 1) % hosts.count
        return current
    }

    /// The stored order after a success: the host that just worked first, so
    /// the next launch dials it before anything that was failing, and the
    /// rest keeping their relative order.
    public func promoted() -> [String] {
        guard hosts.indices.contains(index) else { return hosts }
        return [hosts[index]] + hosts.enumerated().filter { $0.offset != index }.map(\.element)
    }
}

/// What to do with a connection failure: whether another stored address is
/// worth trying, and what to tell the person watching the banner.
public enum ConnectionAdvice {
    /// True only for failures about the address — the name did not resolve,
    /// nothing answered there, the route timed out. Everything else stays
    /// put: a 401 is a token problem that every address would repeat, and
    /// "offline" fails identically wherever the dial points.
    public static func shouldTryAnotherHost(_ code: URLError.Code) -> Bool {
        switch code {
        case .cannotFindHost, .cannotConnectToHost, .timedOut, .secureConnectionFailed:
            return true
        default:
            return false
        }
    }

    /// The offline banner as advice rather than an NSURLError string.
    ///
    /// Each code names the thing the person can actually check — the raw
    /// "A server with the specified hostname could not be found" says nothing
    /// about tailnets, and it is precisely the tailnet case that produces it.
    /// `tryingNext` is the candidate the walk moved to, when it moved.
    public static func message(
        for code: URLError.Code,
        host: String,
        port: Int,
        tryingNext next: String? = nil
    ) -> String {
        let advice: String
        switch code {
        case .cannotFindHost:
            advice = "\u{201C}\(host)\u{201D} didn't resolve. If that's a Tailscale name, this phone may not be on the tailnet."
        case .cannotConnectToHost:
            advice = "Reached your computer, but the companion isn't answering on port \(port) — open OpenMausBot → Settings → Companion."
        case .timedOut:
            advice = "No route to your computer at \(host) — different network, or a firewall."
        case .notConnectedToInternet:
            advice = "You're offline."
        default:
            advice = "Could not reach \(host): \(URLError(code).localizedDescription)"
        }
        let fallback = next.map { " Trying \($0) next." } ?? ""
        return advice + fallback + " The app keeps retrying automatically."
    }
}

extension Connection {
    /// Every host this connection may dial, best first and never empty: the
    /// stored `host` leads, then the pairing-time fallbacks, deduplicated
    /// after the same normalization dialing applies.
    public var orderedHosts: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for candidate in [host] + (hosts ?? []) {
            let normalized = Self.urlHost(candidate)
            if seen.insert(normalized).inserted { out.append(normalized) }
        }
        return out
    }

    /// A copy dialing `candidate` — same pairing, same port, different
    /// address. The stored order is untouched; committing a winner is
    /// `promote`, and only success earns it.
    public func dialing(_ candidate: String) -> Connection {
        var copy = self
        copy.host = Self.urlHost(candidate)
        return copy
    }

    /// `winner` becomes the host dialed first from now on — the one that just
    /// carried traffic, or the one the user typed in by hand.
    public mutating func promote(_ winner: String) {
        let normalized = Self.urlHost(winner)
        let rest = orderedHosts.filter { $0 != normalized }
        host = normalized
        hosts = [normalized] + rest
    }
}
