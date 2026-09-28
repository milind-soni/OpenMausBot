// What a home-screen widget renders: the app's updates, frozen on disk.
//
// The widget extension is a separate process on a system-budgeted timeline,
// so it cannot subscribe to the session. Instead the app publishes the same
// `updates` the pill reads — one Codable file in the App Group — and the
// widgets read it back exactly as written. The face is resolved at write
// time into a plain string because the widget has no state to resolve it
// from; `writtenAt` is what lets a widget say how old it is instead of
// pretending the last write is current.
import Foundation

/// The snapshot a home-screen widget renders: the updates the app had when
/// it last wrote, one row per chat that needs you, is working, or finished
/// unread.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Row: Codable, Equatable, Sendable {
        public let chat: Chat
        public let kind: ChatUpdate.Kind
        public let line: String
        /// The ask to answer, when `kind == .needsYou`.
        public let card: OptionCard?
        /// The mascot face the app had resolved for this chat, as its raw
        /// name — precomputed so the widget needs no live state to draw.
        public let face: String
        /// When this chat's current kind began, when the writer knew — the
        /// elapsed clock a per-chat widget renders. The derivation stamps it
        /// through a closure so the timing rule can live where the timing
        /// actually happens (`WidgetSinceClock`); nil means "not known", and
        /// a snapshot written before the field existed decodes as exactly
        /// that rather than failing to read.
        public let since: Date?

        /// The options a compact surface may offer as one-tap answers —
        /// the same rule the Updates sheet's pills follow.
        public var answerOptions: [String] {
            ChatUpdate.answerOptions(kind: kind, card: card)
        }
    }

    /// When the app wrote this snapshot; widgets age their content from it.
    public let writtenAt: Date
    /// The connection the rows belong to, so a widget that answers resolves
    /// the right computer's token and never mixes one computer's asks with
    /// another's.
    public let connectionID: String
    public let rows: [Row]
}

extension WidgetSnapshot {
    /// An empty write from "now" — what a placeholder renders, so a
    /// preview crosses the same fresh-to-stale line a real quiet
    /// snapshot does instead of occupying a state nothing produces.
    public static func empty(connectionID: String = "", now: Date = Date()) -> WidgetSnapshot {
        WidgetSnapshot(writtenAt: now, connectionID: connectionID, rows: [])
    }

    /// How long after `writtenAt` a rendered pill may still be tapped:
    /// the ten-minute trust window `answerableCard` enforces at tap time.
    /// The widget timeline and pill view share it so the buttons
    /// disappear at the same moment taps stop working.
    public static let answerMaximumAge: TimeInterval = 600

    /// The ask a widget answer button may still answer, or nil when the
    /// rendered pill has gone stale. A widget renders one frozen moment;
    /// the request it offered to answer may since have been answered,
    /// dismissed, or superseded. The guard mirrors the Live Activity
    /// `canAnswer` — same thread, same request, an offered option, the
    /// same card kind — and adds what only a snapshot knows: the ask must
    /// still be live, must not be a SKILL.md request (compact surfaces
    /// never grow pills for those), and the write must be recent enough to
    /// trust — ten minutes, after which the only safe answer is the one
    /// given in the chat.
    public func answerableCard(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Bool,
        at now: Date = Date(),
        maximumAge: TimeInterval = answerMaximumAge
    ) -> OptionCard? {
        guard now.timeIntervalSince(writtenAt) <= maximumAge else { return nil }
        guard let row = rows.first(where: { $0.chat.threadId == threadId }),
              row.kind == .needsYou,
              let card = row.card,
              card.isPending,
              card.skillRequest == nil,
              card.requestId == requestId,
              card.options.contains(choice),
              card.isPermission == isPermission
        else { return nil }
        return card
    }

    /// The snapshot with one answered ask gone, for the moment a widget
    /// answer lands: the row leaves the home screen immediately, even
    /// when the network refresh behind it cannot reach the computer.
    /// Everything else is kept exactly as written — including
    /// `writtenAt`, so the widget keeps telling the truth about how old
    /// the rest of its data is.
    public func removingRow(answeredInThread threadId: String) -> WidgetSnapshot {
        WidgetSnapshot(
            writtenAt: writtenAt,
            connectionID: connectionID,
            rows: rows.filter { $0.chat.threadId != threadId }
        )
    }
}

extension CompanionState {
    /// Freezes the current `updates` for the widget extension, one row per
    /// update. `face` resolves each chat's mascot at write time — a closure
    /// because the mascot tables live in the app target, above Core; the
    /// widget only ever sees the resulting string.
    public func widgetSnapshot(
        connectionID: String,
        now: Date = Date(),
        face: (Chat) -> String,
        since: (ChatUpdate) -> Date? = { _ in nil }
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            writtenAt: now,
            connectionID: connectionID,
            rows: updates.map { update in
                WidgetSnapshot.Row(
                    chat: update.chat,
                    kind: update.kind,
                    line: update.line,
                    card: update.card,
                    face: face(update.chat),
                    since: since(update)
                )
            }
        )
    }
}

/// The elapsed clock a home-screen widget keeps per chat — the same rule
/// the Live Activity coordinator runs: the clock starts when a chat's kind
/// changes and keeps running while the kind holds; a chat leaving the
/// updates forgets its stamp entirely, so its return restarts the clock.
/// Where the island's clock is coordinator-local, a widget's must survive
/// the app relaunching and the widget process refreshing the snapshot
/// itself, so the clock seeds from the last snapshot on disk.
public struct WidgetSinceClock: Equatable, Sendable {
    private struct Stamp: Equatable, Sendable {
        var kind: ChatUpdate.Kind
        var at: Date
    }

    private var stamps: [Chat: Stamp] = [:]

    public init() {}

    /// A clock that carries forward the stamps the last snapshot wrote, so
    /// work that began before a relaunch keeps its true start. Rows with
    /// no stamp of their own seed nothing — "unknown" never becomes a
    /// guess.
    public init(seed: WidgetSnapshot?) {
        for row in seed?.rows ?? [] {
            guard let at = row.since else { continue }
            stamps[row.chat] = Stamp(kind: row.kind, at: at)
        }
    }

    /// The elapsed clock's start for a chat as it appears now. Same kind
    /// keeps the running stamp; a new kind starts a new clock.
    public mutating func stamp(for chat: Chat, kind: ChatUpdate.Kind, at now: Date = Date()) -> Date {
        if let held = stamps[chat], held.kind == kind { return held.at }
        stamps[chat] = Stamp(kind: kind, at: now)
        return now
    }

    /// Forgets the chats not in the current updates, the way the island
    /// drops its clock when an activity ends: a chat that returns has
    /// genuinely begun something new.
    public mutating func forget(absentFrom chats: [Chat]) {
        let live = Set(chats)
        stamps = stamps.filter { live.contains($0.key) }
    }
}

/// Reads and writes the snapshot file. Both sides of the contract — the app
/// that publishes and the widget that renders — go through this one type,
/// so the file's format cannot drift between them. The directory is
/// injectable so tests can round-trip a temp folder; the app passes the App
/// Group container.
public struct WidgetSnapshotStore: Sendable {
    public static let fileName = "widget-updates-snapshot.json"

    private let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public var fileURL: URL { directory.appendingPathComponent(Self.fileName) }

    /// The last snapshot, or nil when no readable one exists. A missing or
    /// undecodable file reads as nil without touching what is on disk — a
    /// corrupt snapshot stays put for diagnosis rather than silently
    /// becoming "nothing happened".
    public func read() -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    /// Writes the snapshot so a reader never catches a half-written file:
    /// the bytes land in a uniquely named temp file first, then replace the
    /// destination in one step.
    public func write(_ snapshot: WidgetSnapshot) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(snapshot)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let tempURL = directory.appendingPathComponent(Self.fileName + ".tmp-" + UUID().uuidString)
        try data.write(to: tempURL, options: .atomic)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
    }

    /// Removes the snapshot. A file that never existed is not an error.
    public func remove() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
