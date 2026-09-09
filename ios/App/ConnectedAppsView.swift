import CompanionCore
import SwiftUI
import UIKit

/// Account-aware Composio inventory for a paired phone.
///
/// The companion may list accounts and start authorization, but revocation
/// deliberately remains on the Mac. That keeps a lost phone from removing a
/// workspace integration while still giving mobile users explicit Work,
/// Personal, and client-account choices.
struct ConnectedAppsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.scenePhase) private var scenePhase
    @State private var catalog: ConnectorCatalog?
    /// The last inventory the computer vouched for, or `nil` if it never has.
    /// An empty dictionary is a real answer — "nothing is connected". `nil` is
    /// the absence of an answer, and drawing the two the same way is the whole
    /// bug: it turns "we could not find out" into "you are disconnected".
    @State private var statuses: [String: ConnectorStatus]?
    /// Whether the newest answer withdrew its own authority. `PluginsPanel.tsx`
    /// keeps the same flag for the same reason: silence makes a remembered
    /// list indistinguishable from a confirmed one.
    @State private var credentialStoreUnreadable = false
    @State private var query = ""
    @State private var aliasCard: ConnectorCard?
    @State private var alias = ""
    @State private var loading = true
    @State private var refreshing = false

    private var cards: [ConnectorCard] {
        let values = catalog?.cards ?? []
        guard !query.isEmpty else { return values }
        return values.filter {
            $0.label.localizedCaseInsensitiveContains(query) ||
                $0.slug.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        List {
            if credentialStoreUnreadable {
                Section {
                    Label("Accounts could not be re-checked", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    if statuses == nil {
                        Text("Your computer could not open its credential store, so it cannot say which accounts are connected. Nothing has been disconnected — restarting OpenMausBot on your computer usually clears this.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Showing what was connected last time. Your computer could not open its credential store just now, so these could not be re-checked. Nothing has been disconnected — restarting OpenMausBot on your computer usually clears this.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Two notices about one fact is one too many, and only the banner
            // above is true during a failed read: `configured` comes from
            // `composio.configured(cfg)` (server/index.ts:4993), which an
            // unreadable store also drives to false, so "needs setup" would be
            // advice for someone who never set this up. Same rule the panel on
            // the computer applies — `!configured && !stale`.
            if catalog?.configured == false, !credentialStoreUnreadable {
                Section {
                    ContentUnavailableView(
                        "Connected apps need setup",
                        systemImage: "link.badge.plus",
                        description: Text("Configure Composio on your computer first. Provider credentials are never returned to this device.")
                    )
                }
            }

            ForEach(cards) { card in
                connectorSection(card)
            }
        }
        .navigationTitle("Connected Apps")
        .searchable(text: $query, prompt: "Search apps")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await refreshStatuses(showProgress: true) }
                }
                .disabled(refreshing)
            }
        }
        .overlay { if loading { ProgressView() } }
        .task { await load() }
        .refreshable { await refreshStatuses() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshStatuses() } }
        }
        .alert("Account alias", isPresented: Binding(
            get: { aliasCard != nil },
            set: { if !$0 { aliasCard = nil } }
        )) {
            TextField("Work, Personal, Client…", text: $alias)
                .textInputAutocapitalization(.words)
            Button("Cancel", role: .cancel) { aliasCard = nil }
            Button("Continue") {
                guard let card = aliasCard else { return }
                let value = String(alias.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
                aliasCard = nil
                Task { await authorize(card, alias: value) }
            }
            .disabled(alias.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("An alias makes the account explicit when an agent uses more than one \(aliasCard?.label ?? "app") account.")
        }
    }

    @ViewBuilder
    private func connectorSection(_ card: ConnectorCard) -> some View {
        let status = statuses?[card.slug]
        let accounts = status?.accounts ?? []
        let isConnected = status?.connected == true
        let isPending = status?.pending == true

        Section {
            if statuses == nil {
                // No inventory has ever been confirmed, so this app's state is
                // not known. "Connect" would assert that it is disconnected —
                // the one claim we are in no position to make.
                Label("Connection unknown", systemImage: "questionmark.circle")
                    .foregroundStyle(.secondary)
            } else if accounts.isEmpty, !isConnected, !isPending {
                Button("Connect \(card.label)", systemImage: "plus.circle") {
                    Task { await authorize(card, alias: nil) }
                }
                .disabled(catalog?.configured != true)
            } else if accounts.isEmpty {
                let statusLabel: LocalizedStringKey = isPending ? "Connecting…" : "Connected"
                let statusSymbol = isPending ? "clock" : "checkmark.circle.fill"
                Label(statusLabel, systemImage: statusSymbol)
                    .foregroundStyle(isPending ? Color.secondary : Color.green)
                Text("Account details are unavailable from this provider. Refresh after authorization finishes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(accounts) { account in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            account.nonemptyAlias.map { Text(verbatim: $0) } ?? Text("Primary account")
                            Text(account.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(account.id)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .textSelection(.enabled)
                        }
                        Spacer()
                        Image(systemName: account.isActive ? "checkmark.circle.fill" : "clock")
                            .foregroundStyle(account.isActive ? .green : .secondary)
                    }
                }

                Button("Add another account", systemImage: "person.crop.circle.badge.plus") {
                    alias = ""
                    aliasCard = card
                }
                .disabled(accounts.count >= 5)
            }
        } header: {
            HStack {
                Text(card.label)
                Spacer()
                if isPending { Text("Connecting…") }
            }
        } footer: {
            Text(card.blurb)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        catalog = await session.loadConnectorCatalog()
        await refreshStatuses()
    }

    private func refreshStatuses(showProgress: Bool = false) async {
        if showProgress { refreshing = true }
        defer { if showProgress { refreshing = false } }
        guard let response = await session.loadAllConnectorStatuses() else { return }
        credentialStoreUnreadable = !response.isAuthoritative
        // An unreadable credential store answers with an empty map that means
        // "we could not find out", not "nothing is connected". Replacing the
        // inventory with it would show live accounts as disconnected — and
        // this runs on every foregrounding, so one transient failure would be
        // enough. Keep the last answer we were sure about; when there is none
        // to keep, `statuses` stays nil and the view says so rather than
        // guessing on the user's behalf.
        guard response.isAuthoritative else { return }
        statuses = response.services
    }

    private func authorize(_ card: ConnectorCard, alias: String?) async {
        guard let url = await session.authorizeConnector(card.slug, alias: alias) else { return }
        guard await UIApplication.shared.open(url) else {
            session.actionError = "The authorization page could not be opened. Try again after checking your browser restrictions."
            return
        }
    }
}

private extension ConnectorAccount {
    var nonemptyAlias: String? {
        let value = alias?.trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }
}
