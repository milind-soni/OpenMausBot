// App entry, and the one place that decides when the event stream lives.
//
// A phone is not a desktop: the stream is torn down the moment the app
// leaves the screen, because iOS is going to kill it anyway and doing it
// deliberately means the cursor is written down at a known point. Coming
// back asks the harness what was missed rather than asking for everything.
import SwiftUI

@main
struct CompanionApp: App {
    @StateObject private var session = Session()
    @Environment(\.scenePhase) private var scenePhase
    @State private var liveActivities = LiveActivityCoordinator()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onAppear {
                    session.connect()
                    liveActivities.attach(to: session)
                }
                .onOpenURL { session.receivePairingURL($0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        session.connect()
                        Task { await session.refreshNotificationAuthorization() }
                    case .background: session.linger()
                    case .inactive: break
                    @unknown default: break
                    }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Group {
            switch session.status {
            case .unpaired:
                PairingView()
            case .unauthorized:
                UnpairedView()
            default:
                ChatListView()
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { session.actionError != nil },
                set: { if !$0 { session.actionError = nil } }
            ),
            presenting: session.actionError
        ) { _ in
            Button("OK", role: .cancel) { session.actionError = nil }
        } message: { message in
            Text(message)
        }
    }
}

/// The token stopped working. Almost always because someone revoked this
/// phone on the computer — which is exactly what that button is for, so the
/// honest thing is to say so and offer to pair again.
struct UnpairedView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ContentUnavailableView {
            Label("This phone was unpaired", systemImage: "lock.slash")
        } description: {
            Text("It was removed from the computer's companion settings, or the pairing was reset.")
        } actions: {
            Button("Pair again") { session.signOut() }
                .buttonStyle(.borderedProminent)
        }
    }
}
