// The working monitor: the Updates drawer's Working section alone, with
// the reach to keep itself current after the app is gone.
//
// The other widgets age honestly — they keep the snapshot and say how
// old it is. This one earns the budget WidgetKit grants a widget whose
// subject is always moving: when it wakes to a stale snapshot (the app
// has been gone fifteen minutes), the provider performs the same
// miniature hydration a widget answer does — pairing registry, shared
// token, one route loop — and republishes the snapshot before the
// timeline is built. A computer that cannot be reached changes nothing:
// the aged snapshot stands and the footer says how old it is.
//
// The rows are the drawer's working rows: face, name, the line the bot
// is on, and the elapsed clock that began when the work did — the same
// interval the island and the per-bot widget run, kept ticking by the
// system between timeline reloads.
import CompanionCore
import SwiftUI
import WidgetKit

struct WorkingMonitorWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "WorkingMonitorWidget", provider: WorkingMonitorProvider()) { entry in
            WorkingMonitorView(entry: entry)
                .widgetContainerBackground()
        }
        .configurationDisplayName("Working")
        .description("The bots working right now and how long each has been at it — even when the app is closed.")
        .supportedFamilies([.systemMedium])
    }
}

// MARK: - Timeline

/// One rendered moment of the working section. Relevance is the arc's
/// own score for work in progress, 0.6 — this widget is never about
/// the asks, so it never claims their 1.0.
struct WorkingMonitorEntry: TimelineEntry {
    let date: Date
    let state: WidgetSnapshotState

    var workingRows: [WidgetSnapshot.Row] {
        (state.snapshot?.rows ?? []).filter { $0.kind == .working }
    }

    var relevance: TimelineEntryRelevance? {
        TimelineEntryRelevance(score: workingRows.isEmpty ? 0.2 : 0.6)
    }
}

/// Reads the published snapshot — and, when it has gone stale, replaces
/// it first. The network reach is deliberately this provider's alone:
/// the needs-you widgets speak for moments the app witnessed, where a
/// budgeted poll would under-represent; this widget's subject is work
/// that outlives the app, which is exactly what the reach is for.
struct WorkingMonitorProvider: TimelineProvider {
    func placeholder(in context: Context) -> WorkingMonitorEntry {
        WorkingMonitorEntry(date: Date(), state: .quiet(WidgetSnapshot.empty()))
    }

    func getSnapshot(in context: Context, completion: @escaping (WorkingMonitorEntry) -> Void) {
        completion(WorkingMonitorEntry(date: Date(), state: current(now: Date())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WorkingMonitorEntry>) -> Void) {
        Task { completion(await timeline(now: Date())) }
    }

    private func timeline(now: Date) async -> Timeline<WorkingMonitorEntry> {
        var state = current(now: now)
        // The app has been gone fifteen minutes — ask the computer
        // ourselves, then read once more. The trigger is the written
        // age, not the rendered case — classification only relabels
        // what was written, and work that started after the app left
        // would otherwise stay invisible until the next app write.
        // Best effort by design: a refresh that cannot reach
        // the computer leaves the aged snapshot standing, and the view
        // says how old it is.
        if isAged(now: now) {
            await refreshFromNetwork()
            state = current(now: now)
        }
        var entries = [WorkingMonitorEntry(date: now, state: state)]
        if case let .fresh(snapshot) = state {
            entries.append(
                WorkingMonitorEntry(
                    date: snapshot.writtenAt.addingTimeInterval(WidgetSnapshotState.freshnessInterval),
                    state: .stale(snapshot)
                )
            )
        }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
    }

    private func current(now: Date) -> WidgetSnapshotState {
        WidgetSnapshotState.classify(WidgetSnapshotStore.makeAppGroupStore()?.read(), now: now)
    }

    /// Whether the published snapshot has crossed the freshness line —
    /// read from the file rather than the classified state, because the
    /// quiet case carries no age with it.
    private func isAged(now: Date) -> Bool {
        guard let snapshot = WidgetSnapshotStore.makeAppGroupStore()?.read() else { return false }
        return now.timeIntervalSince(snapshot.writtenAt) >= WidgetSnapshotState.freshnessInterval
    }

    /// The Share extension's reach in miniature — registry, shared
    /// token, one route loop — wrapped in the same best-effort silence
    /// the post-answer refresh keeps. A locked keychain or a missing
    /// pairing simply means no refresh this cycle.
    private func refreshFromNetwork() async {
        guard
            let store = WidgetSnapshotStore.makeAppGroupStore(),
            let snapshot = store.read(),
            let connection = OpenMausSharedConnectionStore.loadRegistry()
                .connection(id: snapshot.connectionID),
            let token = try? OpenMausSharedKeychain.token(for: connection.id)
        else { return }
        await WidgetSnapshotRefresh.refresh(connection: connection, token: token, store: store)
    }
}

// MARK: - View

struct WorkingMonitorView: View {
    let entry: WorkingMonitorEntry

    private var rows: [WidgetSnapshot.Row] {
        entry.workingRows
    }

    private var isStale: Bool {
        if case .stale = entry.state { return true }
        return false
    }

    var body: some View {
        Group {
            switch entry.state {
            case .unpaired:
                Placeholder(icon: "qrcode", message: "Open MausBot to pair")
            case .quiet:
                Placeholder(icon: "checkmark.circle", message: "Nothing working")
            case .fresh, .stale:
                if rows.isEmpty {
                    // A snapshot can hold asks without holding work —
                    // that is not "all quiet", so the empty state says
                    // exactly what is empty.
                    Placeholder(icon: "checkmark.circle", message: "Nothing working")
                } else {
                    working
                }
            }
        }
        // Work, not asks: the floor link opens the chat the snapshot
        // ranks first among those working, the same deep link every
        // widget in this extension keeps.
        .widgetURL(rows.first.flatMap { WidgetChatLink.url(threadId: $0.chat.threadId) })
    }

    private var working: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Working")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                Spacer()
                asOf
                Text("\(rows.count) working")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            ForEach(rows.prefix(4), id: \.chat) { row in
                rowView(row)
            }
            Spacer(minLength: 0)
        }
        .opacity(isStale ? 0.7 : 1)
    }

    private func rowView(_ row: WidgetSnapshot.Row) -> some View {
        rowLink(row) {
            HStack(spacing: 8) {
                MausFaceStill(
                    color: row.chat.color,
                    state: MausState(rawValue: row.face) ?? .idle,
                    size: 22
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.chat.name)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text(row.line)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                elapsed(row)
            }
        }
    }

    /// How long this chat has been on this work. Rows written before
    /// the clock existed say nothing rather than guess.
    @ViewBuilder
    private func elapsed(_ row: WidgetSnapshot.Row) -> some View {
        if let since = row.since {
            Text(timerInterval: since...since.addingTimeInterval(86_400), countsDown: false)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }

    /// A row opens its own chat on iOS 17; below it the whole-widget
    /// link carries the tap, the same read-only floor as every widget
    /// in this extension.
    @ViewBuilder
    private func rowLink<Content: View>(
        _ row: WidgetSnapshot.Row,
        @ViewBuilder content: () -> Content
    ) -> some View {
        if #available(iOS 17.0, *), let url = WidgetChatLink.url(threadId: row.chat.threadId) {
            Link(destination: url) { content() }
        } else {
            content()
        }
    }

    /// How old the picture is, owed only when it is stale — the same
    /// disclaimer the other widgets print.
    @ViewBuilder
    private var asOf: some View {
        if isStale, let snapshot = entry.state.snapshot {
            Text("As of \(snapshot.writtenAt.formatted(date: .omitted, time: .shortened))")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
    }
}
