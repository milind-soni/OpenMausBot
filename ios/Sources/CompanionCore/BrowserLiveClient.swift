import Foundation

/// What arrives on `GET /api/bots/:id/browser/live`.
///
/// The server normalises every message before it reaches us
/// (`normalizeBrowserLiveMessage`), so these are the only shapes possible and
/// an unknown one is a protocol change, not untrusted input.
public enum BrowserLiveMessage: Sendable, Equatable {
    case frame(BrowserFrame)
    case status(BrowserStatus)
    case url(String)
    case tabs([BrowserTab])
    case ready(viewerId: String)
    case control(controlling: Bool, held: Bool)
    case heartbeat
    case error(String)
}

public struct BrowserFrame: Sendable, Equatable {
    public let seq: Int
    /// Base64 JPEG or PNG, exactly as the server framed it.
    public let data: String
    public let format: String
    public let deviceWidth: Double
    public let deviceHeight: Double

    public init(seq: Int, data: String, format: String, deviceWidth: Double, deviceHeight: Double) {
        self.seq = seq
        self.data = data
        self.format = format
        self.deviceWidth = deviceWidth
        self.deviceHeight = deviceHeight
    }

    /// Decoded bytes, or nil when the base64 was not what it claimed to be.
    /// Returning nil rather than throwing keeps the caller a view.
    public var bytes: Data? { Data(base64Encoded: data) }
}

public struct BrowserStatus: Sendable, Equatable {
    public let connected: Bool
    public let screencasting: Bool
    public let viewportWidth: Double
    public let viewportHeight: Double

    public init(connected: Bool, screencasting: Bool, viewportWidth: Double, viewportHeight: Double) {
        self.connected = connected
        self.screencasting = screencasting
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
    }
}

public struct BrowserTab: Sendable, Equatable, Identifiable {
    public let tabId: String
    public let title: String
    public let url: String
    public let active: Bool

    public init(tabId: String, title: String, url: String, active: Bool) {
        self.tabId = tabId
        self.title = title
        self.url = url
        self.active = active
    }

    public var id: String { tabId }
}

/// Decodes one server message.
///
/// Written by hand because the wire is a tagged union keyed on `type`, and
/// because a message we do not understand must be dropped rather than crash a
/// stream the person is watching.
public enum BrowserLiveDecoder {
    /// The message type travels in the SSE `event:` name, not in the payload —
    /// the server strips it (`const { type, ...data } = message`) before
    /// writing the frame. Keying on the payload instead decoded nothing at
    /// all, which is exactly how this was found.
    public static func message(event: String?, data json: String) -> BrowserLiveMessage? {
        guard let event else { return nil }
        let object = (json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] ?? [:]

        switch event {
        case "frame":
            guard let seq = object["seq"] as? Int,
                  let payload = object["data"] as? String,
                  let metadata = object["metadata"] as? [String: Any],
                  let width = number(metadata["deviceWidth"]),
                  let height = number(metadata["deviceHeight"])
            else { return nil }
            return .frame(BrowserFrame(
                seq: seq,
                data: payload,
                format: (object["format"] as? String) ?? "jpeg",
                deviceWidth: width,
                deviceHeight: height
            ))

        case "status":
            guard let connected = object["connected"] as? Bool else { return nil }
            return .status(BrowserStatus(
                connected: connected,
                screencasting: (object["screencasting"] as? Bool) ?? false,
                viewportWidth: number(object["viewportWidth"]) ?? 1280,
                viewportHeight: number(object["viewportHeight"]) ?? 720
            ))

        case "url":
            guard let url = object["url"] as? String else { return nil }
            return .url(url)

        case "tabs":
            guard let raw = object["tabs"] as? [[String: Any]] else { return nil }
            return .tabs(raw.compactMap { tab in
                guard let id = tab["tabId"] as? String else { return nil }
                return BrowserTab(
                    tabId: id,
                    title: (tab["title"] as? String) ?? "",
                    url: (tab["url"] as? String) ?? "",
                    active: (tab["active"] as? Bool) ?? false
                )
            })

        // The server names this `ready`, and it is the only place a viewer id
        // ever arrives. Without it there is nothing to post an action against.
        case "ready":
            guard let id = object["viewerId"] as? String else { return nil }
            return .ready(viewerId: id)

        case "control":
            return .control(
                controlling: (object["controlling"] as? Bool) ?? false,
                held: (object["held"] as? Bool) ?? false
            )

        case "heartbeat":
            return .heartbeat

        case "error":
            return .error((object["message"] as? String) ?? "The browser stream was interrupted.")

        default:
            // A name we do not know is a protocol change, not a reason to
            // tear down a stream the person is watching.
            return nil
        }
    }

    /// JSONSerialization hands back Int or Double depending on the literal, so
    /// a width of `1280` and one of `1280.0` must both survive.
    private static func number(_ value: Any?) -> Double? {
        (value as? Double) ?? (value as? Int).map(Double.init)
    }
}

/// The browser-live transport: one SSE stream in, one action channel out.
public struct BrowserLiveClient: Sendable {
    private let connection: Connection
    private let token: String?
    private let session: URLSession

    public init(connection: Connection, token: String?, session: URLSession = .shared) {
        self.connection = connection
        self.token = token
        self.session = session
    }

    private func request(_ method: String, _ path: String, body: Data? = nil) throws -> URLRequest {
        guard let base = connection.baseURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw APIError.badURL }
        components.path = path
        guard let url = components.url else { throw APIError.badURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    /// The frame stream. Runs until the server ends it or the consuming task
    /// is cancelled; reconnection belongs to whatever knows if the view is
    /// still on screen, exactly as it does for the main event stream.
    public func live(botId: String) -> AsyncThrowingStream<BrowserLiveMessage, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try request("GET", "/api/bots/\(botId)/browser/live")
                    // A frame stream has no business timing out: it is idle
                    // whenever the page is.
                    request.timeoutInterval = .infinity
                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                        // Read the refusal rather than discard it. Throwing a
                        // bare status made every 403 read as "browser control
                        // is off", whatever the server actually said.
                        var body = Data()
                        for try await byte in bytes {
                            body.append(byte)
                            if body.count >= 4096 { break }
                        }
                        throw APIError.status(code: http.statusCode, message: BrowserLiveClient.errorText(body))
                    }

                    var parser = SSEParser()
                    var line = [UInt8]()
                    // A byte at a time, and deliberately not `bytes.lines`:
                    // that folds consecutive newlines together, and a blank
                    // line is exactly what ends an SSE event. See SSE.swift.
                    for try await byte in bytes {
                        if byte == UInt8(ascii: "\n") {
                            let text = String(decoding: line, as: UTF8.self)
                            line.removeAll(keepingCapacity: true)
                            if let event = parser.line(text),
                               let message = BrowserLiveDecoder.message(event: event.event, data: event.data) {
                                continuation.yield(message)
                            }
                        } else {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// One action. The server answers only after the browser has applied it,
    /// which is what makes the queue's one-in-flight rule necessary.
    @discardableResult
    public func action(botId: String, viewerId: String, body: [String: Any]) async throws -> [String: Any] {
        var payload = body
        payload["viewerId"] = viewerId
        let encoded = try JSONSerialization.data(withJSONObject: payload)
        let request = try request("POST", "/api/bots/\(botId)/browser/action", body: encoded)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badURL }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard http.statusCode == 200 else {
            throw APIError.status(code: http.statusCode, message: object?["error"] as? String)
        }
        return object ?? [:]
    }

    /// The `error` field of a JSON refusal, which is how both the sidecar and
    /// the harness explain themselves.
    static func errorText(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
    }

    /// An input body, posted through the same channel.
    public func send(botId: String, viewerId: String, input: BrowserInputBody) async throws {
        let encoded = try JSONEncoder().encode(input)
        guard var object = (try? JSONSerialization.jsonObject(with: encoded)) as? [String: Any] else {
            throw APIError.badURL
        }
        object["viewerId"] = viewerId
        _ = try await action(botId: botId, viewerId: viewerId, body: object)
    }
}
