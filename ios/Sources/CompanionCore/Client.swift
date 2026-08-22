// The companion API client.
//
// Everything the phone can do to the harness, in one place. The rules it
// encodes come from the default-deny policy in `companion/src/routes.ts`: a
// paired phone may chat, answer approvals, and read rooms — it may not touch
// credentials, pairing, or the Local VM. Those routes are simply absent here
// rather than present and failing at runtime.
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
    /// Optional so connections saved before fallbacks existed still decode;
    /// read through `orderedHosts`, which is never empty.
    public var hosts: [String]?

    public init(id: String = UUID().uuidString, name: String, host: String, port: Int, hosts: [String]? = nil) {
        self.id = id
        self.name = name
        self.host = Self.urlHost(host)
        self.port = port
        self.hosts = hosts
    }

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
        for prefix in ["http://", "https://"] where trimmed.lowercased().hasPrefix(prefix) {
            trimmed.removeFirst(prefix.count)
            break
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

    /// Plain HTTP, and that is a real limitation rather than an oversight.
    ///
    /// The bearer token goes out in a header on every request, so anyone who
    /// can observe the path between phone and computer can lift it and use it
    /// until the device is revoked. What that means in practice depends
    /// entirely on how you reach the computer, and the two supported routes
    /// are not equivalent:
    ///
    /// - **Over a tailnet** — the recommended route, and the only one that
    ///   works away from home — the traffic is inside WireGuard before it
    ///   reaches any network, so it is encrypted and authenticated end to end
    ///   even though this URL says `http`.
    /// - **Over a LAN**, it is cleartext on that network. Trust it exactly as
    ///   far as you trust everyone on the wifi: fine at home, not fine on a
    ///   café or conference network — pair over the tailnet there instead.
    ///
    /// TLS is not a drop-in improvement here, which is why it is not simply
    /// switched on. A self-signed certificate on a LAN address is a
    /// certificate nothing can validate, so it would have to be pinned at
    /// pairing time and re-pinned whenever the sidecar regenerates it — a
    /// meaningful amount of machinery whose benefit, on the tailnet path, is
    /// zero. The honest position is: the tailnet carries the encryption, the
    /// LAN path is documented as trusted-network-only, and pinned TLS is what
    /// this needs before it could claim otherwise. See `docs/ios-companion.md`.
    public var baseURL: URL? {
        var components = URLComponents()
        components.scheme = "http"
        // Normalize here too so connections saved by older builds with an
        // unbracketed IPv6 host remain usable after an update.
        components.host = Self.urlHost(host)
        components.port = port
        return components.url
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
        return PairingInvite(connection: connection, credential: credential)
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

public struct CompanionClient: Sendable {
    public let connection: Connection
    private let token: String?
    private let session: URLSession

    public init(connection: Connection, token: String?, session: URLSession = .shared) {
        self.connection = connection
        self.token = token
        self.session = session
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
        request.timeoutInterval = 20
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
    /// Those messages are written for people ("pair this device in
    /// OpenMausBot → Settings → Companion"), so passing them through beats
    /// inventing a worse one here.
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
        session: URLSession = .shared
    ) async throws -> PairResponse {
        let client = CompanionClient(connection: connection, token: nil, session: session)
        // A six-digit credential is an older desktop or manual entry. Keep
        // its field name for compatibility; new QR credentials use the
        // explicit field and are never persisted by the app.
        let key = credential.utf8.count == 6 && credential.utf8.allSatisfy({ (48...57).contains($0) })
            ? "code"
            : "credential"
        let pairRequest = try client.makeRequest(
            "POST",
            "/api/pair",
            body: [key: credential, "deviceName": deviceName]
        )
        return try await client.send(pairRequest, as: PairResponse.self)
    }

    // MARK: - Reading

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

    public func config() async throws -> ConfigStatus {
        try await send(try makeRequest("GET", "/api/config"), as: ConfigStatus.self)
    }

    /// The pixels of one screen message.
    public func image(threadId: String, messageId: String) async throws -> Data {
        let imageRequest = try makeRequest("GET", "/api/threads/\(threadId)/messages/\(messageId)/image")
        let (data, response) = try await perform(imageRequest)
        try Self.check(response, data)
        return data
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

    public func uploadAvatar(data: Data, mime: String) async throws -> String {
        let allowed = ["image/png", "image/jpeg", "image/gif", "image/webp"]
        guard allowed.contains(mime), data.count <= 10 * 1_024 * 1_024 else {
            throw APIError.transport("Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.")
        }
        var request = try makeRequest("POST", "/api/attachments")
        request.setValue(mime, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let saved = try await send(request, as: AttachmentResponse.self)
        let name = URL(fileURLWithPath: saved.path).lastPathComponent
        guard !name.isEmpty, !name.contains("/") else { throw APIError.transport("The uploaded image could not be used.") }
        return "/api/attachments/\(name)"
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
        var body: [String: Any] = [
            "name": input.name, "prompt": input.prompt, "botId": input.botId,
            "runOn": input.runOn, "schedule": schedule, "durationMinutes": input.durationMinutes,
        ]
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

    public func send(text: String, toBot botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/messages", body: ["text": text]))
    }

    public func send(text: String, toRoom groupId: String) async throws {
        try await send(try makeRequest("POST", "/api/groups/\(groupId)/messages", body: ["text": text]))
    }

    /// Answer an approval or a question.
    ///
    /// Addressed by thread rather than by bot on purpose: a request raised
    /// inside a room belongs to whichever member is speaking, and the
    /// harness already knows which that is.
    public func respond(threadId: String, requestId: String, behavior: String, message: String? = nil) async throws {
        var body: [String: Any] = ["requestId": requestId, "behavior": behavior]
        if let message { body["message"] = message }
        try await send(try makeRequest("POST", "/api/threads/\(threadId)/respond", body: body))
    }

    /// Remember a grant so the same tool stops asking. The harness decides
    /// the key and puts it on the card; the phone never derives its own.
    public func alwaysAllow(botId: String, key: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/always-allow", body: ["allowKey": key]))
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

    public func interrupt(botId: String) async throws {
        try await send(try makeRequest("POST", "/api/bots/\(botId)/interrupt"))
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
