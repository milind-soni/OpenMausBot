import CompanionCore
import SwiftUI

/// The people, places, decisions and terms every bot in a section shares.
/// Bots add what they learn (places and terms land at once; people and
/// decisions wait here for a tap); the person answers, edits, adds, and
/// removes. The phone twin of Team map → Memory on the desktop.
struct TeamMemoryView: View {
    let section: String
    @EnvironmentObject private var session: Session
    @State private var page: TeamMemoryPage?
    @State private var loading = false
    @State private var failed = false
    @State private var busyID: String?
    @State private var adding = false
    @State private var draftKind = "term"
    @State private var draftName = ""
    @State private var draftDetail = ""

    private static let kinds: [(kind: String, title: LocalizedStringKey)] = [
        ("person", "People"), ("place", "Places"), ("decision", "Decisions"), ("term", "Terms"),
    ]

    private var entries: [TeamMemoryEntry] { page?.entries ?? [] }
    private var proposed: [TeamMemoryEntry] { entries.filter { $0.status == "proposed" } }

    var body: some View {
        List {
            if !proposed.isEmpty {
                Section("Waiting for you") {
                    ForEach(proposed) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            EntryLine(entry: entry)
                            HStack {
                                Button("Remember", systemImage: "checkmark") {
                                    Task { await answer(entry, remember: true) }
                                }
                                .buttonStyle(.borderedProminent)
                                Button("Skip") {
                                    Task { await answer(entry, remember: false) }
                                }
                                .buttonStyle(.bordered)
                            }
                            .disabled(busyID == entry.id)
                        }
                    }
                }
            }
            if let page, page.entries.filter({ $0.status == "accepted" }).isEmpty, proposed.isEmpty {
                Section {
                    Text("Nothing shared yet. Bots add entries as they learn who is who and where things live, or add one below.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Self.kinds, id: \.kind) { kind in
                let rows = entries.filter { $0.status == "accepted" && $0.kind == kind.kind }
                if !rows.isEmpty {
                    Section(kind.title) {
                        ForEach(rows) { entry in
                            EntryLine(entry: entry)
                                .swipeActions(edge: .trailing) {
                                    Button(role: .destructive) {
                                        Task { await remove(entry) }
                                    } label: {
                                        Label("Remove", systemImage: "trash")
                                    }
                                }
                        }
                    }
                }
            }
            Section {
                if adding {
                    Picker("Kind", selection: $draftKind) {
                        Text("Person").tag("person")
                        Text("Place").tag("place")
                        Text("Decision").tag("decision")
                        Text("Term").tag("term")
                    }
                    TextField("Name", text: $draftName)
                    TextField("What every bot should know about it", text: $draftDetail, axis: .vertical)
                        .lineLimit(2...4)
                    HStack {
                        Button("Add") { Task { await add() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(busyID == "new" || draftName.trimmingCharacters(in: .whitespaces).isEmpty || draftDetail.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Cancel") { adding = false }
                            .buttonStyle(.bordered)
                    }
                } else {
                    Button("Add an entry", systemImage: "plus") { adding = true }
                }
            }
            if failed {
                Section {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark")
                }
            }
        }
        .navigationTitle(page.map { "\($0.label) team memory" } ?? "Team memory")
        .overlay { if loading && page == nil { ProgressView() } }
        .task(id: session.connection?.id) {
            page = nil
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
        let loaded = await session.teamMemory(section: section)
        guard !Task.isCancelled, session.connection?.id == connectionID else { return }
        if let loaded {
            page = loaded
            failed = false
        } else {
            failed = true
        }
    }

    private func apply(_ entries: [TeamMemoryEntry]?) {
        guard let entries, var current = page else { return }
        current.entries = entries
        page = current
    }

    private func answer(_ entry: TeamMemoryEntry, remember: Bool) async {
        busyID = entry.id
        defer { busyID = nil }
        apply(await session.editTeamMemory { try await $0.answerTeamMemory(section: section, id: entry.id, remember: remember) })
    }

    private func remove(_ entry: TeamMemoryEntry) async {
        busyID = entry.id
        defer { busyID = nil }
        apply(await session.editTeamMemory { try await $0.removeTeamMemory(section: section, id: entry.id) })
    }

    private func add() async {
        busyID = "new"
        defer { busyID = nil }
        let name = draftName.trimmingCharacters(in: .whitespaces)
        let detail = draftDetail.trimmingCharacters(in: .whitespaces)
        let result = await session.editTeamMemory { try await $0.addTeamMemory(section: section, kind: draftKind, name: name, detail: detail) }
        if result != nil {
            draftName = ""
            draftDetail = ""
            adding = false
        }
        apply(result)
    }
}

private struct EntryLine: View {
    let entry: TeamMemoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(entry.name).fontWeight(.medium)
                if !entry.aliases.isEmpty {
                    Text("(also \(entry.aliases.joined(separator: ", ")))")
                        .foregroundStyle(.secondary)
                }
            }
            Text(entry.detail)
            Text("\(entry.source.botName.isEmpty ? "you" : entry.source.botName) · \(Date(timeIntervalSince1970: entry.updatedAt / 1_000).formatted(date: .abbreviated, time: .omitted))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
