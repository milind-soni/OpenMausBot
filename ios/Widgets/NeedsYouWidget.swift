// The Needs You widget: the bots waiting on an answer, answerable right
// from the home screen.
//
// It renders the same snapshot the Updates pill reads — nothing of its
// own invention — and its answer buttons are the same rule the sheet and
// the Live Activity share: the card's own options, never a list we made
// up. When the app is gone and the snapshot ages, the widget says how old
// it is instead of pretending the last write is current; its pills refuse
// to answer a request the snapshot no longer vouches for.
import CompanionCore
import SwiftUI
import WidgetKit

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "NeedsYouWidget", provider: UpdatesSnapshotProvider()) { entry in
            NeedsYouView(entry: entry)
                .widgetContainerBackground()
        }
        .configurationDisplayName("Needs You")
        .description("Bots waiting on your answer, replyable right from the home screen.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct NeedsYouView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UpdatesSnapshotEntry

    private var asks: [WidgetSnapshot.Row] {
        (entry.state.snapshot?.rows ?? []).filter { $0.kind == .needsYou }
    }

    private var isStale: Bool {
        if case .stale = entry.state { return true }
        return false
    }

    /// Pills answer only inside `answerableCard`'s trust window; past it
    /// every tap would fail with "This request has changed", so the
    /// buttons leave with the window. `entry.date` is the moment this
    /// render stands for — the timeline schedules an entry exactly at
    /// the window's end.
    private var pillsAnswerable: Bool {
        guard let snapshot = entry.state.snapshot else { return false }
        return entry.date.timeIntervalSince(snapshot.writtenAt) < WidgetSnapshot.answerMaximumAge
    }

    var body: some View {
        Group {
            switch entry.state {
            case .unpaired:
                Placeholder(icon: "qrcode", message: "Open MausBot to pair")
            case .quiet:
                Placeholder(icon: "checkmark.circle", message: "All quiet")
            case .fresh, .stale:
                // A published snapshot may hold only working or review
                // rows; for a widget named Needs You that is still all
                // quiet — aged honestly when the write has gone stale.
                if asks.isEmpty {
                    VStack(spacing: 6) {
                        Placeholder(icon: "checkmark.circle", message: "All quiet")
                        asOf
                    }
                } else if family == .systemSmall {
                    smallRow(asks[0])
                } else {
                    mediumRows
                }
            }
        }
        // A widget with no ask on it taps into nothing; with one, it
        // opens that chat — the same openmausbot://chat link the app
        // routes from notifications.
        .widgetURL(asks.first.flatMap { WidgetChatLink.url(threadId: $0.chat.threadId) })
    }

    private func smallRow(_ row: WidgetSnapshot.Row) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                MausFaceStill(
                    color: row.chat.color,
                    state: MausState(rawValue: row.face) ?? .idle,
                    size: 30
                )
                Text(row.chat.name)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
            }
            Text(row.line)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            AnswerPills(row: row, compact: false, answerable: pillsAnswerable)
            asOf
            Spacer(minLength: 0)
        }
        .opacity(isStale ? 0.7 : 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var mediumRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Needs you")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                Spacer()
                asOf
            }
            ForEach(asks.prefix(3), id: \.chat) { row in
                HStack(spacing: 8) {
                    MausFaceStill(
                        color: row.chat.color,
                        state: MausState(rawValue: row.face) ?? .idle,
                        size: 26
                    )
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.chat.name)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        Text(row.line)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    AnswerPills(row: row, compact: true, answerable: pillsAnswerable)
                }
                .opacity(isStale ? 0.7 : 1)
            }
            Spacer(minLength: 0)
        }
    }

    /// How old the picture is — the one thing a widget with no live app
    /// behind it can still say truthfully. Only stale snapshots owe the
    /// disclaimer.
    @ViewBuilder
    private var asOf: some View {
        if isStale, let snapshot = entry.state.snapshot {
            Text("As of \(snapshot.writtenAt.formatted(date: .omitted, time: .shortened))")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
    }
}

struct Placeholder: View {
    let icon: String
    let message: LocalizedStringKey

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The ask's options, as one-tap answers — the same options the Updates
/// sheet's pills offer. A refusal renders as a quiet capsule rather than
/// the bot's colour: "Stop" is not a brand moment.
struct AnswerPills: View {
    let row: WidgetSnapshot.Row
    let compact: Bool
    let answerable: Bool

    var body: some View {
        // Answering from the home screen is an interactive-widget
        // feature, and those arrived in iOS 17. Below that the buttons
        // would be dead pills, so say where the answer lives instead of
        // pretending — the same stance the island takes.
        if #available(iOS 17.0, *) {
            pills
        } else {
            Text("Open MausBot to answer")
                .font(.system(size: compact ? 11 : 13, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @available(iOS 17.0, *)
    private var pills: some View {
        HStack(spacing: 6) {
            if let card = row.card, answerable {
                ForEach(Array(row.answerOptions.prefix(3)), id: \.self) { option in
                    Button(intent: WidgetAnswerIntent(
                        threadId: row.chat.threadId,
                        requestId: card.requestId ?? "",
                        choice: option,
                        isPermission: card.isPermission
                    )) {
                        Text(option)
                            .font(.system(size: compact ? 11 : 13, weight: .semibold))
                            .foregroundStyle(OptionCard.isRefusal(option) ? Color.primary : .white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .padding(.horizontal, compact ? 8 : 10)
                            .frame(height: compact ? 24 : 30)
                            .background(
                                Capsule().fill(
                                    OptionCard.isRefusal(option)
                                        ? Color.secondary.opacity(0.2)
                                        : MausPalette.color(row.chat.color)
                                )
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
