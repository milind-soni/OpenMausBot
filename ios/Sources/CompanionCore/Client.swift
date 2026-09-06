// The companion API client.
//
// Everything the phone can do to the harness, in one place. The rules it
// encodes come from the default-deny policy in `companion/src/routes.ts`: a
// paired phone may chat, answer approvals, and read rooms. Credential values
// are the narrow exception: this client can transport an HPKE envelope whose
// plaintext only the QR-paired Electron process can open. Pairing management
// and the Local VM remain absent rather than failing at runtime.
import Foundation

/// Where a companion connects, and with what. The token is *not* held here
/// — it lives in the keychain and is handed to the client at construction,
/// so a `Connection` can be written to disk without writing a credential.
public struct Connection: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// What the computer calls itself, e.g. "Ada Lovelace's computer".
    public var name: String
    public var host: String
    public var port: Int
    /// Every other address the computer answered on at pairing time, best
    /// first — the tailnet name, the LAN address, the sidecar's mDNS name.
    /// Optional so connections saved before fallbacks existed still decode.
    /// Read through `orderedHosts`; policy-bound hosted connections may have
    /// no legacy HTTP host because their complete route lives in `endpoints`.
    public var hosts: [String]?
    /// Complete route currently being dialed. Absent on connections saved by
    /// older app builds, where `host` + `port` still mean direct HTTP.
    public var activeEndpoint: CompanionEndpoint?
    /// Full routes advertised by a newer desktop. Each carries its own scheme
    /// and port so hosted HTTPS can coexist with local HTTP fallbacks.
    public var endpoints: [CompanionEndpoint]?
    /// The route kinds this pairing explicitly authorized. `nil` is reserved
    /// for connections saved by older app versions and retains their legacy
    /// failover behavior. New pairings always persist a non-nil policy, with
    /// hosted HTTPS included as the one universally safe future upgrade.
    public var allowedRouteKinds: Set<CompanionEndpointKind>?
    /// Exact cleartext origins the pairing consent screen authorized. New
    /// policies persist an empty set for hosted/Tailscale and one selected
    /// LAN or Bonjour origin for local pairing. Absent alongside a nil kind
    /// policy on connections saved before route consent existed.
    public var allowedLocalRouteURLs: Set<String>?
    /// P-256 HPKE recipient point learned only from the camera-scanned QR.
    /// It is public key material; the phone never receives the private key.
    public var secretPublicKey: String?
    /// Sidecar device identity returned after redemption. Bound into every
    /// credential envelope and checked against the authenticated bearer.
    public var companionDeviceId: String?
    /// Set when this connection was paired against the server's own sessions
    /// (`openmausbot serve` / the Docker stack) rather than the desktop's
    /// companion sidecar: the bearer is an `omb_sess_` token with the client
    /// scope, so what the app may administer differs. Absent on connections
    /// saved before servers could be paired directly.
    public var serverEnvironmentId: String?

    public init(
        id: String = UUID().uuidString,
        name: String,
        host: String,
        port: Int,
        hosts: [String]? = nil,
        activeEndpoint: CompanionEndpoint? = nil,
        endpoints: [CompanionEndpoint]? = nil,
        allowedRouteKinds: Set<CompanionEndpointKind>? = nil,
        allowedLocalRouteURLs: Set<String>? = nil,
        secretPublicKey: String? = nil,
        companionDeviceId: String? = nil,
        serverEnvironmentId: String? = nil
    ) {
        self.id = id
        self.name = name
        self.host = Self.urlHost(host)
        self.port = port
        self.hosts = hosts
        self.activeEndpoint = activeEndpoint
        self.endpoints = endpoints
        self.allowedRouteKinds = allowedRouteKinds
        self.allowedLocalRouteURLs = allowedLocalRouteURLs
        self.secretPublicKey = secretPublicKey
        self.companionDeviceId = companionDeviceId
        self.serverEnvironmentId = serverEnvironmentId
    }

    /// Paired with a server directly (client scope): chat, approvals and
    /// reading are in; creating bots, changing models, connected apps and
    /// cloud computers are the owner's, done on the server's own UI.
    public var pairedWithServer: Bool { serverEnvironmentId != nil }

    /// The representation `URLComponents.host` accepts for a literal IPv6
    /// address. It adds brackets exactly once and leaves DNS/IPv4 names alone.
    /// A scope zone on a link-local IPv6 address is intentionally retained;
    /// URLComponents percent-encodes it when it builds the URL.
    ///
    /// An interface zone on anything *else* is dropped. `NWEndpoint.Host`
    /// describes a resolved IPv4 address with the interface it arrived on
    /// ("192.168.1.3%en0"); the zone carries no meaning there and
    /// URLComponents refuses it as a host, which made a Bonjour-discovered
    /// computer fail with "that address doesn't look right".
    public static func urlHost(_ host: String) -> String {
        var bare: String
        if host.hasPrefix("["), host.hasSuffix("]") {
            bare = String(host.dropFirst().dropLast())
        } else {
            bare = host
        }
        if bare.contains(":") { return "[\(bare)]" }
        if let zone = bare.firstIndex(of: "%") { bare = String(bare[..<zone]) }
        return bare
    }

    /// Parse a manually entered companion address. A bare IPv6 literal uses
    /// the default port; an explicit IPv6 port must use `[address]:port`, the
    /// same unambiguous form browsers and command-line tools use.
    public static func parse(_ text: String, defaultPort: Int = 8810) -> Connection? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        if lowercased.hasPrefix("http://") || lowercased.hasPrefix("https://") {
            let kind: CompanionEndpointKind
            if lowercased.hasPrefix("https://") {
                kind = .hosted
            } else {
                let parsedHost = URLComponents(string: trimmed)?.host ?? ""
                kind = CompanionEndpoint.inferredDirectKind(parsedHost)
            }
            guard let endpoint = CompanionEndpoint(
                url: trimmed,
                kind: kind,
                priority: 0
            ) else { return nil }
            return Connection(
                name: endpoint.host,
                host: endpoint.host,
                port: endpoint.port,
                activeEndpoint: endpoint,
                endpoints: [endpoint]
            )
        }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }

        var host = trimmed
        var port = defaultPort
        if trimmed.hasPrefix("[") {
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let rest = trimmed[trimmed.index(after: close)...]
            if !rest.isEmpty {
                guard rest.hasPrefix(":"), let parsed = Int(rest.dropFirst()) else { return nil }
                port = parsed
            }
        } else {
            let colonCount = trimmed.reduce(into: 0) { count, character in
                if character == ":" { count += 1 }
            }
            if colonCount == 1, let colon = trimmed.lastIndex(of: ":") {
                host = String(trimmed[..<colon])
                guard let parsed = Int(trimmed[trimmed.index(after: colon)...]) else { return nil }
                port = parsed
            }
        }

        guard !host.isEmpty,
              !host.contains(where: { $0.isWhitespace || "/?#[]".contains($0) }),
              (1...65535).contains(port)
        else { return nil }
        return Connection(name: host, host: host, port: port)
    }

    /// Hosted routes use ordinary certificate-validated HTTPS. A connection
    /// saved by an older app still falls back to direct HTTP below.
    ///
    /// The bearer token goes out in a header on every request, so anyone who
    /// can observe the path between phone and computer can lift it and use it
    /// until the device is revoked. What that means in practice depends
    /// entirely on how you reach the computer, and the supported routes are
    /// not equivalent:
    ///
    /// - **Over hosted HTTPS** — the default remote route — ordinary TLS
    ///   encrypts the connection and authenticates the public endpoint.
    /// - **Over a tailnet**, the traffic is inside WireGuard before it reaches
    ///   any network, so it is encrypted and authenticated end to end even
    ///   though this URL says `http`.
    /// - **Over a LAN**, it is cleartext on that network. Trust it exactly as
    ///   far as you trust everyone on the wifi: fine at home, not fine on a
    ///   café or conference network — pair over the tailnet there instead.
    ///
    /// TLS is not a drop-in improvement here, which is why it is not simply
    /// switched on. A self-signed certificate on a LAN address is a
    /// certificate nothing can validate, so it would have to be pinned at
    /// pairing time and re-pinned whenever the sidecar regenerates it — a
    /// meaningful amount of machinery. Hosted HTTPS and the tailnet carry
    /// encryption; the LAN path is documented as trusted-network-only, and
    /// pinned TLS is what it needs before it could claim otherwise. See
    /// `docs/ios-companion.md`.
    public var baseURL: URL? {
        if let activeEndpoint {
            guard allowsEndpoint(activeEndpoint) else { return nil }
            return activeEndpoint.baseURL
        }
        guard let direct = CompanionEndpoint.direct(
            host: host,
            port: port,
            priority: 0
        ), allowsEndpoint(direct) else { return nil }
        return direct.baseURL
    }
}

/// A pairing window handed from the desktop to the app as a QR/deep link.
/// It contains only the address and a short-lived, single-use credential.
/// New desktop builds put a high-entropy token in the QR; older builds carry
/// the same six-digit code shown on screen. The long-lived device token is
/// created later by `CompanionClient.pair` and never appears in the link.
public struct PairingInvite: Equatable, Sendable {
    public let connection: Connection
    public let credential: String

    public init(connection: Connection, credential: String) {
        self.connection = connection
        self.credential = credential
    }

    public static func parse(_ url: URL) -> PairingInvite? {
        if let server = parseServerLink(url) { return server }
        guard url.scheme?.lowercased() == "openmausbot",
              url.host?.lowercased() == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }

        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard values[item.name] == nil, let value = item.value else { return nil }
            values[item.name] = value
        }
        guard let address = values["address"],
              let credential = Self.credential(from: values),
              var connection = Connection.parse(address)
        else { return nil }

        if let name = values["name"]?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let cleaned = name.filter {
                (!$0.isASCII && !$0.isNewline) || $0.asciiValue.map { $0 >= 32 && $0 != 127 } == true
            }
            if !cleaned.isEmpty { connection.name = String(cleaned.prefix(80)) }
        }
        // The desktop's ordered fallback list, comma-joined. Advisory rather
        // than load-bearing: a bad entry costs one failed dial when its turn
        // comes, so unusable candidates are dropped instead of failing the
        // whole invite. 253 bytes is the DNS name ceiling.
        if let list = values["hosts"] {
            let candidates = list.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { candidate in
                    !candidate.isEmpty && candidate.utf8.count <= 253 &&
                        !candidate.contains(where: { $0.isWhitespace || "/?#".contains($0) })
                }
            if !candidates.isEmpty { connection.hosts = Array(candidates.prefix(8)) }
        }
        if let encoded = values["endpoints"] {
            guard let endpoints = Self.decodeEndpoints(encoded) else { return nil }
            connection.endpoints = endpoints
            connection = connection.dialing(endpoints[0])
        }
        if let secretKey = values["secretKey"] {
            guard let normalized = PhoneSecretCrypto.normalizedPublicKey(secretKey) else { return nil }
            connection.secretPublicKey = normalized
        }
        connection.establishRoutePolicyFromInvite()
        return PairingInvite(connection: connection, credential: credential)
    }

    /// Unpadded base64url JSON keeps the typed array in one unambiguous query
    /// value. A present-but-invalid value rejects the invite instead of
    /// quietly downgrading a hosted HTTPS QR to its legacy HTTP address.
    private static func decodeEndpoints(_ encoded: String) -> [CompanionEndpoint]? {
        guard !encoded.isEmpty,
              encoded.utf8.count <= 8_192,
              encoded.utf8.allSatisfy({
                  (48...57).contains($0) || (65...90).contains($0) ||
                  (97...122).contains($0) || $0 == 45 || $0 == 95
              })
        else { return nil }

        var base64 = encoded.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let decoded = try? JSONDecoder().decode([CompanionEndpoint].self, from: data),
              !decoded.isEmpty,
              decoded.count <= 8
        else { return nil }

        let stable = decoded.enumerated().sorted {
            $0.element.priority == $1.element.priority
                ? $0.offset < $1.offset
                : $0.element.priority < $1.element.priority
        }.map(\.element)
        var seen = Set<String>()
        let unique = stable.filter { seen.insert($0.url).inserted }
        return unique.isEmpty ? nil : unique
    }

    /// `https://host/pair#code=ABCD-EFGH-JKLM`: the link a server prints
    /// (`openmausbot serve`, `openmausbot pair`, the Docker stack). It pairs
    /// against the server's own sessions, not the companion sidecar. The code
    /// rides in the fragment, which never reaches a server in a request, and
    /// the server takes it with or without dashes.
    static func parseServerLink(_ url: URL) -> PairingInvite? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty,
              components.path == "/pair",
              components.query == nil,
              let fragment = components.fragment
        else { return nil }
        var values: [String: String] = [:]
        for pair in fragment.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard parts.count == 2, values[String(parts[0])] == nil else { return nil }
            values[String(parts[0])] = String(parts[1]).removingPercentEncoding ?? String(parts[1])
        }
        guard let raw = values["code"], let code = normalizedServerCode(raw) else { return nil }
        var origin = components
        origin.path = ""
        origin.fragment = nil
        guard let originString = origin.string, let connection = Connection.parse(originString) else { return nil }
        return PairingInvite(connection: connection, credential: code)
    }

    /// A server pairing code: 12 characters from a confusion-free alphabet,
    /// shown as three dashed groups. Only the shape is checked here; a
    /// mistyped code fails at the server with its own message. Six-digit
    /// codes and `omb_pair_` tokens are the companion's and return nil.
    public static func normalizedServerCode(_ raw: String) -> String? {
        let cleaned = raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        guard cleaned.count == 12, !cleaned.allSatisfy(\.isNumber) else { return nil }
        return cleaned
    }

    private static func credential(from values: [String: String]) -> String? {
        if let token = values["token"] {
            guard token.hasPrefix("omb_pair_"),
                  token.utf8.count == 52,
                  token.dropFirst("omb_pair_".count).utf8.allSatisfy({
                      (48...57).contains($0) || (65...90).contains($0) ||
                      (97...122).contains($0) || $0 == 45 || $0 == 95
                  })
            else { return nil }
            return token
        }
        guard let code = values["code"],
              code.utf8.count == 6,
              code.utf8.allSatisfy({ (48...57).contains($0) })
        else { return nil }
        return code
    }
}

/// The server response together with the endpoint that actually answered.
/// Pairing has to persist the winner, not merely the first address printed in
/// a QR code, or the next launch repeats the same dead route.
public struct PairingOutcome: Sendable {
    public let response: PairResponse
    public let connection: Connection

    public init(response: PairResponse, connection: Connection) {
        self.response = response
        self.connection = connection
    }
}

/// None of the addresses advertised for a computer answered the companion
/// health check. Kept distinct from a pairing rejection: this invite is still
/// valid and the UI can offer Retry without making someone scan it again.
public struct PairingRouteError: Error, LocalizedError, Equatable, Sendable {
    public let attemptedHosts: [String]

    public init(attemptedHosts: [String]) {
        self.attemptedHosts = attemptedHosts
    }

    public var errorDescription: String? {
        let routes = attemptedHosts.joined(separator: ", ")
        return "Couldn’t reach this computer through any available route (\(routes)). Keep Phone access turned on in OpenMausBot, then try again."
    }
}

public enum APIError: Error, LocalizedError, Sendable {
    /// The harness answered, and said no.
    case status(code: Int, message: String?)
    /// Could not reach it at all.
    case transport(String)
    case badURL

    public var errorDescription: String? {
        switch self {
        case let .status(code, message):
            if let message { return message }
            switch code {
            case 401: return "This phone is not paired with that computer."
            case 403: return "That can only be done on the computer itself."
            case 404: return "That is no longer there."
            case 409: return "The bot is busy — stop it first."
            default: return "The computer answered with an error (\(code))."
            }
        case let .transport(detail):
            return detail
        case .badURL:
            return "That address doesn't look right."
        }
    }

    /// The one error that means "stop retrying and send them back to
    /// pairing" rather than "try again in a moment".
    public var isUnauthorized: Bool {
        if case let .status(code, _) = self { return code == 401 }
        return false
    }
}

/// The exact conversation a retriable send belongs to. Carrying the thread
/// as well as the bot/room id prevents a Share Extension retry from landing
/// in a different task if the desktop switches tasks while iOS is suspended.
public enum MessageDestination: Hashable, Sendable {
    case bot(id: String, threadId: String)
    case room(id: String, threadId: String)
}

public enum SharedAttachmentKind: Hashable, Sendable {
    case image
    case file
}

/// A file which has already crossed to the Mac. The path is deliberately the
/// server's absolute path rather than the phone's temporary provider URL.
public struct SharedAttachmentReference: Hashable, Sendable {
    public let path: String
    public let kind: SharedAttachmentKind
    public let displayName: String?

    public init(path: String, kind: SharedAttachmentKind, displayName: String? = nil) {
        self.path = path
        self.kind = kind
        self.displayName = displayName
    }
}

/// Builds the same tagged prompt as the desktop composer without making the
/// extension know about server paths or XML escaping. Kept pure so share-sheet
/// input can be tested without loading UIKit or an extension context.
public enum SharedMessageComposer {
    public static func compose(
        instruction: String,
        text: [String],
        urls: [URL],
        attachments: [SharedAttachmentReference]
    ) -> String {
        var parts: [String] = []
        appendNonempty(instruction, to: &parts)
        var seenText = Set<String>()
        for value in text {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, seenText.insert(trimmed).inserted { parts.append(trimmed) }
        }

        var seenURLs = Set<String>()
        for url in urls {
            let value = url.absoluteString
            if seenURLs.insert(value).inserted { appendNonempty(value, to: &parts) }
        }

        for attachment in attachments {
            let tag = attachment.kind == .image ? "attached-image" : "attached-file"
            if let displayName = attachment.displayName?.trimmingCharacters(in: .whitespacesAndNewlines),
               !displayName.isEmpty {
                parts.append(
                    "<\(tag) path=\"\(escapeAttribute(attachment.path))\" " +
                    "name=\"\(escapeAttribute(displayName))\" />"
                )
            } else {
                parts.append("<\(tag) path=\"\(escapeAttribute(attachment.path))\" />")
            }
        }
        return parts.joined(separator: "\n\n")
    }

    private static func appendNonempty(_ value: String, to parts: inout [String]) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { parts.append(trimmed) }
    }

    private static func escapeAttribute(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\t", with: "&#9;")
            .replacingOccurrences(of: "\r", with: "&#13;")
            .replacingOccurrences(of: "\n", with: "&#10;")
    }
}

private struct FileUploadResponse: Decodable {
    let path: String
    let name: String
    let mime: String
    let bytes: Int
}

public struct UploadedFile: Hashable, Sendable {
    public let path: String
    public let name: String

    public init(path: String, name: String) {
        self.path = path
        self.name = name
    }
}

private struct InstanceCapabilityResponse: Decodable {
    struct Entry: Decodable {
        struct Capabilities: Decodable { let images: Bool? }
        let instanceId: String
        let capabilities: Capabilities?
    }

    let instances: [Entry]
}

public struct CompanionClient: Sendable {
    public static let maximumImageUploadBytes = AttachmentPolicy.maximumImageBytes
    public static let maximumFileUploadBytes = AttachmentPolicy.maximumFileBytes
    public static let maximumFileDownloadBytes = AttachmentPolicy.maximumFileBytes

    public let connection: Connection
    private let token: String?
    private let session: URLSession
    private let requestTimeout: TimeInterval

    public init(
        connection: Connection,
        token: String?,
        session: URLSession = .shared,
        requestTimeout: TimeInterval = 20
    ) {
        self.connection = connection
        self.token = token
        self.session = session
        self.requestTimeout = min(max(requestTimeout, 1), 150)
    }

    // MARK: - Requests

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil) throws -> URLRequest {
        guard let base = connection.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw APIError.badURL }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError.badURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        // Short on purpose. These are calls to a computer on the same
        // network; if it does not answer in twenty seconds it is not going
        // to. The default sixty leaves someone watching a spinner long
        // enough to assume the app is broken rather than the address wrong.
        request.timeoutInterval = requestTimeout
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    /// Encodable request bodies are used for contracts where omitted and null
    /// have different meanings. JSONSerialization cannot preserve that type
    /// distinction without rebuilding the object by hand at every call site.
    private func makeRequest<Body: Encodable>(
        _ method: String,
        _ path: String,
        encodedBody body: Body
    ) throws -> URLRequest {
        var request = try makeRequest(method, path)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    @discardableResult
    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.transport("The computer sent something this app couldn't read.")
        }
    }

    private func send(_ request: URLRequest) async throws {
        let (data, response) = try await perform(request)
        try Self.check(response, data)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
    }

    /// Turn a non-2xx into an `APIError` carrying the harness's own message.
    /// Those messages are written for people, so passing them through beats
    /// inventing a different client-side explanation here. Captured fixtures
    /// intentionally preserve the current server contract verbatim.
    static func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200...299).contains(http.statusCode) else { return }
        let message = try? JSONDecoder().decode(APIErrorBody.self, from: data).error
        throw APIError.status(code: http.statusCode, message: message)
    }

    // MARK: - Pairing

    /// Redeem a one-time pairing credential for a device token. The only call
    /// made without a device token.
    public static func pair(
        connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String? = nil,
        session: URLSession = .shared
    ) async throws -> PairResponse {
        let client = CompanionClient(connection: connection, token: nil, session: session)
        // A six-digit credential is an older desktop or manual entry. Keep
        // its field name for compatibility; new QR credentials use the
        // explicit field and are never persisted by the app.
        let key = credential.utf8.count == 6 && credential.utf8.allSatisfy({ (48...57).contains($0) })
            ? "code"
            : "credential"
        var body: [String: Any] = [key: credential, "deviceName": deviceName]
        if let pairRequestId { body["pairRequestId"] = pairRequestId }
        var pairRequest = try client.makeRequest(
            "POST",
            "/api/pair",
            body: body
        )
        // Pairing is allowed to move to another advertised route. One dead
        // address must not consume the default twenty-second API deadline.
        pairRequest.timeoutInterval = 8
        return try await client.send(pairRequest, as: PairResponse.self)
    }

    /// Pair against the server's own sessions (`POST /api/auth/pair`). The
    /// answer is a bearer for the client scope; no cookie is asked for, so
    /// the token is the app's alone. `attemptId` makes a retry after a lost
    /// response idempotent for a minute, like the companion's request id.
    public static func pairWithServer(
        connection: Connection,
        code: String,
        label: String,
        attemptId: String = UUID().uuidString,
        session: URLSession = .shared
    ) async throws -> ServerPairResponse {
        let client = CompanionClient(connection: connection, token: nil, session: session)
        var request = try client.makeRequest(
            "POST",
            "/api/auth/pair",
            body: ["code": code, "label": label, "attemptId": attemptId]
        )
        request.timeoutInterval = 8
        return try await client.send(request, as: ServerPairResponse.self)
    }

    /// The server's public descriptor: reachable before pairing, and the way
    /// to notice that the address now belongs to a different server.
    public func environment() async throws -> ServerEnvironment {
        try await send(makeRequest("GET", "/.well-known/openmausbot/environment"), as: ServerEnvironment.self)
    }

    /// End this session on the server (server-paired connections only).
    public func logout() async throws {
        try await send(makeRequest("POST", "/api/auth/logout"))
    }

    /// Resolve the multi-address invite before consuming its credential.
    ///
    /// Health probes are non-mutating and run together, so a dead protected
    /// route cannot sit in front of another protected route for twenty
    /// seconds. Cleartext LAN/Bonjour routes are deliberately excluded unless
    /// that exact route is the user's preferred, explicit choice; neither a
    /// pairing credential nor the later bearer token is sprayed onto the
    /// current wifi merely because a private address was once advertised.
    /// Only the first response that identifies itself as OpenMausBot receives
    /// the one-time pairing POST. The request id makes that redemption safely
    /// replayable by newer desktop builds if its response is lost in transit.
    public static func pairFirstReachable(
        connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String = UUID().uuidString,
        session: URLSession = .shared
    ) async throws -> PairingOutcome {
        let automaticEndpoints = connection.automaticEndpoints
        let candidates = automaticEndpoints.map(connection.dialing)
        let attemptedRoutes = automaticEndpoints.map(\.url)
        var remaining = candidates
        while !remaining.isEmpty {
            guard let winner = await firstHealthy(in: remaining, session: session) else {
                throw PairingRouteError(attemptedHosts: attemptedRoutes)
            }
            remaining.remove(at: winner.offset)
            do {
                let response = try await pair(
                    connection: winner.connection,
                    credential: credential,
                    deviceName: deviceName,
                    pairRequestId: pairRequestId,
                    session: session
                )
                return PairingOutcome(response: response, connection: winner.connection)
            } catch let error as APIError {
                // Credential/client errors are authoritative and must not be
                // sprayed at another address. Transport failures and gateway
                // errors belong to this route, though — the Mac may even have
                // committed the device before the proxy failed. New desktops
                // replay this exact request id safely through a fallback.
                if case .transport = error { continue }
                if ConnectionAdvice.shouldTryAnotherRoute(after: error) { continue }
                throw error
            } catch {
                // URL loading and decoding failures are likewise ambiguous.
                // Keep the logical request id and try another verified route.
                continue
            }
        }
        throw PairingRouteError(attemptedHosts: attemptedRoutes)
    }

    /// Probe every candidate together, but respect the advertised security
    /// order. A quick cleartext LAN response must not outrank an encrypted
    /// tailnet route that answers a moment later. A lower-priority result is
    /// selected as soon as every route before it has conclusively failed.
    private static func firstHealthy(
        in candidates: [Connection],
        session: URLSession
    ) async -> (offset: Int, connection: Connection)? {
        await withTaskGroup(
            of: (Int, Bool).self,
            returning: (offset: Int, connection: Connection)?.self
        ) { group in
            for (offset, candidate) in candidates.enumerated() {
                group.addTask {
                    (offset, await healthy(candidate, session: session))
                }
            }
            var results = [Bool?](repeating: nil, count: candidates.count)
            for await (offset, isHealthy) in group {
                results[offset] = isHealthy
                for priority in candidates.indices {
                    guard let resolved = results[priority] else { break }
                    if resolved {
                        group.cancelAll()
                        return (priority, candidates[priority])
                    }
                }
            }
            return nil
        }
    }

    private struct HealthIdentity: Decodable {
        let app: String
    }

    private static func healthy(_ connection: Connection, session: URLSession) async -> Bool {
        do {
            let client = CompanionClient(connection: connection, token: nil, session: session)
            var request = try client.makeRequest("GET", "/api/health")
            request.timeoutInterval = 4
            let (data, response) = try await session.data(for: request)
            guard !Task.isCancelled,
                  let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode),
                  try JSONDecoder().decode(HealthIdentity.self, from: data).app == "openmausbot"
            else { return false }
            return true
        } catch {
            return false
        }
    }

    // MARK: - Reading

    /// Refresh the routes this already-paired phone can use. The sidecar owns
    /// this small authenticated response; it is not forwarded to the harness
    /// and it contains no account or pairing credential.
    public func connectionMetadata() async throws -> CompanionConnectionMetadata {
        try await send(
            try makeRequest("GET", "/api/companion/endpoints"),
            as: CompanionConnectionMetadata.self
        )
    }

    /// Hydrate. `messages` opts into the paged shape — the newest n per
    /// thread, with screen captures reduced to a flag.
    public func fleet(messages: Int? = 50) async throws -> Fleet {
        let query = messages.map { [URLQueryItem(name: "messages", value: String($0))] } ?? []
        return try await send(try makeRequest("GET", "/api/bots", query: query), as: Fleet.self)
    }

    /// Scrollback: the page before a message already held.
    public func messages(threadId: String, before: String? = nil, limit: Int = 50) async throws -> ThreadPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await send(try makeRequest("GET", "/api/threads/\(threadId)/messages", query: query), as: ThreadPage.self)
    }

    /// A page containing one exact message, for landing on a search hit.
    public func messages(threadId: String, around messageId: String, limit: Int = 50) async throws -> ThreadPage {
        let query = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "around", value: messageId),
        ]
        return try await send(try makeRequest("GET", "/api/threads/\(threadId)/messages", query: query), as: ThreadPage.self)
    }

    public func search(_ query: String, limit: Int = 40) async throws -> [SearchHit] {
        let items = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        return try await send(try makeRequest("GET", "/api/search", query: items), as: SearchResponse.self).hits
    }

    public func export(threadId: String, format: String) async throws -> TranscriptExport {
        let request = try makeRequest(
            "GET",
            "/api/threads/\(threadId)/export",
            query: [URLQueryItem(name: "format", value: format)]
        )
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        let http = response as? HTTPURLResponse
        let fallback = "transcript.\(format == "json" ? "json" : "md")"
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let filenamePart = disposition
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.lowercased().hasPrefix("filename=") }
        let filename = filenamePart.map {
            String($0.dropFirst("filename=".count)).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        } ?? fallback
        return TranscriptExport(
            data: data,
            filename: filename,
            contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        )
    }

    public func instances() async throws -> [Instance] {
        try await send(try makeRequest("GET", "/api/instances"), as: InstanceList.self).instances
    }

    /// The image capability is intentionally queried independently from the
    /// general Instance model: older servers omit it, which must mean false
    /// for a share that would otherwise send an unreadable image prompt.
    public func imageCapableInstanceIDs() async throws -> Set<String> {
        let response = try await send(
            try makeRequest("GET", "/api/instances"),
            as: InstanceCapabilityResponse.self
        )
        return Set(response.instances.compactMap { entry in
            entry.capabilities?.images == true ? entry.instanceId : nil
        })
    }

    public func config() async throws -> ConfigStatus {
        try await send(try makeRequest("GET", "/api/config"), as: ConfigStatus.self)
    }

    public func connectorCatalog() async throws -> ConnectorCatalog {
        try await send(try makeRequest("GET", "/api/connectors/catalog"), as: ConnectorCatalog.self)
    }

    /// Complete account-aware status in one request. This is the inventory
    /// source for the phone; a catalog page is not an account list.
    public func allConnectorStatuses() async throws -> ConnectorStatuses {
        try await send(
            try makeRequest("GET", "/api/connectors/connected"),
            as: ConnectorStatuses.self
        )
    }

    /// The pixels of one screen message.
    public func image(threadId: String, messageId: String) async throws -> Data {
        let imageRequest = try makeRequest("GET", "/api/threads/\(threadId)/messages/\(messageId)/image")
        let (data, response) = try await perform(imageRequest)
        try Self.check(response, data)
        return data
    }

    /// Fetch an app-owned file mentioned by one transcript message. The path
    /// still names the file on the paired computer, so it is sent in an
    /// authenticated JSON body rather than placed in the URL. The server
    /// verifies both message provenance and its attachment roots.
    public func downloadFile(
        threadId: String,
        messageId: String,
        path rawPath: String
    ) async throws -> DownloadedFile {
        guard Self.validRouteID(threadId), Self.validRouteID(messageId),
              case let .desktopFile(path) = LocalMessageLink.resolve(rawPath)
        else { throw APIError.badURL }
        let request = try makeRequest(
            "POST",
            "/api/threads/\(threadId)/messages/\(messageId)/file",
            body: ["path": path]
        )
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("The computer sent something this app couldn't read.")
        }
        if http.expectedContentLength > Self.maximumFileDownloadBytes ||
            data.count > Self.maximumFileDownloadBytes {
            throw APIError.transport("That file is larger than 25 MB.")
        }
        let disposition = http.value(forHTTPHeaderField: "Content-Disposition")
        let filename = Self.downloadFilename(from: disposition, fallbackPath: path)
        let rawContentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""
        let contentType = AttachmentPolicy.validMIME(rawContentType)
            ? AttachmentPolicy.normalizedMIME(rawContentType)
            : "application/octet-stream"
        return DownloadedFile(data: data, filename: filename, contentType: contentType)
    }

    private static func downloadFilename(from disposition: String?, fallbackPath: String) -> String {
        let parameters = disposition?.split(separator: ";").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? []
        let encoded = parameters.first(where: { $0.lowercased().hasPrefix("filename*=") })
            .map { String($0.dropFirst("filename*=".count)) }
        let ordinary = parameters.first(where: { $0.lowercased().hasPrefix("filename=") })
            .map { String($0.dropFirst("filename=".count)) }
        let decodedEncoded = encoded.flatMap { value -> String? in
            let unquoted = value.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            let payload = unquoted.split(separator: "'", maxSplits: 2, omittingEmptySubsequences: false)
            let encodedValue = payload.count == 3 ? String(payload[2]) : unquoted
            return encodedValue.removingPercentEncoding
        }
        let candidate = decodedEncoded
            ?? ordinary?.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            ?? fallbackPath.components(separatedBy: CharacterSet(charactersIn: "/\\"))
                .last(where: { !$0.isEmpty })
            ?? "file"
        let basename = candidate.components(separatedBy: CharacterSet(charactersIn: "/\\"))
            .last(where: { !$0.isEmpty }) ?? "file"
        let cleaned = basename.unicodeScalars.map { scalar -> String in
            let code = scalar.value
            let isBidiControl = (0x202A...0x202E).contains(code) || (0x2066...0x2069).contains(code)
            return CharacterSet.controlCharacters.contains(scalar) || isBidiControl ? " " : String(scalar)
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let shortened = boundedFilename(cleaned)
        return shortened.isEmpty || shortened == "." || shortened == ".." ? "file" : shortened
    }

    /// APFS limits one path component by bytes, not Swift characters. Keep
    /// enough room for the preview cache's own suffix and retain a useful
    /// extension whenever it fits.
    private static func boundedFilename(_ value: String, maximumUTF8Bytes: Int = 180) -> String {
        guard value.utf8.count > maximumUTF8Bytes else { return value }
        let pathExtension = (value as NSString).pathExtension
        let suffix = pathExtension.isEmpty ? "" : ".\(pathExtension)"
        if !suffix.isEmpty,
           suffix.utf8.count <= 32,
           suffix.utf8.count < maximumUTF8Bytes {
            let stem = String(value.dropLast(suffix.count))
            let prefix = utf8Prefix(stem, maximumBytes: maximumUTF8Bytes - suffix.utf8.count)
            if !prefix.isEmpty { return prefix + suffix }
        }
        return utf8Prefix(value, maximumBytes: maximumUTF8Bytes)
    }

    private static func utf8Prefix(_ value: String, maximumBytes: Int) -> String {
        var result = ""
        var bytes = 0
        for character in value {
            let piece = String(character)
            let pieceBytes = piece.utf8.count
            guard bytes + pieceBytes <= maximumBytes else { break }
            result.append(character)
            bytes += pieceBytes
        }
        return result
    }

    /// Fetch an app-owned avatar with the paired-device bearer token. Custom
    /// avatars never go through `AsyncImage`, which cannot attach that token.
    public func avatar(path: String) async throws -> Data {
        guard Self.validAvatarPath(path) else { throw APIError.badURL }
        let request = try makeRequest("GET", path)
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        return data
    }

    private static func validAvatarPath(_ path: String) -> Bool {
        let prefix = "/api/attachments/"
        guard path.hasPrefix(prefix) else { return false }
        let name = path.dropFirst(prefix.count)
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return false }
        let stem = name[..<dot]
        let ext = name[name.index(after: dot)...]
        // Match shared/bot-avatar.ts rather than trusting URL normalization:
        // one bare ASCII filename, one extension separator, and no dot segment.
        let validStem = !stem.isEmpty && stem.utf8.allSatisfy { byte in
            (48...57).contains(byte)
                || (65...90).contains(byte)
                || (97...122).contains(byte)
                || byte == 45
        }
        return validStem && ["png", "jpg", "gif", "webp"].contains(String(ext))
    }

    public func voices() async throws -> [Voice] {
        try await send(try makeRequest("GET", "/api/tts/voices"), as: VoiceListResponse.self).voices
    }

    public func routines() async throws -> (routines: [Routine], runs: [RoutineRun]) {
        let response = try await send(try makeRequest("GET", "/api/routines"), as: RoutinesResponse.self)
        return (response.routines, response.runs)
    }

    /// A read-only summary of one bot: who it is, what it does and won't do,
    /// and its recent activity. No settings, no transcript.
    public func overview(botId: String) async throws -> BotOverview {
        guard Self.validRouteID(botId) else { throw APIError.badURL }
        return try await send(try makeRequest("GET", "/api/bots/\(botId)/overview"), as: BotOverview.self)
    }

    // MARK: - Doing

    /// Make a new bot. The harness picks its name, colour and greeting — the
    /// phone deliberately does not, so a bot created here is indistinguishable
    /// from one created on the desktop.
    public func createBot() async throws -> Bot {
        try await send(try makeRequest("POST", "/api/bots"), as: CreatedBot.self).bot
    }

    /// The paired-device profile contract is deliberately narrower than the
    /// desktop's general bot PATCH. No execution policy or provider secret can
    /// be reached through this request.
    public func updateProfile(botId: String, patch: BotProfilePatch) async throws -> Bot {
        return try await send(
            try makeRequest("PATCH", "/api/bots/\(botId)/profile", encodedBody: patch),
            as: BotResponse.self
        ).bot
    }

    /// Change only the engine, model and optional reasoning effort. This uses
    /// the companion's narrow model route rather than the desktop's general
    /// bot PATCH, which also owns execution policy and computer settings.
    public func updateModel(botId: String, selection: ModelSelection) async throws -> Bot {
        guard Self.validRouteID(botId) else { throw APIError.badURL }
        return try await send(
            try makeRequest("PATCH", "/api/bots/\(botId)/model", encodedBody: selection),
            as: BotResponse.self
        ).bot
    }

    /// Upload raw image bytes and return the path the agent can open on its
    /// Mac. This is also the primitive used by avatar upload and sharing.
    public func uploadImage(
        data: Data,
        mime: String,
        uploadId: String? = nil
    ) async throws -> String {
        let normalizedMime = mime.lowercased()
        guard Self.validUploadID(uploadId) else { throw APIError.badURL }
        guard AttachmentPolicy.imageMIMETypes.contains(normalizedMime),
              data.count <= Self.maximumImageUploadBytes
        else {
            throw APIError.transport("Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.")
        }
        var request = try makeRequest(
            "POST",
            "/api/attachments",
            query: uploadId.map { [URLQueryItem(name: "uploadId", value: $0)] } ?? []
        )
        request.setValue(normalizedMime, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let saved = try await send(request, as: AttachmentResponse.self)
        guard Self.validUploadedPath(saved.path) else {
            throw APIError.transport("The uploaded image could not be used.")
        }
        return saved.path
    }

    public func uploadAvatar(data: Data, mime: String) async throws -> String {
        let path = try await uploadImage(data: data, mime: mime)
        let name = URL(fileURLWithPath: path).lastPathComponent
        guard !name.isEmpty, !name.contains("/") else { throw APIError.transport("The uploaded image could not be used.") }
        return "/api/attachments/\(name)"
    }

    /// Upload an ordinary document as raw bytes. The filename is display
    /// metadata only; the server chooses the generated path on the Mac.
    public func uploadFile(
        data: Data,
        name: String,
        mime: String,
        uploadId: String? = nil
    ) async throws -> UploadedFile {
        let displayName = URL(fileURLWithPath: name).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedMime = mime.lowercased()
        guard Self.validUploadID(uploadId) else { throw APIError.badURL }
        guard !displayName.isEmpty,
              displayName.utf8.count <= 255,
              Self.validUploadMime(normalizedMime),
              data.count <= Self.maximumFileUploadBytes
        else {
            throw APIError.transport("Choose a file up to 25 MB with a valid filename.")
        }
        var request = try makeRequest(
            "POST",
            "/api/files",
            query: [URLQueryItem(name: "name", value: displayName)]
                + (uploadId.map { [URLQueryItem(name: "uploadId", value: $0)] } ?? [])
        )
        request.setValue(normalizedMime, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let saved = try await send(request, as: FileUploadResponse.self)
        let returnedName = saved.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validUploadedPath(saved.path), Self.validUploadedName(returnedName) else {
            throw APIError.transport("The uploaded file could not be used.")
        }
        return UploadedFile(path: saved.path, name: returnedName)
    }

    private static func validUploadMime(_ mime: String) -> Bool {
        guard !mime.isEmpty, mime.utf8.count <= 127, mime.contains("/") else { return false }
        return mime.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                || [33, 35, 36, 38, 43, 45, 46, 47, 94, 95].contains(byte)
        }
    }

    private static func validUploadID(_ uploadId: String?) -> Bool {
        guard let uploadId else { return true }
        return UUID(uuidString: uploadId)?.uuidString == uploadId.uppercased()
    }

    private static func validUploadedPath(_ path: String) -> Bool {
        !path.isEmpty && path.utf8.count <= 4_096 && !path.contains("\0")
    }

    private static func validUploadedName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 255
            && !name.contains("/") && !name.contains("\\")
            && !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    public func generateAvatar(botId: String, prompt: String) async throws -> Bot {
        var request = try makeRequest(
            "POST", "/api/bots/\(botId)/avatar/generate",
            body: ["prompt": String(prompt.prefix(400))]
        )
        // The server gives its image provider 120 seconds. Leave room for the
        // server to return its bounded timeout error instead of replacing it
        // with the client's normal 20-second transport timeout.
        request.timeoutInterval = 150
        return try await send(
            request,
            as: GeneratedAvatarResponse.self
        ).bot
    }

    public func previewVoice(text: String, voiceId: String) async throws -> Data {
        let request = try makeRequest(
            "POST", "/api/tts/speak",
            body: ["text": String(text.prefix(500)), "voiceId": voiceId]
        )
        let (data, response) = try await perform(request)
        try Self.check(response, data)
        return data
    }

    public func createRoutine(_ input: RoutineInput) async throws -> Routine {
        guard input.schedule.type != .unknown else {
            throw APIError.transport("Choose a supported schedule before saving this routine.")
        }
        return try await send(
            try makeRequest("POST", "/api/routines", body: Self.routineBody(input)),
            as: RoutineResponse.self
        ).routine
    }

    public func updateRoutine(id: String, input: RoutineInput) async throws -> Routine {
        guard input.schedule.type != .unknown else {
            throw APIError.transport("Choose a supported schedule before saving this routine.")
        }
        return try await send(
            try makeRequest("PATCH", "/api/routines/\(id)", body: Self.routineBody(input)),
            as: RoutineResponse.self
        ).routine
    }

    public func setRoutineEnabled(id: String, enabled: Bool) async throws -> Routine {
        try await send(
            try makeRequest("PATCH", "/api/routines/\(id)", body: ["enabled": enabled]),
            as: RoutineResponse.self
        ).routine
    }

    public func runRoutine(id: String) async throws -> RoutineRun {
        try await send(try makeRequest("POST", "/api/routines/\(id)/run"), as: RoutineRunResponse.self).run
    }

    public func deleteRoutine(id: String) async throws {
        try await send(try makeRequest("DELETE", "/api/routines/\(id)"))
    }

    private static func routineBody(_ input: RoutineInput) -> [String: Any] {
        var schedule: [String: Any] = ["type": input.schedule.type.rawValue]
        if let at = input.schedule.at { schedule["at"] = at }
        if let time = input.schedule.time { schedule["time"] = time }
        if let weekdays = input.schedule.weekdays { schedule["weekdays"] = weekdays }
        if let everyMinutes = input.schedule.everyMinutes { schedule["everyMinutes"] = everyMinutes }
        if let anchorAt = input.schedule.anchorAt { schedule["anchorAt"] = anchorAt }
        var body: [String: Any] = [
            "name": input.name, "prompt": input.prompt, "botId": input.botId,
            "runOn": input.runOn, "schedule": schedule, "durationMinutes": input.durationMinutes,
        ]
        if let timeoutMinutes = input.timeoutMinutes { body["timeoutMinutes"] = timeoutMinutes }
        else if input.clearTimeout { body["timeoutMinutes"] = NSNull() }
        if let enabled = input.enabled { body["enabled"] = enabled }
        return body
    }

    /// Make a room. The harness names it after the first member when `name`
    /// is empty, exactly as the desktop's dialog does.
    public func createRoom(name: String?, memberIds: [String]) async throws -> Room {
        var body: [String: Any] = ["memberIds": memberIds]
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { body["name"] = name }
        return try await send(try makeRequest("POST", "/api/groups", body: body), as: CreatedRoom.self).group
    }

    /// File several bots under one shared desktop/mobile sidebar heading.
    /// This uses a narrow batch route instead of the desktop's general bot
    /// PATCH, so a paired phone can change organization without gaining any
    /// execution-policy controls and without leaving a half-created section.
    public func assignSection(name: String, botIds: [String]) async throws -> [Bot] {
        try await send(
            try makeRequest(
                "POST",
                "/api/sidebar-sections",
                body: ["name": name, "botIds": botIds]
            ),
            as: SidebarSectionResponse.self
        ).bots
    }

    public func send(text: String, toBot botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/messages", body: ["text": text]))
    }

    public func send(text: String, toRoom groupId: String) async throws {
        try await send(try makeRequest("POST", "/api/groups/\(groupId)/messages", body: ["text": text]))
    }

    /// Retry-safe send used by short-lived clients such as Share Extensions.
    /// `sendId` names the logical send, while `threadId` freezes the selected
    /// task so a retry can never drift to a newly active conversation.
    public func send(
        text: String,
        to destination: MessageDestination,
        sendId: String
    ) async throws {
        let route: String
        let threadId: String
        switch destination {
        case let .bot(id, selectedThreadId):
            guard Self.validRouteID(id) else { throw APIError.badURL }
            route = "/api/bots/\(id)/messages"
            threadId = selectedThreadId
        case let .room(id, selectedThreadId):
            guard Self.validRouteID(id) else { throw APIError.badURL }
            route = "/api/groups/\(id)/messages"
            threadId = selectedThreadId
        }
        guard Self.validRouteID(threadId), Self.validSendID(sendId) else { throw APIError.badURL }
        try await send(try makeRequest(
            "POST",
            route,
            body: ["text": text, "threadId": threadId, "sendId": sendId]
        ))
    }

    private static func validRouteID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
                || byte == 45 || byte == 95
        }
    }

    private static func validSendID(_ value: String) -> Bool {
        (16...80).contains(value.utf8.count) && validRouteID(value)
    }

    /// Answer an approval or a question.
    ///
    /// Addressed by thread rather than by bot on purpose: a request raised
    /// inside a room belongs to whichever member is speaking, and the
    /// harness already knows which that is.
    public func respond(
        threadId: String,
        requestId: String,
        behavior: String,
        message: String? = nil,
        reviewedSha256: String? = nil
    ) async throws {
        var body: [String: Any] = ["requestId": requestId, "behavior": behavior]
        if let message { body["message"] = message }
        if let reviewedSha256 { body["reviewedSha256"] = reviewedSha256 }
        try await send(try makeRequest("POST", "/api/threads/\(threadId)/respond", body: body))
    }

    /// Remember a grant so the same tool stops asking. The harness decides
    /// the key and puts it on the card; the phone never derives its own.
    public func alwaysAllow(botId: String, key: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/always-allow", body: ["allowKey": key]))
    }

    /// Starts one more account authorization for a toolkit. Revocation is
    /// intentionally absent: the paired-device boundary keeps that on the Mac.
    public func authorizeConnector(slug: String, alias: String?) async throws -> URL {
        guard Self.validConnectorSlug(slug) else { throw APIError.badURL }
        let trimmed = alias?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: [String: String]?
        if let trimmed, !trimmed.isEmpty {
            body = ["alias": trimmed]
        } else {
            body = nil
        }
        let response = try await send(
            try makeRequest("POST", "/api/connectors/\(slug)/authorize", body: body),
            as: ConnectorAuthorizationResponse.self
        )
        guard let url = URL(string: response.url),
              url.scheme == "https",
              url.host != nil
        else { throw APIError.badURL }
        return url
    }

    /// Matches the companion's `[\w-]+` toolkit route component. JavaScript
    /// `\w` is ASCII here; Unicode letters must not become a confusing 404.
    private static func validConnectorSlug(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 95 || $0 == 45
        }
    }

    public func toggleReaction(threadId: String, messageId: String, emoji: String) async throws -> Message {
        try await send(
            try makeRequest(
                "POST",
                "/api/threads/\(threadId)/messages/\(messageId)/reactions",
                body: ["emoji": emoji]
            ),
            as: MessageResponse.self
        ).message
    }

    public func edit(botId: String, messageId: String, text: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/messages/\(messageId)/edit", body: ["text": text]))
    }

    public func setActiveBranch(botId: String, messageId: String) async throws -> String {
        try await send(
            try makeRequest("POST", "/api/bots/\(botId)/active-branch", body: ["messageId": messageId]),
            as: ActiveBranchResponse.self
        ).activeLeafId
    }

    public func createTask(botId: String, title: String? = nil) async throws -> Bot {
        var body: [String: Any] = [:]
        if let title, !title.isEmpty { body["title"] = title }
        return try await send(try makeRequest("POST", "/api/bots/\(botId)/tasks", body: body), as: BotResponse.self).bot
    }

    public func switchTask(botId: String, threadId: String) async throws -> Bot {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/tasks/\(threadId)"), as: BotResponse.self).bot
    }

    public func renameTask(botId: String, threadId: String, title: String) async throws {
        try await send(try makeRequest("PATCH", "/api/bots/\(botId)/tasks/\(threadId)", body: ["title": title]))
    }

    public func deleteTask(botId: String, threadId: String) async throws -> Bot {
        try await send(try makeRequest("DELETE", "/api/bots/\(botId)/tasks/\(threadId)"), as: BotResponse.self).bot
    }

    public func createTask(groupId: String, title: String? = nil) async throws -> Room {
        var body: [String: Any] = [:]
        if let title, !title.isEmpty { body["title"] = title }
        return try await send(try makeRequest("POST", "/api/groups/\(groupId)/tasks", body: body), as: RoomResponse.self).group
    }

    public func switchTask(groupId: String, threadId: String) async throws -> Room {
        try await send(try makeRequest("POST", "/api/groups/\(groupId)/tasks/\(threadId)"), as: RoomResponse.self).group
    }

    public func renameTask(groupId: String, threadId: String, title: String) async throws {
        try await send(try makeRequest("PATCH", "/api/groups/\(groupId)/tasks/\(threadId)", body: ["title": title]))
    }

    public func deleteTask(groupId: String, threadId: String) async throws -> Room {
        try await send(try makeRequest("DELETE", "/api/groups/\(groupId)/tasks/\(threadId)"), as: RoomResponse.self).group
    }

    public func interrupt(botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/interrupt"))
    }

    public func provideCredential(
        botId: String,
        messageId: String,
        envelope: PhoneSecretEnvelope
    ) async throws {
        var request = try makeRequest(
            "POST",
            "/api/bots/\(botId)/secret-cards/\(messageId)/provide",
            encodedBody: envelope
        )
        // Saving is transactional: the desktop validates provider access,
        // commits its OS-encrypted credential document, and updates the live
        // server before replying. Those provider checks have bounded network
        // deadlines of their own, so this one operation deliberately gets
        // longer than the normal twenty-second chat API timeout.
        request.timeoutInterval = 115
        try await send(request)
    }

    /// Mint a fresh interactive viewer for an existing cloud computer. The
    /// response URL is a bearer credential: the caller presents it directly
    /// and never stores it. The sidecar additionally requires this paired
    /// device's cloud-desktop capability to be enabled on the Mac.
    public func cloudDesktop(botId: String) async throws -> CloudDesktopSession {
        try await send(
            try makeRequest("POST", "/api/bots/\(botId)/computer/join"),
            as: CloudDesktopSession.self
        )
    }

    public func markRead(botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/read"))
    }

    public func markRead(roomId: String) async throws {
        try await send(try makeRequest("POST", "/api/groups/\(roomId)/read"))
    }

    // MARK: - Events

    /// A session for a connection that is meant to stay open for hours.
    ///
    /// `timeoutIntervalForRequest` is the *idle* timeout — the gap between
    /// bytes, not the lifetime of the request — so 90s is comfortably above
    /// the harness's 25-second keepalive comment while still noticing a
    /// connection that genuinely died.
    ///
    /// Emphatically NOT `request.timeoutInterval = .greatestFiniteMagnitude`,
    /// which is what this used to be. It reads like "never time out", but
    /// URLSession turns a timeout into a deadline by adding it to the current
    /// time, and 1.8e308 does not survive that arithmetic: the request opens
    /// and then never delivers a byte. The stream appeared to hang forever
    /// with no error to show for it.
    private static let streaming: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 90
        configuration.waitsForConnectivity = true
        // no caching for an event stream — it would only ever be wrong
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// The event stream, resuming from `cursor` when there is one.
    ///
    /// `screens` defaults off, and should stay off unless something is
    /// actually showing them: the harness pushes a base64 desktop capture
    /// every few seconds to every client that asks, which is a poor thing to
    /// send a phone on cellular. The computer panel turns it on for exactly
    /// as long as it is open, which costs a reconnect — cheap, because the
    /// stream resumes from its cursor and loses nothing.
    public func events(since cursor: String?, screens: Bool = false) throws -> AsyncThrowingStream<StreamFrame, Error> {
        var query = [URLQueryItem(name: "screens", value: screens ? "on" : "off")]
        if let cursor { query.append(URLQueryItem(name: "since", value: cursor)) }
        var streamRequest = try makeRequest("GET", "/api/events", query: query)
        streamRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // `makeRequest` stamps every request with the 20 seconds that suit a
        // call-and-answer API, and a per-request timeout *overrides* the
        // session's `timeoutIntervalForRequest` rather than deferring to it —
        // so the 90 seconds configured just above was never in effect here.
        // The harness sends a keepalive comment every 25 seconds, which is
        // already past 20: a stream with nothing to say would time out on its
        // first quiet gap and reconnect, forever, looking like a flaky network
        // rather than a number in the wrong place.
        streamRequest.timeoutInterval = 90
        return eventStream(request: streamRequest, session: Self.streaming)
    }
}
