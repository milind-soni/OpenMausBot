import CompanionCore
import SwiftUI

/// What one bot did, newest first, grouped by day: every tool it used and
/// every approval it asked for, each with the outcome. The phone twin of the
/// desktop's Activity panel; read-only, like the overview beside it.
struct BotActivityView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @State private var rows: [ActivityRow]?
    @State private var loading = false
    @State private var failed = false

    private static let isoParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private struct Day: Identifiable {
        let id: String
        let label: String
        let rows: [ActivityRow]
    }

    private var days: [Day] {
        guard let rows else { return [] }
        let calendar = Calendar.current
        var result: [Day] = []
        for row in rows {
            let date = Self.isoParser.date(from: row.at) ?? ISO8601DateFormatter().date(from: row.at) ?? Date()
            let key = calendar.startOfDay(for: date)
            let id = "\(key.timeIntervalSince1970)"
            if let last = result.last, last.id == id {
                result[result.count - 1] = Day(id: id, label: last.label, rows: last.rows + [row])
            } else {
                let label = calendar.isDateInToday(date) ? String(localized: "Today")
                    : calendar.isDateInYesterday(date) ? String(localized: "Yesterday")
                    : date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
                result.append(Day(id: id, label: label, rows: [row]))
            }
        }
        return result
    }

    var body: some View {
        List {
            if let rows, rows.isEmpty {
                Section {
                    Text("Nothing yet. Once \(bot.name) runs a tool or asks for an approval, it shows up here.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(days) { day in
                Section(day.label) {
                    ForEach(Array(day.rows.enumerated()), id: \.offset) { _, row in
                        ActivityRowView(row: row)
                    }
                }
            }
            if failed {
                Section {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark")
                }
            }
        }
        .navigationTitle("\(bot.name) activity")
        .overlay { if loading && rows == nil { ProgressView() } }
        .task(id: session.connection?.id) {
            rows = nil
            failed = false
            await load()
        }
        .refreshable { await load() }
    }

    private func load() async {
        let connectionID = session.connection?.id
        loading = true
        defer {
            if !Task.isCancelled, session.connection?.id == connectionID { loading = false }
        }
        let loaded = await session.botActivity(for: bot)
        guard !Task.isCancelled, session.connection?.id == connectionID else { return }
        if let loaded {
            rows = loaded
            failed = false
        } else {
            failed = true
        }
    }
}

private struct ActivityRowView: View {
    let row: ActivityRow

    private var time: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: row.at) ?? ISO8601DateFormatter().date(from: row.at)
        return date.map { $0.formatted(date: .omitted, time: .shortened) } ?? ""
    }

    private var chip: (text: LocalizedStringKey, color: Color) {
        switch row.outcome {
        case "ran", "allowed": return ("\(row.outcome == "ran" ? "Ran" : "Allowed")", .green)
        case "failed", "denied": return ("\(row.outcome == "failed" ? "Failed" : "Denied")", .red)
        case "running": return ("Running", .accentColor)
        case "waiting": return ("Needs you", .orange)
        default: return ("\(row.outcome)", .secondary)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(time)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if let app = row.app {
                        Text(app).fontWeight(.medium)
                        Text("·").foregroundStyle(.secondary)
                    }
                    Text(row.label).lineLimit(1)
                }
                if let summary = row.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 6)
            Text(chip.text)
                .font(.caption2.weight(.medium))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(chip.color.opacity(0.15), in: Capsule())
                .foregroundStyle(chip.color)
        }
        .padding(.vertical, 2)
    }
}
