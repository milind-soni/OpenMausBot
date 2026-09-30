// The Updates digest widget: everything the Updates pill shows, with the
// chats that need you first.
//
// The Needs You widget exists to answer the top ask; this one is the whole
// drawer — working and to-review rows too, sectioned the way the sheet
// sections them, from the same snapshot. The lock-screen accessories carry
// the same information at a glance: the top face with a count of asks on
// the circle, the top row on the rectangle, a one-line headline inline. On
// iOS 17 each row opens its own chat; below that the widget as a whole
// opens the highest-priority one, the same read-only floor the other
// widgets keep.
import CompanionCore
import SwiftUI
import WidgetKit

struct UpdatesDigestWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UpdatesDigestWidget", provider: UpdatesSnapshotProvider()) { entry in
            UpdatesDigestView(entry: entry)
        }
        .configurationDisplayName("Updates")
        .description("Everything the Updates pill shows, with the chats that need you first.")
        .supportedFamilies([.systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct UpdatesDigestView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UpdatesSnapshotEntry

    private var rows: [WidgetSnapshot.Row] {
        entry.state.snapshot?.rows ?? []
    }

    private var asks: [WidgetSnapshot.Row] {
        rows.filter { $0.kind == .needsYou }
    }

    /// The face the circle wears: the top ask, else the top row — the same
    /// priority the whole-widget link follows.
    private var faceRow: WidgetSnapshot.Row? {
        asks.first ?? rows.first
    }

    private var isStale: Bool {
        if case .stale = entry.state { return true }
        return false
    }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                circular.widgetAccessoryBackground()
            case .accessoryRectangular:
                rectangular.widgetAccessoryBackground()
            case .accessoryInline:
                inline.widgetAccessoryBackground()
            default:
                home.widgetContainerBackground()
            }
        }
        // Every family taps into the same place: the chat the widget is
        // most about. Per-row links on iOS 17 refine this to the row that
        // was tapped; this is the floor every family keeps.
        .widgetURL(rows.first.flatMap { WidgetChatLink.url(threadId: $0.chat.threadId) })
    }

    // MARK: Home screen

    @ViewBuilder
    private var home: some View {
        switch entry.state {
        case .unpaired:
            Placeholder(icon: "qrcode", message: "Open MausBot to pair")
        case .quiet:
            Placeholder(icon: "checkmark.circle", message: "All quiet")
        case .fresh, .stale:
            if rows.isEmpty {
                // An empty write that has aged past honesty keeps the
                // quiet presentation — the digest never flips to an
                // empty "0 active" layout — and gains the age line.
                VStack(spacing: 6) {
                    Placeholder(icon: "checkmark.circle", message: "All quiet")
                    asOf
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Updates")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        asOf
                        Text("\(rows.count) active")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    if family == .systemLarge {
                        largeSections
                    } else {
                        mediumRows
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    /// The medium family is flat: rows arrive already sorted by urgency,
    /// so the first four are the right four.
    private var mediumRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(rows.prefix(4), id: \.chat) { row in
                rowView(row, faceSize: 22, nameSize: 12, lineSize: 11)
            }
        }
    }

    /// The large family is the sheet: the same three sections, capped at
    /// eight rows. A digest that silently truncated would read as
    /// complete, so the cap is a budget spent top-down by priority.
    private var largeSections: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(sectionedRows) { section in
                VStack(alignment: .leading, spacing: 6) {
                    Text(section.title)
                        .textCase(.uppercase)
                        .font(.system(size: 11, weight: .bold))
                        .tracking(0.5)
                        .foregroundStyle(section.tint)
                    ForEach(section.rows, id: \.chat) { row in
                        rowView(row, faceSize: 26, nameSize: 13, lineSize: 12, showsThreadTitle: true)
                    }
                }
            }
        }
    }

    private var sectionedRows: [DigestSection] {
        var sections: [DigestSection] = []
        var budget = 8
        for kind in [ChatUpdate.Kind.needsYou, .working, .toReview] {
            guard budget > 0 else { break }
            let items = Array(rows.filter { $0.kind == kind }.prefix(budget))
            guard !items.isEmpty else { continue }
            budget -= items.count
            sections.append(DigestSection(kind: kind, rows: items))
        }
        return sections
    }

    private func rowView(
        _ row: WidgetSnapshot.Row,
        faceSize: CGFloat,
        nameSize: CGFloat,
        lineSize: CGFloat,
        showsThreadTitle: Bool = false
    ) -> some View {
        rowLink(row) {
            HStack(spacing: 8) {
                MausFaceStill(
                    color: row.chat.color,
                    state: MausState(rawValue: row.face) ?? .idle,
                    size: faceSize
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.chat.name)
                        .font(.system(size: nameSize, weight: .semibold))
                        .lineLimit(1)
                    if showsThreadTitle {
                        Text(row.chat.threadTitle)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Text(row.line)
                        .font(.system(size: lineSize))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                kindMarker(row)
            }
            .opacity(isStale ? 0.7 : 1)
        }
    }

    /// A row opens its own chat — the same deep link a notification
    /// carries. Links are the widget's one navigation gesture, but the
    /// floor this extension keeps is read-only below iOS 17, so the
    /// whole-widget link above carries those taps instead.
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

    /// The kind at a glance — the same marks the Dynamic Island uses for
    /// its compact trailing.
    @ViewBuilder
    private func kindMarker(_ row: WidgetSnapshot.Row) -> some View {
        switch row.kind {
        case .needsYou:
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(MausPalette.color(row.chat.color))
        case .working:
            Image(systemName: "circle.dotted")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
        case .toReview:
            Circle()
                .fill(MausPalette.color(row.chat.color))
                .frame(width: 8, height: 8)
        }
    }

    // MARK: Lock screen

    @ViewBuilder
    private var circular: some View {
        switch entry.state {
        case .unpaired:
            Image(systemName: "qrcode")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.secondary)
        case .quiet:
            // No chat to take a colour from, so the face wears the
            // palette's own fallback grey.
            MausFaceStill(color: "", state: .idle, size: 44)
        case .fresh, .stale:
            ZStack(alignment: .bottom) {
                MausFaceStill(
                    color: faceRow?.chat.color ?? "",
                    state: faceRow.map { MausState(rawValue: $0.face) ?? .idle } ?? .idle,
                    size: 44
                )
                if let ask = asks.first {
                    // The count of asks, as a badge on the chin — the
                    // circle's version of the raised hand.
                    Text(String(asks.count))
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(MausPalette.color(ask.chat.color)))
                }
            }
            .opacity(isStale ? 0.7 : 1)
        }
    }

    @ViewBuilder
    private var rectangular: some View {
        switch entry.state {
        case .unpaired:
            Placeholder(icon: "qrcode", message: "Open MausBot to pair")
        case .quiet:
            Placeholder(icon: "checkmark.circle", message: "All quiet")
        case .fresh, .stale:
            if let row = rows.first {
                HStack(spacing: 8) {
                    MausFaceStill(
                        color: row.chat.color,
                        state: MausState(rawValue: row.face) ?? .idle,
                        size: 20
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.chat.name)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Text(row.line)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .opacity(isStale ? 0.7 : 1)
            } else {
                VStack(spacing: 6) {
                    Placeholder(icon: "checkmark.circle", message: "All quiet")
                    asOf
                }
            }
        }
    }

    @ViewBuilder
    private var inline: some View {
        switch entry.state {
        case .unpaired:
            Text("Open MausBot to pair")
        case .quiet:
            HStack(spacing: 4) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("All quiet")
            }
        case .fresh, .stale:
            if let ask = asks.first {
                HStack(spacing: 4) {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(MausPalette.color(ask.chat.color))
                    Text("\(asks.count) need you")
                }
            } else if rows.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(quietHeadline)
                }
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "circle.dotted")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text("\(rows.count) active")
                }
            }
        }
    }

    /// The inline quiet line, aged when the write has gone stale — the
    /// one-line version of the disclaimer every other empty state prints.
    private var quietHeadline: String {
        if isStale, let snapshot = entry.state.snapshot {
            return "All quiet · \(snapshot.writtenAt.formatted(date: .omitted, time: .shortened))"
        }
        return "All quiet"
    }

    /// How old the picture is, owed only when it is stale — the same
    /// disclaimer the Needs You widget prints.
    @ViewBuilder
    private var asOf: some View {
        if isStale, let snapshot = entry.state.snapshot {
            Text("As of \(snapshot.writtenAt.formatted(date: .omitted, time: .shortened))")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
    }
}

/// One sheet-style section of the large family.
private struct DigestSection: Identifiable {
    let kind: ChatUpdate.Kind
    let rows: [WidgetSnapshot.Row]

    var id: ChatUpdate.Kind { kind }

    var title: LocalizedStringKey {
        switch kind {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .toReview: return "To review"
        }
    }

    /// The section header's colour: the first ask's own under Needs you —
    /// the sheet tints it the same way — secondary elsewhere.
    var tint: Color {
        kind == .needsYou ? MausPalette.color(rows[0].chat.color) : .secondary
    }
}
