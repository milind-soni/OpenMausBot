// Pairing: scan the computer's QR, confirm its identity, and connect.
//
// Two ways in, because discovery is allowed to fail. Bonjour finds the
// computer by name when the network cooperates; when it does not — a guest
// network with multicast off, a responder that could not take port 5353 —
// the address the desktop panel prints is typed instead. Neither path is a
// fallback bolted on: the desktop panel changes its own wording to match.
import SwiftUI
import CompanionCore
#if canImport(UIKit)
import UIKit
#endif

struct PairingView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var discovery = Discovery()

    @State private var manualAddress = ""
    @State private var code = ""
    @State private var scannedCredential: String?
    @State private var chosen: Connection?
    @State private var pairing = false
    @State private var failure: String?
    @State private var showingScanner = false
    @State private var showManualInput = false
    /// "Looking…" forever is not an answer. After a few seconds with nothing
    /// found, say the thing that is almost always true.
    @State private var searchedLongEnough = false
    @State private var choiceGeneration = 0

    // Radar pulse animation states
    @State private var radarPulse = false

    private let accentTint = Color(hex: "#38BDF8")

    var body: some View {
        NavigationStack {
            ZStack {
                backgroundColor
                    .ignoresSafeArea()

                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 20) {
                        if let chosen {
                            confirmationView(for: chosen)
                        } else {
                            // 1. Radar Discovery Hero
                            radarHeroSection

                            // 2. Discovered Computers
                            discoveredHostsSection

                            // 3. QR Scan Action CTA
                            qrActionSection

                            // 4. Manual IP Input Accordion
                            manualEntrySection
                        }

                        if let failure {
                            errorBanner(failure)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                }
            }
            .navigationTitle("Pair Companion")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .onAppear {
                discovery.start()
                accept(session.pairingInvite)
                if !reduceMotion {
                    withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: false)) {
                        radarPulse = true
                    }
                }
            }
            .onDisappear {
                choiceGeneration += 1
                discovery.stop()
            }
            .onChange(of: session.pairingInvite) { _, invite in accept(invite) }
            .fullScreenCover(isPresented: $showingScanner) {
                PairingScannerSheet { payload in
                    guard let url = URL(string: payload), let invite = PairingInvite.parse(url) else {
                        return "That isn't an OpenMausBot pairing QR code."
                    }
                    accept(invite)
                    return nil
                }
            }
            .task {
                searchedLongEnough = false
                do {
                    try await Task.sleep(nanoseconds: 7_000_000_000)
                    try Task.checkCancellation()
                    searchedLongEnough = true
                } catch is CancellationError {
                    return
                } catch {
                    return
                }
            }
        }
    }

    private var isDark: Bool {
        colorScheme == .dark
    }

    private var backgroundColor: Color {
        isDark ? Color(hex: "#0B0F19") : Color(hex: "#F8FAFC")
    }

    private var cardBackground: Color {
        isDark ? Color(hex: "#131C2E") : Color.white
    }

    private var cardBorder: Color {
        isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06)
    }

    // MARK: - 1. Radar Hero Section

    private var radarHeroSection: some View {
        VStack(spacing: 14) {
            ZStack {
                // Radar orbital rings
                Circle()
                    .stroke(accentTint.opacity(0.12), lineWidth: 1.5)
                    .frame(width: 140, height: 140)

                Circle()
                    .stroke(accentTint.opacity(radarPulse ? 0.0 : 0.4), lineWidth: 1.5)
                    .frame(width: radarPulse ? 130 : 50, height: radarPulse ? 130 : 50)
                    .scaleEffect(radarPulse ? 1.0 : 0.4)

                Circle()
                    .stroke(accentTint.opacity(0.25), lineWidth: 1)
                    .frame(width: 90, height: 90)

                // Center Beacon & Avatar
                ZStack {
                    Circle()
                        .fill(accentTint.opacity(0.16))
                        .frame(width: 58, height: 58)

                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(accentTint)
                }
                .shadow(color: accentTint.opacity(0.3), radius: 10, y: 2)
            }
            .frame(height: 120)
            .padding(.top, 8)

            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(discovery.failure == nil ? accentTint : Color(hex: "#EF4444"))
                        .frame(width: 7, height: 7)
                    Text("LOCAL NETWORK RADAR")
                        .font(.system(size: 11, weight: .heavy, design: .monospaced))
                        .foregroundColor(isDark ? accentTint : Color(hex: "#0369A1"))
                }

                Text(discoveryStatus)
                    .font(.headline)
                    .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))

                Text("Ensure your phone and computer share the same Wi-Fi network.")
                    .font(.caption)
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(cardBorder, lineWidth: 1)
        )
    }

    // MARK: - 2. Discovered Hosts List

    @ViewBuilder
    private var discoveredHostsSection: some View {
        if let discoveryFailure = discovery.failure {
            errorBanner(discoveryFailure)
        } else if !discovery.found.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("DISCOVERED COMPUTERS")
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .padding(.horizontal, 4)

                VStack(spacing: 8) {
                    ForEach(discovery.found) { service in
                        Button {
                            Haptics.selection()
                            Task { await choose(service) }
                        } label: {
                            HStack(spacing: 12) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(accentTint.opacity(0.12))
                                        .frame(width: 40, height: 40)
                                    Image(systemName: "laptopcomputer")
                                        .font(.system(size: 18, weight: .semibold))
                                        .foregroundColor(accentTint)
                                }

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(service.name)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                                    Text("Ready for pairing")
                                        .font(.caption2)
                                        .foregroundColor(Color(hex: "#10B981"))
                                }

                                Spacer()

                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(isDark ? Color(hex: "#475569") : Color(hex: "#94A3B8"))
                            }
                            .padding(12)
                            .background(cardBackground)
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .stroke(cardBorder, lineWidth: 0.8)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        } else if searchedLongEnough {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(Color(hex: "#F59E0B"))
                    Text("Can't find your computer?")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                }
                Text("Guest networks and some router isolation settings block devices from seeing each other. Use the QR scanner below or enter your computer's address directly.")
                    .font(.caption)
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .lineSpacing(2)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(hex: "#F59E0B").opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(hex: "#F59E0B").opacity(0.2), lineWidth: 0.8)
            )
        }
    }

    // MARK: - 3. QR Scan CTA Section

    private var qrActionSection: some View {
        VStack(spacing: 8) {
            Button {
                Haptics.selection()
                failure = nil
                showingScanner = true
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 18, weight: .bold))
                    Text("Scan Pairing QR Code")
                        .font(.system(size: 15, weight: .bold))
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(
                    LinearGradient(
                        colors: [Color(hex: "#0284C7"), Color(hex: "#0EA5E9")],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .shadow(color: Color(hex: "#0284C7").opacity(0.35), radius: 8, y: 3)
            }
            .buttonStyle(.plain)

            Text("In OpenMausBot, open Settings → Companion → Set up a phone to view your QR code.")
                .font(.caption2)
                .foregroundColor(isDark ? Color(hex: "#64748B") : Color(hex: "#94A3B8"))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
        }
    }

    // MARK: - 4. Manual Entry Section

    private var manualEntrySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                    showManualInput.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: "network")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    Text("Direct Host Address")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    Spacer()
                    Image(systemName: showManualInput ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(isDark ? Color(hex: "#64748B") : Color(hex: "#94A3B8"))
                }
                .padding(.horizontal, 4)
            }
            .buttonStyle(.plain)

            if showManualInput {
                VStack(spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "link")
                            .font(.system(size: 14))
                            .foregroundColor(isDark ? Color(hex: "#64748B") : Color(hex: "#94A3B8"))

                        TextField("192.168.1.42:8810 or mac.ts.net:8810", text: $manualAddress)
                            .font(.system(size: 14, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    .padding(12)
                    .background(isDark ? Color(hex: "#090D16") : Color(hex: "#F1F5F9"))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(cardBorder, lineWidth: 0.8)
                    )

                    Button {
                        Haptics.selection()
                        failure = nil
                        guard let connection = Self.parse(manualAddress) else {
                            failure = "That should look like 192.168.1.42:8810 or host.ts.net:8810."
                            return
                        }
                        choiceGeneration += 1
                        scannedCredential = nil
                        chosen = connection
                    } label: {
                        Text("Connect to Address")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(accentTint)
                            .frame(maxWidth: .infinity)
                            .frame(height: 42)
                            .background(accentTint.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(manualAddress.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(12)
                .background(cardBackground)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(cardBorder, lineWidth: 1)
                )
            }
        }
    }

    // MARK: - 5. Confirmation View

    @ViewBuilder
    private func confirmationView(for connection: Connection) -> some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(Color(hex: "#10B981").opacity(0.15))
                    .frame(width: 72, height: 72)
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundColor(Color(hex: "#10B981"))
            }
            .padding(.top, 10)

            VStack(spacing: 4) {
                Text(connection.name)
                    .font(.title2.weight(.bold))
                    .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                Text("\(connection.host):\(connection.port)")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
            }

            if let credential = scannedCredential {
                Text("Confirm this computer to establish an authenticated companion connection. Use a trusted Wi-Fi network or a tailnet; OpenMausBot does not encrypt local Wi-Fi traffic.")
                    .font(.caption)
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)

                Button {
                    Haptics.selection()
                    Task { await submit(connection, credential: credential) }
                } label: {
                    HStack(spacing: 8) {
                        if pairing {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: "link.badge.plus")
                            Text("Pair with this Computer")
                        }
                    }
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Color(hex: "#10B981"))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .shadow(color: Color(hex: "#10B981").opacity(0.35), radius: 8, y: 3)
                }
                .buttonStyle(.plain)
                .disabled(pairing)
            } else {
                VStack(spacing: 12) {
                    Text("Enter the 6-digit code shown on your desktop:")
                        .font(.caption)
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))

                    TextField("000000", text: $code)
                        .keyboardType(.numberPad)
                        .font(.system(size: 28, weight: .bold, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 8)
                        .background(isDark ? Color(hex: "#090D16") : Color(hex: "#F1F5F9"))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(accentTint.opacity(0.4), lineWidth: 1)
                        )
                        .onChange(of: code) { _, value in
                            code = String(value.filter { $0.isASCII && $0.isNumber }.prefix(6))
                        }

                    Button {
                        Haptics.selection()
                        Task { await submit(connection, credential: code) }
                    } label: {
                        HStack(spacing: 8) {
                            if pairing {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Text("Connect")
                            }
                        }
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(code.count == 6 ? accentTint : Color.gray.opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(code.count != 6 || pairing)
                }
            }

            Button("Choose a different computer") {
                Haptics.selection()
                chosen = nil
                code = ""
                scannedCredential = nil
                failure = nil
            }
            .font(.caption.weight(.semibold))
            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
            .padding(.top, 4)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(cardBorder, lineWidth: 1)
        )
    }

    // MARK: - Error Banner

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(Color(hex: "#EF4444"))
            Text(message)
                .font(.caption)
                .foregroundColor(isDark ? Color(hex: "#F87171") : Color(hex: "#B91C1C"))
                .multilineTextAlignment(.leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: "#EF4444").opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(hex: "#EF4444").opacity(0.2), lineWidth: 0.8)
        )
    }

    @MainActor
    private func choose(_ service: Discovery.Found) async {
        choiceGeneration += 1
        let generation = choiceGeneration
        failure = nil
        do {
            let resolved = try await discovery.resolve(service)
            guard generation == choiceGeneration else { return }
            chosen = resolved
        } catch {
            guard generation == choiceGeneration else { return }
            failure = error.localizedDescription
        }
    }

    private func submit(_ connection: Connection, credential: String) async {
        pairing = true
        failure = nil
        defer { pairing = false }
        let cameFromScanner = scannedCredential != nil
        do {
            try await session.pair(
                with: connection,
                credential: credential,
                deviceName: Self.deviceName()
            )
        } catch {
            if cameFromScanner {
                failure = "\(error.localizedDescription) Start pairing again on your computer and rescan the new QR code."
                chosen = nil
                scannedCredential = nil
            } else {
                failure = error.localizedDescription
                code = ""
            }
        }
    }

    private func accept(_ invite: PairingInvite?) {
        guard let invite else { return }
        choiceGeneration += 1
        chosen = invite.connection
        scannedCredential = invite.credential
        code = ""
        failure = nil
        session.consumePairingInvite()
    }

    // MARK: - Helpers

    private var discoveryStatus: String {
        if discovery.failure != nil {
            return "Local discovery needs attention"
        }
        if discovery.found.isEmpty {
            return discovery.browsing ? "Searching for OpenMausBot hosts…" : "Starting local discovery…"
        }
        return "Found \(discovery.found.count) available host\(discovery.found.count == 1 ? "" : "s")"
    }

    static func deviceName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return "Companion"
        #endif
    }

    /// "192.168.1.42:8810", or a bare host on the default companion port.
    static func parse(_ text: String) -> Connection? {
        Connection.parse(text)
    }
}
