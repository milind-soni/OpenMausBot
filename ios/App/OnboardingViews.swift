import SwiftUI

struct CompanionWelcomeView: View {
    let onConnect: () -> Void
    let onSkip: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer(minLength: 28)

                ZStack {
                    RoundedRectangle(cornerRadius: 32, style: .continuous)
                        .fill(MausPalette.color("blue").opacity(0.12))
                        .frame(width: 148, height: 148)
                    MausAvatar(color: "blue", size: 108, state: .happy, animated: false)
                        .accessibilityHidden(true)
                }

                VStack(spacing: 12) {
                    Text("Take your bots with you")
                        .font(.largeTitle.bold())
                        .multilineTextAlignment(.center)
                    Text("Open chats, approve actions, and send new work from this device.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                VStack(spacing: 18) {
                    WelcomeBenefit(
                        icon: "bubble.left.and.bubble.right.fill",
                        title: "Your chats, in your pocket",
                        detail: "Pick up the same conversations from your computer."
                    )
                    WelcomeBenefit(
                        icon: "checkmark.circle.fill",
                        title: "Respond when a bot needs you",
                        detail: "Review approvals without going back to your desk."
                    )
                    WelcomeBenefit(
                        icon: "lock.shield.fill",
                        title: "Private by design",
                        detail: "You choose which trusted computer this device connects to."
                    )
                }
                .padding(.top, 4)

                Spacer(minLength: 10)
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background {
            LinearGradient(
                colors: [MausPalette.color("blue").opacity(0.10), Color.clear],
                startPoint: .top,
                endPoint: .center
            )
            .ignoresSafeArea()
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                Button(action: onConnect) {
                    Text("Connect my computer")
                        .frame(maxWidth: .infinity)
                }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                Button("Not now", action: onSkip)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .padding(.horizontal, 24)
            .padding(.top, 14)
            .padding(.bottom, 8)
            .background(.ultraThinMaterial)
        }
    }
}

private struct WelcomeBenefit: View {
    let icon: String
    let title: LocalizedStringKey
    let detail: LocalizedStringKey

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(MausPalette.color("blue"))
                .frame(width: 30, height: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

struct UnpairedHomeView: View {
    let onConnect: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: 72)

                    ZStack {
                        Circle()
                            .fill(MausPalette.color("blue").opacity(0.12))
                            .frame(width: 112, height: 112)
                        Image(systemName: "laptopcomputer.and.iphone")
                            .font(.system(size: 42, weight: .medium))
                            .foregroundStyle(MausPalette.color("blue"))
                    }
                    .accessibilityHidden(true)

                    VStack(spacing: 8) {
                        Text("Connect when you're ready")
                            .font(.title2.bold())
                        Text("Pair this device with OpenMausBot to see your chats and respond to your bots.")
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Text("On your computer, open OpenMausBot → Settings → Phone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Spacer(minLength: 30)
                }
                .padding(28)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: onConnect) {
                    Text("Connect computer")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding(.horizontal, 24)
                .padding(.vertical, 14)
                .background(.ultraThinMaterial)
            }
            .navigationTitle("OpenMausBot")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView(onConnect: onConnect)
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
    }
}

struct NotificationOnboardingView: View {
    @EnvironmentObject private var session: Session
    @State private var enabling = false
    let onContinue: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Spacer(minLength: 36)

                ZStack {
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .fill(MausPalette.color("green").opacity(0.12))
                        .frame(width: 132, height: 132)
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 48, weight: .medium))
                        .foregroundStyle(MausPalette.color("green"))
                }
                .accessibilityHidden(true)

                VStack(spacing: 10) {
                    Text("Stay in the loop")
                        .font(.largeTitle.bold())
                    Text("Get alerts while OpenMausBot is open or was recently in the background. Alerts stop after iOS fully suspends or closes the app.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 18)

                VStack(alignment: .leading, spacing: 14) {
                    Label("Approvals that are waiting for you", systemImage: "checkmark.circle")
                    Label("Finished work and important updates", systemImage: "sparkles")
                }
                .font(.headline)
                .padding(.top, 18)

                Spacer(minLength: 24)
            }
            .padding(28)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                Button {
                    enabling = true
                    Task {
                        await session.enableNotifications()
                        enabling = false
                        onContinue()
                    }
                } label: {
                    HStack {
                        if enabling { ProgressView().tint(.white) }
                        Text("Enable notifications")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(enabling)

                Button("Not now", action: onContinue)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .disabled(enabling)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
            .background(.ultraThinMaterial)
        }
    }
}
