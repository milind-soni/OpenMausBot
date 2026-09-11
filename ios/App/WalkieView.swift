// Walkie mode: the agents at a glance and one button to talk to them.
//
// The handheld concept, on the phone: agent rows with their state, four
// keys, and a hold-to-talk bar. Tap a row to choose who you are talking to;
// hold the bar, speak, let go. The answer is read back when the turn ends.
import SwiftUI
import CompanionCore

struct WalkieView: View {
    /// Leave Walkie for a chat — the caller owns navigation.
    let onOpen: (Chat) -> Void

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @StateObject private var walkie = WalkieController()
    @AppStorage("walkie.target") private var targetId = ""
    @AppStorage("walkie.speakReplies") private var speakReplies = true
    @State private var pressing = false

    private var roster: [WalkieAgent] { session.state.walkieRoster }
    private var target: Bot? { session.state.bots.first { $0.id == targetId && $0.hidden != true } }
    private var targetName: String { target?.name ?? String(localized: "an agent") }

    var body: some View {
        VStack(spacing: 14) {
            header
            if roster.isEmpty { empty } else { agentList }
            liveCard
            keys
            talkBar
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: CompanionLayout.rosterWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear {
            walkie.speaksReplies = speakReplies
            if target == nil { targetId = roster.first?.bot.id ?? "" }
        }
        .onChange(of: speakReplies) { _, on in walkie.speaksReplies = on }
        .onReceive(session.$state) { walkie.observe($0) }
        .onDisappear { walkie.shutdown() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Walkie")
                    .font(.system(size: 30, weight: .bold))
                HStack(spacing: 6) {
                    Circle()
                        .fill(session.status == .live ? Color.green : Color.orange)
                        .frame(width: 7, height: 7)
                    Text(verbatim: connectionText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            GlassButton(systemImage: "xmark", size: 44, weight: .semibold) { dismiss() }
                .accessibilityLabel("Close Walkie")
        }
        .padding(.top, 4)
    }

    private var connectionText: String {
        let name = session.connection?.name ?? String(localized: "your computer")
        switch session.status {
        case .live: return name
        case .connecting: return String(localized: "Connecting to \(name)…")
        default: return String(localized: "\(name) is offline")
        }
    }

    // MARK: - Agents

    private var agentList: some View {
        ScrollView {
            VStack(spacing: 4) {
                ForEach(roster) { agent in
                    Button {
                        Haptics.selection()
                        targetId = agent.bot.id
                    } label: {
                        WalkieAgentRow(agent: agent, selected: agent.bot.id == targetId)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
        }
        .scrollIndicators(.hidden)
        .frame(maxHeight: .infinity)
        .background(Self.panel)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var empty: some View {
        ContentUnavailableView(
            "No agents yet",
            systemImage: "person.2",
            description: Text("Bots you make on your computer show up here.")
        )
        .frame(maxHeight: .infinity)
    }

    // MARK: - What is happening

    private var liveCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                liveIcon
                    .frame(width: 20, height: 18)
                    .foregroundStyle(walkie.phase == .listening ? Color.red : Color.accentColor)
                Text(verbatim: liveTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
            }
            Text(verbatim: liveBody)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(walkie.note == nil ? Color.primary : Color.orange)
                .lineLimit(5)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
        .background(Self.panel)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var liveIcon: some View {
        switch walkie.phase {
        case .listening: WalkieWave(active: true)
        case .sending, .waiting: ProgressView().controlSize(.small)
        case .speaking: Image(systemName: "speaker.wave.2.fill")
        case .idle: Image(systemName: walkie.note == nil ? "waveform" : "exclamationmark.circle.fill")
        }
    }

    private var liveTitle: String {
        if walkie.note != nil { return String(localized: "Heads up") }
        switch walkie.phase {
        case .listening: return String(localized: "Listening")
        case .sending: return String(localized: "Sending to \(targetName)")
        case .waiting: return String(localized: "\(targetName) is working on it")
        case .speaking: return walkie.replyFrom
        case .idle:
            return walkie.reply.isEmpty ? String(localized: "Talking to \(targetName)") : walkie.replyFrom
        }
    }

    private var liveBody: String {
        if let note = walkie.note { return note }
        switch walkie.phase {
        case .listening: return walkie.heard.isEmpty ? String(localized: "Go ahead…") : walkie.heard
        case .sending, .waiting: return "\u{201C}\(walkie.heard)\u{201D}"
        case .speaking: return Walkie.speakable(walkie.reply, limit: 400)
        case .idle:
            return walkie.reply.isEmpty
                ? String(localized: "Hold the button, say what you need, then let go.")
                : Walkie.speakable(walkie.reply, limit: 400)
        }
    }

    // MARK: - Keys

    private var keys: some View {
        HStack(spacing: 10) {
            WalkieKey(title: "Replay", systemImage: "arrow.counterclockwise", enabled: !walkie.reply.isEmpty) {
                walkie.replay()
            }
            WalkieKey(title: "Stop", systemImage: "stop.fill", enabled: canStop) {
                Task { await walkie.stop(session: session, target: target) }
            }
            WalkieKey(
                title: speakReplies ? "Voice on" : "Voice off",
                systemImage: speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill",
                enabled: true
            ) {
                speakReplies.toggle()
            }
            WalkieKey(title: "Open chat", systemImage: "bubble.left.and.text.bubble.right", enabled: target != nil) {
                guard let target else { return }
                walkie.shutdown()
                onOpen(.bot(target))
            }
        }
    }

    private var canStop: Bool { walkie.phase == .speaking || target?.currentTaskBusy == true }

    // MARK: - Talk

    private var talkDisabled: Bool { target == nil || walkie.phase == .sending }

    private var talkBar: some View {
        let listening = walkie.phase == .listening
        return ZStack {
            Capsule().fill(listening ? Color.red : Color.accentColor)
            HStack(spacing: 10) {
                if listening {
                    WalkieWave(active: true).frame(width: 30, height: 18)
                    Text("Listening… let go to send")
                } else {
                    Image(systemName: "mic.fill")
                    Text(verbatim: target.map { String(localized: "Hold to talk to \($0.name)") }
                        ?? String(localized: "Pick an agent above"))
                }
            }
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 20)
        }
        .frame(height: 76)
        .scaleEffect(pressing ? 0.97 : 1)
        .animation(.snappy(duration: 0.15), value: pressing)
        .opacity(talkDisabled ? 0.45 : 1)
        .contentShape(Capsule())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !pressing, !talkDisabled else { return }
                    pressing = true
                    walkie.pressBegan()
                }
                .onEnded { _ in
                    guard pressing else { return }
                    pressing = false
                    Task { await walkie.pressEnded(session: session, target: target) }
                }
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(listening ? "Send" : "Talk")
        .accessibilityHint(listening ? "Sends what you said" : "Starts listening. Activate again to send.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction {
            if walkie.phase == .listening {
                Task { await walkie.pressEnded(session: session, target: target) }
            } else if !talkDisabled {
                walkie.pressBegan()
            }
        }
    }

    private static let panel = RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Color(white: 0.11))
}

// MARK: - Pieces

struct WalkieAgentRow: View {
    let agent: WalkieAgent
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            BotAvatarView(bot: agent.bot, size: 34, state: agent.status == .working ? .working : .idle)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: agent.bot.name)
                        .font(.system(size: 16, weight: .semibold))
                        .lineLimit(1)
                    if !agent.bot.title.isEmpty {
                        Text(verbatim: agent.bot.title)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color(white: 0.2)))
                    }
                }
                Text(verbatim: agent.line)
                    .font(.system(size: 13))
                    .foregroundStyle(agent.status == .needsYou ? Color(red: 1, green: 0.55, blue: 0.6) : Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            WalkieStatusMark(status: agent.status)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(selected ? Color.accentColor.opacity(0.14) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.clear, lineWidth: 1.5)
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

struct WalkieStatusMark: View {
    let status: WalkieAgent.Status
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning = false

    var body: some View {
        Group {
            switch status {
            case .needsYou:
                Circle().fill(Color.red).frame(width: 11, height: 11)
            case .working:
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    .frame(width: 14, height: 14)
                    .rotationEffect(.degrees(turning ? 360 : 0))
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { turning = true }
                    }
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.green)
            case .idle:
                Circle()
                    .strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
                    .frame(width: 12, height: 12)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityLabel(status.label)
    }
}

struct WalkieKey: View {
    let title: LocalizedStringKey
    let systemImage: String
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(LinearGradient(colors: [Color(white: 0.17), Color(white: 0.11)], startPoint: .top, endPoint: .bottom))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08))
                    )
                Text(title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

struct WalkieWave: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !active || reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<5, id: \.self) { bar in
                    Capsule()
                        .frame(width: 3.5, height: max(4, 18 * (0.35 + 0.65 * abs(sin(t * 5 + Double(bar) * 0.8)))))
                }
            }
            .frame(maxHeight: 18)
        }
        .accessibilityHidden(true)
    }
}
