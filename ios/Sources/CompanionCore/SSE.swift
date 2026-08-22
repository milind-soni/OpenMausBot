// Server-sent events, by hand.
//
// Two pieces, deliberately separated: a parser that turns lines into events
// with no I/O in it at all, and a connection that drives it from a
// URLSession byte stream. The parser is where the bugs live — multi-line
// data, comments used as keepalives, the optional space after the colon —
// so it is the part that can be tested without a server.
//
// The harness's stream is documented in `server/index.ts`: each frame is
// `id: <streamId>:<seq>` followed by one `data:` line, separated by a blank
// line, with `: keepalive` comments every 25 seconds.
import Foundation
import OSLog

/// Same subsystem the app's own stream logging uses, so a session reads as
/// one story in Console rather than two halves under different names.
private let log = Logger(subsystem: "com.openmausbot.companion", category: "stream")

/// One event off the wire, before it is understood as a `Frame`.
public struct SSEEvent: Equatable, Sendable {
    public var id: String?
    public var data: String

    public init(id: String? = nil, data: String) {
        self.id = id
        self.data = data
    }
}

/// Line-oriented SSE parser. Feed it every line as it arrives; it returns
/// an event when a blank line closes the block, and nil otherwise.
public struct SSEParser: Sendable {
    private var fields: [(name: String, value: String)] = []

    public init() {}

    public mutating func line(_ raw: String) -> SSEEvent? {
        // AsyncLineSequence strips the newline but not a CR from CRLF
        let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw

        guard !line.isEmpty else {
            let event = Self.event(from: fields)
            fields.removeAll()
            return event
        }
        // ": keepalive" — a comment, and the only reason this stream
        // survives a NAT with a short idle timeout
        guard !line.hasPrefix(":") else { return nil }
        guard let colon = line.firstIndex(of: ":") else {
            // a bare field name with no value is legal and carries nothing
            return nil
        }
        var value = String(line[line.index(after: colon)...])
        // exactly one optional leading space after the colon, per the spec
        if value.hasPrefix(" ") { value.removeFirst() }
        fields.append((name: String(line[line.startIndex..<colon]), value: value))
        return nil
    }

    /// Anything still buffered when the stream ends. An event without its
    /// closing blank line is incomplete, so this is deliberately discarded
    /// rather than guessed at.
    public mutating func reset() {
        fields.removeAll()
    }

    static func event(from fields: [(name: String, value: String)]) -> SSEEvent? {
        var id: String?
        var dataLines: [String] = []
        for field in fields {
            switch field.name {
            case "data": dataLines.append(field.value)
            case "id": id = field.value
            default: break
            }
        }
        guard !dataLines.isEmpty else { return nil }
        return SSEEvent(id: id, data: dataLines.joined(separator: "\n"))
    }
}

/// A live connection to `/api/events`, as an async sequence of frames.
///
/// Built as an `AsyncThrowingStream` around a single Task, rather than as a
/// hand-written `AsyncSequence`, for one specific reason: `URLSession.AsyncBytes`
/// owns the underlying data task and **cancels it when the sequence is
/// released**. An earlier version here kept only the derived line iterator and
/// let the `AsyncBytes` value go out of scope at the end of `next()`. The
/// server saw the connection open and immediately close; the client saw
/// NSURLErrorCancelled; the app reconnected forever and showed a spinner. The
/// whole class of bug disappears when one Task holds `bytes` for the entire
/// lifetime of the connection, which is what the loop below does.
///
/// Reconnection is *not* handled here — that decision belongs to whatever
/// knows whether the app is even on screen. This runs until the stream ends
/// or the consuming task is cancelled.
public func eventStream(
    request: URLRequest,
    session: URLSession = .shared
) -> AsyncThrowingStream<StreamFrame, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            do {
                let (bytes, response) = try await session.bytes(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    throw APIError.status(code: http.statusCode, message: nil)
                }

                var parser = SSEParser()
                let decoder = JSONDecoder()
                var line = [UInt8]()

                // Split on newlines by hand rather than using `bytes.lines`.
                //
                // `AsyncLineSequence` does not emit empty lines — it folds
                // consecutive newlines into one separator. In almost any other
                // format that is a convenience; in SSE it is fatal, because a
                // blank line is exactly what terminates an event. Using it
                // meant `SSEParser` was never told an event had ended, so the
                // stream delivered zero frames, forever, while looking
                // perfectly healthy at both ends: the server had an open
                // connection and the client had no error to report.
                //
                // `bytes` also stays in scope for this whole loop, which is
                // the other half of keeping this connection alive — see above.
                //
                // A byte at a time reads as expensive, and for a screen frame
                // — a few hundred kilobytes of base64 PNG — it is a few
                // hundred thousand iterations. It is not a few hundred
                // thousand round trips, though: `AsyncBytes` iterates a buffer
                // URLSession has already filled, so all but one call per chunk
                // returns without suspending. What is left is call overhead on
                // an append, against a stream whose frames are otherwise small
                // and infrequent. Reading the chunks directly means a
                // `URLSessionDataDelegate` and a session built around it,
                // which is precisely the ownership the comment above says this
                // file exists to get right — so it stays as it is until there
                // is a Mac to prove the replacement on.
                for try await byte in bytes {
                    guard byte == 0x0A else {
                        line.append(byte)
                        continue
                    }
                    // \r\n is legal; the parser tolerates a stray \r too
                    if line.last == 0x0D { line.removeLast() }
                    let text = String(decoding: line, as: UTF8.self)
                    line.removeAll(keepingCapacity: true)

                    guard let event = parser.line(text) else { continue }
                    guard let data = event.data.data(using: .utf8) else { continue }
                    // A frame we cannot decode is one frame lost, not a dead
                    // stream: `Frame` already absorbs unknown kinds, so this
                    // only catches genuinely malformed JSON.
                    //
                    // `hello` is the exception that makes the silence
                    // dangerous. `Session` leaves `.connecting` and hydrates
                    // only when a hello arrives, and `Frame.init(from:)`
                    // requires its `cursor` — so a hello missing that field
                    // throws, is dropped here, and the app waits forever on a
                    // stream that is open and healthy, with nothing anywhere
                    // saying why. Naming the kind costs one line and turns
                    // that into something a console can answer.
                    guard let frame = try? decoder.decode(StreamFrame.self, from: data) else {
                        var kind = "unknown"
                        if let object = try? JSONSerialization.jsonObject(with: data),
                           let fields = object as? [String: Any],
                           let named = fields["kind"] as? String {
                            kind = named
                        }
                        log.error("dropped an undecodable frame (kind: \(kind, privacy: .public))")
                        continue
                    }
                    continuation.yield(frame)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
