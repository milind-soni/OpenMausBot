import CompanionCore
import SwiftUI

/// A read-only summary of one bot: who it is, what it does, what it can
/// reach, what it won't do, and its recent activity. No settings and no
/// transcript live here — this mirrors the paired-safe `BotOverview` payload
/// exactly. Shell copied from `ConnectedAppsView`.
struct BotOverviewView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @State private var overview: BotOverview?
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        List {
            if let overview {
                Section("Who") {
                    Text(overview.who.name).font(.headline)
                    if !overview.who.title.isEmpty {
                        Text(overview.who.title)
                    }
                    if !overview.who.blurb.isEmpty {
                        Text(overview.who.blurb)
                    }
                    if !overview.who.soulLead.isEmpty {
                        Text(overview.who.soulLead)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Does") {
                    if overview.does.isEmpty {
                        Text("Nothing scheduled or learned yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(overview.does.enumerated()), id: \.offset) { _, line in
                            Label(line, systemImage: "calendar.badge.clock")
                        }
                    }
                }

                Section("Can reach") {
                    ForEach(Array(overview.reaches.enumerated()), id: \.offset) { _, line in
                        Label(line, systemImage: "network")
                    }
                }

                Section("Won't") {
                    ForEach(Array(overview.wont.enumerated()), id: \.offset) { _, line in
                        Label(line, systemImage: "hand.raised")
                    }
                }

                Section("Recent changes") {
                    if overview.recent.isEmpty {
                        Text("No changes recorded yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(overview.recent.enumerated()), id: \.offset) { _, change in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(change.summary)
                                Text(Date(timeIntervalSince1970: change.at / 1_000).formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else if failed {
                Section {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark")
                }
            }
        }
        .navigationTitle("What \(bot.name) does")
        .overlay { if loading && overview == nil { ProgressView() } }
        .task(id: session.connection?.id) {
            overview = nil
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
        let loaded = await session.botOverview(for: bot)
        guard !Task.isCancelled, session.connection?.id == connectionID else { return }
        if let loaded {
            overview = loaded
            failed = false
        } else {
            failed = true
        }
    }
}
