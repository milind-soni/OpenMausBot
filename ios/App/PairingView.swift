// Pairing: make QR scanning the obvious path, then keep discovery and manual
// entry available without making network plumbing part of onboarding.
import SwiftUI
import CompanionCore
#if canImport(UIKit)
import UIKit
#endif

struct PairingView: View {
    @EnvironmentObject private var session: Session
    @StateObject private var discovery = Discovery()

    @State private var manualAddress = ""
    @State private var code = ""
    @State private var scannedCredential: String?
    /// Stable across Retry. If the Mac committed a device but the response
    /// was lost, repeating this same logical request recovers its token.
    @State private var pairRequestId: String?
    @State private var chosen: Connection?
    @State private var submission = CompanionPairingSubmissionState()
    @State private var failure: String?
    @State private var showingScanner = false
    @State private var showingOtherWays = false
    @State private var showingManualInput = false
    @State private var choiceGeneration = 0

    private let onCancel: () -> Void

    init(onCancel: @escaping () -> Void = {}) {
        self.onCancel = onCancel
    }

    private var pairing: Bool { submission.isInFlight }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    if let chosen {
                        confirmationView(for: chosen)
                    } else {
                        pairingHero
                        qrAction
                        otherWays
                    }

                    if let failure {
                        errorBanner(failure)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("Connect computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now", action: onCancel)
                        .disabled(!submission.allowsNavigation)
                }
            }
            .onAppear {
                accept(session.pairingInvite)
            }
            .onDisappear {
                choiceGeneration += 1
                discovery.stop()
            }
            .onChange(of: session.pairingInvite) { _, invite in accept(invite) }
            .onChange(of: showingOtherWays) { _, isShowing in
                if isShowing {
                    discovery.start()
                } else {
                    discovery.stop()
                }
            }
            .fullScreenCover(isPresented: $showingScanner) {
                PairingScannerSheet { payload in
                    guard let url = URL(string: payload), let invite = PairingInvite.parse(url) else {
                        return "That isn't an OpenMausBot pairing QR code."
                    }
                    accept(invite)
                    return nil
                }
            }
            .interactiveDismissDisabled(pairing)
        }
    }

    private var pairingHero: some View {
        VStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.12))
                    .frame(width: 124, height: 124)
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 46, weight: .medium))
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text("Connect to your computer")
                    .font(.title.bold())
                    .multilineTextAlignment(.center)
                Text("Scan the QR code in OpenMausBot. We'll securely choose the best way to connect.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var qrAction: some View {
        VStack(spacing: 12) {
            Button {
                Haptics.selection()
                failure = nil
                showingScanner = true
            } label: {
                Label("Scan QR code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Text("On your computer, open Settings → Phone → Set up a phone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var otherWays: some View {
        VStack(alignment: .leading, spacing: 0) {
            DisclosureGroup(isExpanded: $showingOtherWays) {
                VStack(alignment: .leading, spacing: 18) {
                    discoveredComputers

                    Divider()

                    DisclosureGroup(isExpanded: $showingManualInput) {
                        manualEntry
                            .padding(.top, 12)
                    } label: {
                        Label("Enter address and code", systemImage: "keyboard")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .padding(.top, 18)
            } label: {
                Text("Other ways to connect")
                    .font(.headline)
            }
        }
        .padding(18)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    @ViewBuilder
    private var discoveredComputers: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Nearby computers", systemImage: "desktopcomputer")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if discovery.browsing && discovery.found.isEmpty {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Looking for computers")
                }
            }

            if let discoveryFailure = discovery.failure {
                Text(discoveryFailure)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if discovery.found.isEmpty {
                Text("Computers ready to pair will appear here.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(discovery.found) { service in
                    Button {
                        Haptics.selection()
                        Task { await choose(service) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "laptopcomputer")
                                .foregroundStyle(MausPalette.color("blue"))
                                .frame(width: 30, height: 30)
                            Text(service.name)
                                .font(.body.weight(.medium))
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Enter the code shown on this computer")
                }
            }
        }
    }

    private var manualEntry: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Computer address", text: $manualAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textContentType(.URL)
                .padding(12)
                .background(Color(uiColor: .tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("Use the address shown in Phone settings on your computer.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Button("Continue") {
                Haptics.selection()
                failure = nil
                // The whole link a server printed (https://host/pair#code=…) is
                // fine here too: it names both the address and the code.
                if let url = URL(string: manualAddress.trimmingCharacters(in: .whitespacesAndNewlines)),
                   let invite = PairingInvite.parse(url) {
                    accept(invite)
                    return
                }
                guard let connection = Self.parse(manualAddress) else {
                    failure = "That address doesn't look right. Copy it from Phone settings and try again."
                    return
                }
                choiceGeneration += 1
                scannedCredential = nil
                pairRequestId = nil
                chosen = connection
            }
            .buttonStyle(.bordered)
            .disabled(manualAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    @ViewBuilder
    private func confirmationView(for connection: Connection) -> some View {
        let badge = connectionBadge(for: connection)
        VStack(spacing: 22) {
            ZStack {
                Circle()
                    .fill(MausPalette.color("green").opacity(0.12))
                    .frame(width: 92, height: 92)
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(MausPalette.color("green"))
            }
            .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text(connection.name)
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Label(badge.title, systemImage: badge.systemImage)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(MausPalette.color("green"))
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Computer address")
                    .font(.subheadline.weight(.semibold))
                Text(connection.pairingConsentOrigin)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Make sure this is the computer you expect before connecting.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color(uiColor: .tertiarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .accessibilityElement(children: .combine)

            if let credential = scannedCredential {
                if !connectionIsProtected(connection) {
                    Text("Only continue on a network you trust. Local connections are authenticated but are not encrypted by OpenMausBot.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button {
                    Haptics.selection()
                    beginSubmission(connection, credential: credential)
                } label: {
                    HStack {
                        if pairing { ProgressView().tint(.white) }
                        Text(pairing ? "Connecting…" : "Connect")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(pairing)
            } else {
                VStack(spacing: 12) {
                    Text("Enter the 6-digit code shown on your computer")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    TextField("000000", text: $code)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .textContentType(.oneTimeCode)
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 12)
                        .background(Color(uiColor: .tertiarySystemGroupedBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .onChange(of: code) { _, value in
                            // six digits for a computer, ABCD-EFGH-JKLM for a server
                            code = String(value.uppercased().filter { $0.isASCII && ($0.isNumber || $0.isLetter || $0 == "-") }.prefix(14))
                        }

                    Button {
                        Haptics.selection()
                        beginSubmission(connection, credential: code)
                    } label: {
                        HStack {
                            if pairing { ProgressView().tint(.white) }
                            Text(pairing ? "Connecting…" : "Connect")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!Self.codeLooksComplete(code) || pairing)
                }
            }

            Button("Choose a different computer") {
                Haptics.selection()
                chosen = nil
                code = ""
                scannedCredential = nil
                pairRequestId = nil
                failure = nil
            }
            .foregroundStyle(.secondary)
            .disabled(!submission.allowsNavigation)
        }
        .padding(22)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func errorBanner(_ message: String) -> some View {
        Label {
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.footnote)
        .foregroundStyle(.red)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @MainActor
    private func choose(_ service: Discovery.Found) async {
        choiceGeneration += 1
        let generation = choiceGeneration
        failure = nil
        pairRequestId = nil
        do {
            let resolved = try await discovery.resolve(service)
            guard generation == choiceGeneration else { return }
            chosen = resolved
        } catch {
            guard generation == choiceGeneration else { return }
            failure = error.localizedDescription
        }
    }

    @MainActor
    private func beginSubmission(_ connection: Connection, credential: String) {
        guard submission.begin() else { return }
        Task { await submit(connection, credential: credential) }
    }

    @MainActor
    private func submit(_ connection: Connection, credential: String) async {
        failure = nil
        var succeeded = false
        defer {
            submission.finish()
            // A deep link received during the commit cannot replace the
            // consent screen. If this request failed, present it only after
            // the in-flight request has fully settled.
            if succeeded {
                session.consumePairingInvite()
                onCancel()
            } else {
                accept(session.pairingInvite)
            }
        }
        let cameFromScanner = scannedCredential != nil
        let requestId = pairRequestId ?? UUID().uuidString
        pairRequestId = requestId
        do {
            try await session.pair(
                with: connection,
                credential: credential,
                deviceName: Self.deviceName(),
                pairRequestId: requestId
            )
            pairRequestId = nil
            succeeded = true
        } catch {
            if cameFromScanner {
                if error is PairingRouteError {
                    failure = error.localizedDescription
                } else {
                    failure = "\(error.localizedDescription) Start pairing again on your computer and rescan the new QR code."
                    chosen = nil
                    scannedCredential = nil
                    pairRequestId = nil
                }
            } else {
                failure = error.localizedDescription
                if !(error is PairingRouteError) {
                    code = ""
                    pairRequestId = nil
                }
            }
        }
    }

    /// A companion's six digits, or a server's twelve characters.
    static func codeLooksComplete(_ code: String) -> Bool {
        (code.count == 6 && code.allSatisfy(\.isNumber)) || PairingInvite.normalizedServerCode(code) != nil
    }

    private func accept(_ invite: PairingInvite?) {
        guard submission.allowsNavigation, let invite else { return }
        choiceGeneration += 1
        chosen = invite.connection
        scannedCredential = invite.credential
        pairRequestId = UUID().uuidString
        code = ""
        failure = nil
        session.consumePairingInvite()
    }

    private func connectionIsProtected(_ connection: Connection) -> Bool {
        connection.activeEndpoint?.protectsCredentials
            ?? connection.automaticEndpoints.first?.protectsCredentials
            ?? false
    }

    private func connectionBadge(for connection: Connection) -> (title: String, systemImage: String) {
        let kind = connection.activeEndpoint?.kind ?? connection.automaticEndpoints.first?.kind
        if kind == .hosted {
            return ("HTTPS connection", "lock.shield.fill")
        }
        if kind == .tailnet {
            return ("Tailscale connection", "lock.shield.fill")
        }
        return ("Trusted local connection", "checkmark.shield.fill")
    }

    static func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return "Companion"
        #endif
    }

    static func parse(_ text: String) -> Connection? {
        Connection.parse(text)
    }
}
