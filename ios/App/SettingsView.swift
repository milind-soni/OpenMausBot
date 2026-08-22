// Paired-device settings and safe workspace feature entry points.
//
// Credentials, revocation, Local VM and execution policy still live only on
// the computer. The phone can manage renderer-neutral routines without
// widening that boundary.
import SwiftUI
import CompanionCore

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var addressText = ""

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    LabeledContent("Name", value: connection.name)
                    LabeledContent("Address", value: "\(connection.host):\(connection.port)")
                    // The stored address can simply go stale — a tailnet name
                    // on a phone that left the tailnet, a LAN address after
                    // the router reshuffled. Editing it here keeps the
                    // pairing; the alternative is a walk to the computer for
                    // a new code.
                    Button("Edit address") {
                        addressText = "\(connection.host):\(connection.port)"
                        editingAddress = true
                    }
                }
                LabeledContent("Connection", value: statusText)
            }

            Section {
                LabeledContent("Status", value: session.notificationStatusText)
                Button(session.notificationAuthorization == .denied ? "Open iPhone Settings" : "Enable notifications") {
                    Task { await session.enableNotifications() }
                }
                .disabled(session.notificationAuthorization == .authorized)
            } header: {
                Text("Notifications")
            } footer: {
                Text("Approvals and finished work appear while OpenMausMobile is connected, including frames replayed after a short background pause. Closed-app push needs the separate APNs relay release.")
            }

            Section {
                NavigationLink {
                    TasksRoutinesView()
                } label: {
                    Label("Tasks & Routines", systemImage: "calendar.badge.clock")
                }
            } header: {
                Text("Workspace")
            } footer: {
                Text("Routine schedules are safe to manage here. Provider keys, webhook secrets, pairing, revocation, Local VM, and agent execution policy stay on your computer.")
            }

            Section {
                Button("Unpair this phone", role: .destructive) { confirmingSignOut = true }
            } footer: {
                Text("Removes the pairing from this phone only. To stop it reaching the computer at all, remove the device in OpenMausBot → Settings → Companion.")
            }

            Section("Not here") {
                Text("API keys, pairing and the Local VM are managed on the computer. This phone is deliberately not allowed to change them.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task { await session.refreshNotificationAuthorization() }
        .alert("Edit address", isPresented: $editingAddress) {
            TextField("192.168.1.42:8810", text: $addressText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                if !session.updateAddress(addressText) {
                    session.actionError = "That should look like 192.168.1.42:8810, or a name like macbook.tail1234.ts.net."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Enter whatever the Companion panel on your computer shows. The pairing itself is kept.")
        }
        .confirmationDialog(
            "Unpair this phone?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Unpair", role: .destructive) { session.signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need a new pairing code to connect again.")
        }
    }

    private var statusText: String {
        switch session.status {
        case .live: return "Connected"
        case .connecting: return "Connecting…"
        case .unpaired: return "Not paired"
        case .unauthorized: return "Unpaired on the computer"
        case let .offline(reason): return reason
        }
    }
}
