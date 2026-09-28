// The per-chat widget: one bot or room, picked once, mirrored for as
// long as it has something to say.
//
// The digest answers "what needs me"; this one answers "what is *this*
// chat doing" — the Dynamic Island's single-bot content, but pinned to
// the home screen and alive whether or not the app is. It renders the
// chat's current kind the same way the island renders it: the ask with
// its one-tap answers, the working line with the one clock iOS keeps
// ticking for us, the finished line waiting to be read. The picker
// enumerates the snapshot's chats — the configuration intent runs in the
// extension, and the snapshot is the cheap, credential-free source; a
// chat the picker once chose keeps its pick-time identity on disk so a
// quiet spell never orphans the widget.
//
// iOS 17 and up only, on purpose: configuring a widget through AppIntents
// arrived with 17, and the 16-era path is the SiriKit Intents extension
// this arc swore off (no new targets). Every other widget in the bundle
// keeps the 16.1 read-only floor; this one simply does not offer itself
// below 17.
import AppIntents
import CompanionCore
import Foundation
import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct BotWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "BotWidget", intent: SelectChatIntent.self, provider: BotTimelineProvider()) { entry in
            BotWidgetView(entry: entry)
                .widgetContainerBackground()
        }
        .configurationDisplayName("Bot")
        .description("One chat's status at a glance — pick which one on the widget's settings.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - Intent and entity

/// Which chat this widget watches. The only parameter, chosen from the
/// snapshot's chats; none chosen means the widget still has its floor —
/// the pairing and setup placeholders — but nothing to say.
@available(iOS 17.0, *)
struct SelectChatIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Bot"
    static var description = IntentDescription("Choose the chat this widget watches.")
    static var isDiscoverable = false

    @Parameter(title: "Chat")
    var chat: ChatEntity?
}

/// One chat the snapshot currently reports — bot or room, exactly the
/// rows every other widget renders. Codable on purpose: the system
/// persists the picked entity as-is, so a chat that goes quiet keeps its
/// name and face in the widget instead of orphaning it, and the query
/// refreshes the identity whenever the chat reappears in a snapshot.
@available(iOS 17.0, *)
struct ChatEntity: AppEntity, Codable, Equatable {
    let id: String
    let name: String
    let color: String
    let face: String

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Chat")
    static let defaultQuery = ChatEntityQuery()

    var threadId: String { id }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }

    init(id: String, name: String, color: String, face: String) {
        self.id = id
        self.name = name
        self.color = color
        self.face = face
    }

    init(row: WidgetSnapshot.Row) {
        self.init(
            id: row.chat.threadId,
            name: row.chat.name,
            color: row.chat.color,
            face: row.face
        )
    }
}

/// The picker's source: the snapshot, nothing else. The intent runs in
/// the extension, and the App Group file needs no credentials — the
/// picker never reaches for the network or the keychain. An empty
/// snapshot offers no chats; the widget says what to do instead.
///
/// Resolution survives a quiet spell by design: WidgetKit re-resolves a
/// saved identifier through `entities(for:)`, and a chat absent from
/// the rows would read as no pick at all — the widget would demand
/// configuration again instead of saying all quiet. The identity saved
/// at pick time stands in until the chat reappears.
@available(iOS 17.0, *)
struct ChatEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ChatEntity] {
        let present = await current()
        // The snapshot does not promise one row per thread, and a trap
        // here would crash the extension mid-resolution; duplicates
        // resolve to whichever row the snapshot ranks first.
        var known = Dictionary(present.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // Refresh the persisted identity of every chat asked for that
        // the snapshot still mentions — from the deduplicated map, so
        // a duplicate row cannot displace the first-ranked pick — and
        // a pick carries its current name and face forward.
        let requested = Set(identifiers)
        for (id, entity) in known where requested.contains(id) {
            ChatIdentityStore.save(entity)
        }
        // A chat that has gone quiet resolves from the identity saved at
        // pick time rather than dropping out of the configuration.
        for identifier in identifiers where known[identifier] == nil {
            known[identifier] = ChatIdentityStore.saved()[identifier]
        }
        return identifiers.compactMap { known[$0] }
    }

    func suggestedEntities() async throws -> [ChatEntity] {
        await current()
    }

    private func current() async -> [ChatEntity] {
        guard let snapshot = WidgetSnapshotStore.makeAppGroupStore()?.read() else { return [] }
        return snapshot.rows.map(ChatEntity.init(row:))
    }
}

/// The identities a picker has chosen, kept in the App Group beside the
/// snapshot. The snapshot only carries active rows, so without this file
/// a quiet chat is unresolvable exactly when the widget most needs its
/// identity to keep saying "all quiet" for the chat that was picked.
@available(iOS 17.0, *)
enum ChatIdentityStore {
    static let fileName = "widget-chat-identities.json"

    static func save(_ entity: ChatEntity) {
        var all = saved()
        guard all[entity.id] != entity else { return }
        all[entity.id] = entity
        guard let directory = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: OpenMausSharedConfiguration.appGroupIdentifier
        ), let data = try? JSONEncoder().encode(Array(all.values)) else { return }
        try? data.write(to: directory.appendingPathComponent(fileName), options: .atomic)
    }

    static func saved() -> [String: ChatEntity] {
        guard let directory = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: OpenMausSharedConfiguration.appGroupIdentifier
        ), let data = try? Data(contentsOf: directory.appendingPathComponent(fileName)) else { return [:] }
        let identities = (try? JSONDecoder().decode([ChatEntity].self, from: data)) ?? []
        return Dictionary(uniqueKeysWithValues: identities.map { ($0.id, $0) })
    }
}

// MARK: - Timeline

/// One rendered moment for one chosen chat. The chat's row is absent
/// from the snapshot when it is quiet — the entry then says exactly
/// that, with the identity the pick persisted.
@available(iOS 17.0, *)
struct BotEntry: TimelineEntry {
    let date: Date
    let state: WidgetSnapshotState
    let entity: ChatEntity?

    var row: WidgetSnapshot.Row? {
        guard let entity else { return nil }
        return state.snapshot?.rows.first { $0.chat.threadId == entity.threadId }
    }

    var relevance: TimelineEntryRelevance? {
        switch row?.kind {
        case .needsYou: return TimelineEntryRelevance(score: 1)
        case .working: return TimelineEntryRelevance(score: 0.6)
        case .toReview: return TimelineEntryRelevance(score: 0.35)
        default: return TimelineEntryRelevance(score: 0.2)
        }
    }
}

@available(iOS 17.0, *)
struct BotTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> BotEntry {
        BotEntry(
            date: Date(),
            state: .quiet(WidgetSnapshot.empty()),
            entity: ChatEntity(id: "demo", name: "Maus", color: "", face: MausState.idle.rawValue)
        )
    }

    func snapshot(for configuration: SelectChatIntent, in context: Context) async -> BotEntry {
        current(configuration)
    }

    func timeline(for configuration: SelectChatIntent, in context: Context) async -> Timeline<BotEntry> {
        let now = Date()
        let entry = current(configuration, now: now)
        var entries = [entry]
        if case let .fresh(snapshot) = entry.state {
            // Pills stop answering at the trust window's end; schedule
            // that moment so the buttons leave when taps stop working,
            // not five minutes later at the stale flip.
            let answersExpireAt = snapshot.writtenAt.addingTimeInterval(WidgetSnapshot.answerMaximumAge)
            if answersExpireAt > now {
                entries.append(
                    BotEntry(date: answersExpireAt, state: .fresh(snapshot), entity: entry.entity)
                )
            }
        }
        // The one flip the widget can perform on its own: fresh to stale
        // at the fifteen-minute mark, the same honesty line every widget
        // in this extension keeps — an empty write crosses it too, so a
        // quiet chat stops claiming an unqualified all-clear once the
        // picture behind it has aged.
        switch entry.state {
        case let .fresh(snapshot), let .quiet(snapshot):
            entries.append(
                BotEntry(
                    date: snapshot.writtenAt.addingTimeInterval(WidgetSnapshotState.freshnessInterval),
                    state: .stale(snapshot),
                    entity: entry.entity
                )
            )
        default:
            break
        }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
    }

    private func current(_ configuration: SelectChatIntent, now date: Date = Date()) -> BotEntry {
        let snapshot = WidgetSnapshotStore.makeAppGroupStore()?.read()
        return BotEntry(
            date: date,
            state: WidgetSnapshotState.classify(snapshot, now: date),
            entity: configuration.chat
        )
    }
}

// MARK: - View

@available(iOS 17.0, *)
struct BotWidgetView: View {
    let entry: BotEntry

    private var isStale: Bool {
        if case .stale = entry.state { return true }
        return false
    }

    /// Pills answer only inside `answerableCard`'s trust window, the
    /// same line the Needs You widget draws: past it every tap would
    /// fail with "This request has changed", so the buttons leave with
    /// the window. The timeline schedules the entry that crosses it.
    private var pillsAnswerable: Bool {
        guard let snapshot = entry.state.snapshot else { return false }
        return entry.date.timeIntervalSince(snapshot.writtenAt) < WidgetSnapshot.answerMaximumAge
    }

    var body: some View {
        Group {
            switch (entry.state, entry.entity) {
            case (.unpaired, _):
                Placeholder(icon: "qrcode", message: "Open MausBot to pair")
            case (_, nil):
                Placeholder(icon: "person.crop.circle", message: "Open MausBot first")
            case (.quiet, let entity?), (.fresh, let entity?), (.stale, let entity?):
                content(for: entity)
            default:
                Placeholder(icon: "person.crop.circle", message: "Open MausBot first")
            }
        }
        // The widget is about one chat; every state it can show opens
        // that chat, the same deep link a notification carries.
        .widgetURL(entry.entity.flatMap { WidgetChatLink.url(threadId: $0.threadId) })
    }

    @ViewBuilder
    private func content(for entity: ChatEntity) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                MausFaceStill(
                    color: entry.row?.chat.color ?? entity.color,
                    state: MausState(rawValue: entry.row?.face ?? entity.face) ?? .idle,
                    size: 28
                )
                Text(entry.row?.chat.name ?? entity.name)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
            }
            if let row = entry.row {
                rowBody(row)
            } else {
                // No row means the chat is quiet — not gone. The face is
                // the one the pick persisted, aged honestly by the same
                // dimming every other stale state wears.
                Text("All quiet")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            asOf
            Spacer(minLength: 0)
        }
        .opacity(isStale ? 0.7 : 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The kind's own body — the island's compact content, mirrored: the
    /// ask with its pills, the working line with the elapsed clock, the
    /// finished line waiting to be read.
    @ViewBuilder
    private func rowBody(_ row: WidgetSnapshot.Row) -> some View {
        Text(row.line)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(row.kind == .toReview ? 3 : 2)
        switch row.kind {
        case .needsYou:
            AnswerPills(row: row, compact: false, answerable: pillsAnswerable)
        case .working:
            if let since = row.since {
                // The one clock iOS keeps ticking without a timeline
                // reload — the island runs the same interval.
                Text(timerInterval: since...since.addingTimeInterval(86_400), countsDown: false)
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        case .toReview:
            EmptyView()
        }
    }

    @ViewBuilder
    private var asOf: some View {
        if isStale, let snapshot = entry.state.snapshot {
            Text("As of \(snapshot.writtenAt.formatted(date: .omitted, time: .shortened))")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
    }
}
