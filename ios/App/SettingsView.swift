// Settings stays status-first. Network details and destructive pairing
// controls live one level deeper so the everyday screen remains calm.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var enablingNotifications = false
    @AppStorage(PrefKey.activityDetail) private var activityDetail = ActivityDetail.full.rawValue
    @AppStorage(PrefKey.islandIntro) private var islandIntro = IslandIntro.oncePerBot.rawValue
    @AppStorage(PrefKey.language) private var language = AppLanguage.system.rawValue
    private let onConnect: (() -> Void)?

    init(onConnect: (() -> Void)? = nil) {
        self.onConnect = onConnect
    }

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    NavigationLink {
                        ConnectedComputersView()
                    } label: {
                        ComputerSettingsRow(
                            name: Text(verbatim: connection.name),
                            status: computerStatusText,
                            connected: session.status == .live
                        )
                    }
                } else {
                    Button {
                        onConnect?()
                    } label: {
                        ComputerSettingsRow(
                            name: Text("Connect a computer"),
                            status: Text("Not connected"),
                            connected: false
                        )
                    }
                    .disabled(onConnect == nil)
                }
            }

            Section {
                if notificationsAreEnabled {
                    notificationRow
                        .accessibilityHint(notificationAccessibilityHint)
                } else {
                    Button {
                        enablingNotifications = true
                        Task {
                            await session.enableNotifications()
                            enablingNotifications = false
                        }
                    } label: {
                        notificationRow
                    }
                    .disabled(enablingNotifications)
                    .accessibilityHint(notificationAccessibilityHint)
                }
            } footer: {
                Text("Alerts arrive while OpenMausBot is open or was recently in the background. Closed-app delivery is not available yet.")
            }

            Section {
                Picker(selection: $activityDetail) {
                    ForEach(ActivityDetail.allCases, id: \.rawValue) { level in
                        Text(LocalizedStringKey(level.label)).tag(level.rawValue)
                    }
                } label: {
                    Label {
                        Text("Activity")
                    } icon: {
                        SettingsIcon(symbol: "wrench.and.screwdriver.fill", color: .purple)
                    }
                }

                Picker(selection: $islandIntro) {
                    ForEach(IslandIntro.allCases, id: \.rawValue) { option in
                        Text(LocalizedStringKey(option.label)).tag(option.rawValue)
                    }
                } label: {
                    Label {
                        Text("Bot intro animation")
                    } icon: {
                        SettingsIcon(symbol: "sparkles", color: .pink)
                    }
                }

                NavigationLink {
                    QuickRepliesEditor()
                } label: {
                    Label {
                        Text("Quick Replies")
                    } icon: {
                        SettingsIcon(symbol: "bolt.fill", color: .yellow)
                    }
                }
            } header: {
                Text("Chat")
            } footer: {
                Text(LocalizedStringKey(ActivityDetail(rawValue: activityDetail)?.caption ?? ""))
            }

            Section {
                Picker(selection: $language) {
                    ForEach(AppLanguage.allCases) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                } label: {
                    Label {
                        Text("Language")
                    } icon: {
                        SettingsIcon(symbol: "globe", color: .teal)
                    }
                }
            } footer: {
                Text("Changes the language inside OpenMausMobile. Buttons drawn by iOS itself follow the phone's language, which you can set for this app in iOS Settings.")
            }

            if session.connection != nil {
                Section("Workspace") {
                    NavigationLink {
                        TasksRoutinesView()
                    } label: {
                        Label {
                            Text("Threads & Routines")
                        } icon: {
                            SettingsIcon(symbol: "calendar.badge.clock", color: .orange)
                        }
                    }

                    // Connecting apps needs the admin scope; a chat-only
                    // server session leaves it to the owner, in the server's UI.
                    if session.canAdminister {
                        NavigationLink {
                            ConnectedAppsView()
                        } label: {
                            Label {
                                Text("Connected Apps")
                            } icon: {
                                SettingsIcon(symbol: "link", color: .blue)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await session.refreshNotificationAuthorization() }
    }

    private var notificationsAreEnabled: Bool {
        switch session.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationAccessibilityHint: LocalizedStringKey {
        if notificationsAreEnabled { return "Notifications are enabled" }
        if session.notificationAuthorization == .denied { return "Opens device Settings" }
        return "Asks for permission to send notifications"
    }

    private var notificationRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "bell.fill", color: .red)
            Text("Notifications")
                .foregroundStyle(.primary)
            Spacer()
            if enablingNotifications {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(LocalizedStringKey(session.notificationStatusText))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var statusText: Text { session.status.settingsText }

    private var computerStatusText: Text {
        guard session.connections.count > 1 else { return statusText }
        return statusText + Text(verbatim: " · ") + Text("\(session.connections.count) saved")
    }
}

private struct ComputerSettingsRow: View {
    let name: Text
    let status: Text
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                name
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    status
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ConnectedComputersView: View {
    @EnvironmentObject private var session: Session
    @State private var pendingRemoval: Connection?

    /// The dialog interpolates the computer's own name. With no name there is
    /// copy to fall back to, rather than an English word inside a translated
    /// sentence.
    private var removalTitle: LocalizedStringKey {
        guard let name = pendingRemoval?.name else { return "Remove this computer?" }
        return "Remove \(name)?"
    }

    private var otherComputers: [Connection] {
        session.connections.filter { $0.id != session.connection?.id }
    }

    var body: some View {
        List {
            if let active = session.connection {
                Section("Current computer") {
                    NavigationLink {
                        ConnectionSecurityView()
                    } label: {
                        ComputerSettingsRow(
                            name: Text(verbatim: active.name),
                            status: session.status.settingsText,
                            connected: session.status == .live
                        )
                    }
                }
            }

            if !otherComputers.isEmpty {
                Section("Other computers") {
                    ForEach(otherComputers) { computer in
                        Button {
                            Haptics.selection()
                            session.switchComputer(to: computer.id)
                        } label: {
                            HStack(spacing: 12) {
                                ProfileAvatar(name: computer.name, size: 38)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(computer.name)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text("Tap to switch")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("Use")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(MausPalette.color("blue"))
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Remove", role: .destructive) {
                                pendingRemoval = computer
                            }
                        }
                        .accessibilityHint("Switches OpenMausMobile to this computer")
                    }
                }
            }

            Section {
                Button {
                    Haptics.selection()
                    session.beginPairing()
                } label: {
                    Label("Connect another computer", systemImage: "plus.circle.fill")
                }
            } footer: {
                Text("Each computer is paired separately. Only the selected computer is active at a time.")
            }
        }
        .navigationTitle("Computers")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            removalTitle,
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove from this device", role: .destructive) {
                guard let pendingRemoval else { return }
                session.forgetConnection(id: pendingRemoval.id)
                self.pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: {
            Text("This removes the saved connection from this device only.")
        }
    }
}

struct ConnectionSecurityView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var addressText = ""
    @State private var showingFullAddress = false
    @State private var copiedAddress = false
    @State private var refreshing = false

    var body: some View {
        Form {
            if let connection = session.connection {
                Section {
                    HStack(spacing: 14) {
                        ProfileAvatar(name: connection.name, size: 46)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name)
                                .font(.headline)
                            Label {
                                session.status.settingsText
                            } icon: {
                                Image(systemName: session.status == .live ? "checkmark.circle.fill" : "circle.dotted")
                            }
                                .font(.subheadline)
                                .foregroundStyle(session.status == .live ? Color.green : Color.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
                    DisclosureGroup("Connection details") {
                        VStack(alignment: .leading, spacing: 12) {
                            Group {
                                if showingFullAddress {
                                    Text(connection.displayAddress)
                                        .textSelection(.enabled)
                                } else {
                                    Text(shortened(connection.displayAddress))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)

                            HStack(spacing: 16) {
                                Button(showingFullAddress ? "Hide full address" : "Show full address") {
                                    showingFullAddress.toggle()
                                }
                                Button(copiedAddress ? "Copied" : "Copy") {
                                    UIPasteboard.general.string = connection.displayAddress
                                    copiedAddress = true
                                    Task {
                                        try? await Task.sleep(for: .seconds(2))
                                        copiedAddress = false
                                    }
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .padding(.top, 10)
                    }

                    Button("Edit address") {
                        addressText = connection.displayAddress
                        editingAddress = true
                    }
                }

                Section("Troubleshooting") {
                    troubleshootingText
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button {
                        refreshing = true
                        Task {
                            await session.refresh()
                            refreshing = false
                        }
                    } label: {
                        HStack {
                            Text("Try reconnecting")
                            if refreshing {
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(refreshing)
                }

                Section {
                    Button("Remove connection from this device", role: .destructive) {
                        confirmingSignOut = true
                    }
                }
            } else {
                ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
            }
        }
        .navigationTitle("Connection & Security")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Edit address", isPresented: $editingAddress) {
            TextField("Computer address", text: $addressText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                if !session.updateAddress(addressText) {
                    session.actionError = "That address doesn't look right. Copy it from Phone settings and try again."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Use the address shown in Phone settings on your computer. Your pairing is kept.")
        }
        .confirmationDialog(
            "Remove this connection?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Remove from this device", role: .destructive) {
                session.signOut()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the connection from this device only. It does not revoke this device on your Mac. To remove Mac-side access, open OpenMausBot → Settings → Phone and remove it there.")
        }
    }

    /// Our copy, except for `.offline`, whose text the computer itself sent and
    /// which is shown exactly as it arrived.
    private var troubleshootingText: Text {
        switch session.status {
        case .live:
            return Text("This computer is connected and responding normally.")
        case .connecting:
            return Text("OpenMausBot is trying the saved connection automatically.")
        case let .offline(reason):
            return Text(verbatim: reason)
        case .unauthorized:
            return Text("This device was removed from the computer. Pair it again to reconnect.")
        case .unpaired:
            return Text("This device is not paired with a computer.")
        }
    }

    private func shortened(_ address: String) -> String {
        guard address.count > 14 else { return address }
        let leadingCount = min(20, max(8, address.count - 8))
        return "\(address.prefix(leadingCount))…\(address.suffix(6))"
    }
}

private extension Session.Status {
    var settingsText: Text {
        switch self {
        case .live: return Text("Connected")
        case .connecting: return Text("Connecting…")
        case .unpaired: return Text("Not paired")
        case .unauthorized: return Text("Needs pairing")
        case .offline: return Text("Offline")
        }
    }
}
