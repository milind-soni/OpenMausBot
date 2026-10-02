// A bot's computer, live.
//
// The harness already screenshots a working bot every few seconds and pushes
// the frame to any client that asked for it. This is that, and nothing more:
// no clicking, no typing, no control. Watching is the useful half on a phone
// — you want to know what it is doing, not to do it yourself on a screen the
// size of a playing card.
//
// Frames are expensive (hundreds of kilobytes of base64 each), so they are
// off unless this view is on screen. `watchScreen` reopens the stream asking
// for them and `stopWatchingScreen` reopens it asking not to; both resume
// from the cursor, so the reconnect costs nothing but a round trip.
//
// A Local VM can also be pictured while its bot is idle: this view asks the
// harness for a still every thirty seconds (every three while the bot works
// and the stream has gone quiet), the same cadence as the desktop panel. The
// Mac has to allow computer access for this phone first; until it does, the
// sidecar answers 403 and the view says where to turn it on.
import SwiftUI
import CompanionCore
// Unconditional for the same reason as ChatView: `UIImage` is used below
// without a guard, so a conditional import would only change which error a
// non-UIKit build fails with.
import UIKit

struct ComputerView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDesktop = false
    @State private var openingDesktop = false
    @State private var desktopURL: URL?
    @State private var desktopError: String?
    @Environment(\.scenePhase) private var scenePhase
    /// The latest on-demand Local VM still, and when it arrived.
    @State private var polled: (shot: LocalVmScreenshot, at: Date)?
    /// When the event stream last delivered a frame, so the newer of the
    /// two pictures is the one on screen.
    @State private var streamFrameAt: Date?
    @State private var fetchingFirstStill = false
    @State private var vmProblem: LocalVmProblem?
    /// The live desktop while this phone holds the Local VM, and the lease
    /// it holds it under.
    @State private var control: (desktop: LocalVmDesktop, leaseId: String, client: CompanionClient)?
    @State private var takingControl = false
    /// A hand-back still releasing. The lease id is reused per bot and
    /// computer, so a take started now would be undone when that release
    /// lands; Take control waits for it.
    @State private var handingBack = false
    /// The take in flight, cancelled if the person leaves before it lands.
    @State private var taking: Task<Void, Never>?
    @State private var controlError: String?

    private enum LocalVmProblem: Equatable {
        /// The Mac has not allowed computer access for this phone.
        case accessOff
        /// The VM exists in this conversation but cannot be pictured now.
        case unavailable(String)
    }

    private var frame: ScreenFrame? { session.state.screens[bot.id] }

    /// Whichever picture is newer: a streamed frame of a working bot, or a
    /// still fetched on demand.
    private var shownImageData: Data? {
        if let polled, streamFrameAt.map({ $0 < polled.at }) ?? true { return polled.shot.data }
        return frame?.data
    }

    /// Cloud computers have their own viewer below; every other kind may be
    /// the Local VM, which the harness confirms or refuses (409) per thread.
    private var mayBeLocalVm: Bool { current.computer != "cloud" }

    /// The bot as the stream last described it — `busy` is what tells us
    /// whether more frames are coming or this is the last one.
    /// Projected onto the thread this view was opened from, so a task thread
    /// pictures its own computer, not the bot's default conversation.
    private var current: Bot { session.state.bot(bot.id)?.projected(forThread: bot.threadId) ?? bot }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let image = shownImageData.flatMap(UIImage.init(data:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    // The desktop is wider than the phone, so it lands as a
                    // letterbox. Pinch-to-zoom would be the obvious next
                    // thing; scaledToFit is the honest starting point.
                    .accessibilityLabel("\(current.name)'s computer")
                    // The last good picture stays up, but says when it could
                    // not be refreshed rather than passing for current. With
                    // access off only a streamed frame can be on screen; it
                    // stays, captioned, so the notice is not lost behind it.
                    .overlay(alignment: .bottom) {
                        switch vmProblem {
                        case .accessOff:
                            caption("lock.display") { Text("Computer access is off for this phone") }
                        case let .unavailable(reason):
                            caption("exclamationmark.triangle.fill") { Text("Couldn't refresh: \(reason)") }
                        case nil:
                            EmptyView()
                        }
                    }
            } else {
                waiting
            }
        }
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Busy is the difference between "the picture is a moment old"
                // and "the picture is however it was left" — worth saying,
                // because a still frame looks identical either way.
                Text(current.busy == true ? "Preview" : "Idle")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(current.busy == true ? Color.green : Color.secondary)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if polled != nil && vmProblem == nil && control == nil {
                takeControlBar
            }
            // A VPS-backed bot is "cloud" too, but the server refuses to mint
            // an interactive desktop for it — no button beats a dead one. An
            // older harness never sends cloudBackend, so nil keeps the button.
            // Minting a desktop session is admin-only on a server, too.
            if current.computer == "cloud" && current.cloudBackend != "vps" && session.canAdminister {
                VStack(spacing: 8) {
                    if let desktopError {
                        Text(desktopError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                    Button {
                        confirmingDesktop = true
                    } label: {
                        if openingDesktop {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity)
                        } else {
                            Label("Open live cloud desktop", systemImage: "display")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(openingDesktop)
                    Text("Interactive VNC session. Access must be enabled for this device in the Mac's Phone settings.")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
            }
        }
        .alert("Open live cloud desktop?", isPresented: $confirmingDesktop) {
            Button("Cancel", role: .cancel) {}
            Button("Open desktop") { Task { await openDesktop() } }
        } message: {
            Text("This gives this device full control of the cloud computer, including anything signed in inside it.")
        }
        .sheet(
            isPresented: Binding(
                get: { desktopURL != nil },
                set: { if !$0 { desktopURL = nil } }
            )
        ) {
            if let desktopURL {
                CloudDesktopBrowser(url: desktopURL)
                    .ignoresSafeArea()
            }
        }
        .onAppear {
            session.watchScreen(of: bot.id)
        }
        .onDisappear {
            session.stopWatchingScreen(of: bot.id)
            // A take still in flight is abandoned; when it lands it hands
            // the computer straight back.
            taking?.cancel()
        }
        .onValueChange(of: frame?.png) { png in
            if png != nil { streamFrameAt = Date() }
        }
        // Restarted when the bot starts or stops working (the cadence
        // changes); stopped in the background and while this phone is
        // driving the VM live.
        .task(id: "\(current.busy == true)|\(scenePhase == .active)|\(control == nil)") {
            guard scenePhase == .active, control == nil else { return }
            await pollLocalVm()
        }
        .fullScreenCover(isPresented: Binding(
            get: { control != nil },
            set: { if !$0 { Task { await handBack() } } }
        )) {
            if let control {
                LocalVmControlView(botName: current.name, desktop: control.desktop) {
                    Task { await handBack() }
                }
            }
        }
        // Control needs the app in front: a phone that is locked or
        // switched away gives the computer back rather than leaving the bot
        // locked out behind a lease nobody is using.
        .onValueChange(of: scenePhase) { phase in
            guard phase == .background else { return }
            taking?.cancel()
            if control != nil { Task { await handBack() } }
        }
    }

    /// Take or join the Local VM: a person can then drive it from the
    /// trackpad, and the bot's own computer actions are refused until Hand
    /// Back.
    private var takeControlBar: some View {
        VStack(spacing: 8) {
            if let controlError {
                Text(verbatim: controlError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                taking = Task { await takeControl() }
            } label: {
                if takingControl {
                    ProgressView().tint(.white).frame(maxWidth: .infinity)
                } else {
                    Label("Take control", systemImage: "hand.raised")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(takingControl || handingBack)
            Text("The bot pauses its computer work until you hand it back.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.6))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }

    private func takeControl() async {
        guard !handingBack else { return }
        takingControl = true
        controlError = nil
        defer { takingControl = false }
        do {
            let viewer = try await session.takeLocalVm(for: current)
            // The person left (or the app went to the background) while this
            // was in flight: give the computer straight back instead of
            // opening a desktop nobody is looking at.
            guard !Task.isCancelled, scenePhase == .active else {
                await session.handBackDetached(bot: current, leaseId: viewer.leaseId, client: viewer.client)
                return
            }
            let desktop = LocalVmDesktop(request: viewer.request, password: viewer.password)
            desktop.start()
            control = (desktop, viewer.leaseId, viewer.client)
        } catch is CancellationError {
            return
        } catch {
            if !Task.isCancelled { controlError = error.localizedDescription }
        }
    }

    private func handBack() async {
        guard let taken = control else { return }
        control = nil
        taken.desktop.stop()
        handingBack = true
        defer { handingBack = false }
        await session.handBackLocalVm(for: current, leaseId: taken.leaseId, client: taken.client)
    }

    /// Fetch Local VM stills while this view is on screen. Stops on a 409
    /// saying this conversation is not on the Local VM, and on a 404 from a
    /// computer too old to offer it. With computer access off it keeps asking
    /// at the idle cadence, so turning it on at the Mac shows up here without
    /// leaving the view.
    private func pollLocalVm() async {
        guard mayBeLocalVm else { return }
        fetchingFirstStill = polled == nil
        defer { fetchingFirstStill = false }
        while !Task.isCancelled {
            let busy = current.busy == true
            // A working bot's frames already arrive on the stream; only fill
            // in when it has gone quiet for longer than a frame interval.
            let streamFresh = streamFrameAt.map { Date().timeIntervalSince($0) < 10 } ?? false
            if !(busy && streamFresh) {
                // Stamped when asked, so a slow capture never outranks a
                // streamed frame that arrived while it was being taken.
                let askedAt = Date()
                do {
                    let shot = try await session.localVmScreenshot(for: current)
                    polled = (shot, askedAt)
                    vmProblem = nil
                } catch let APIError.status(code, message) {
                    switch code {
                    case 403 where message?.contains("computer access is off") == true:
                        // Revoked or never granted: stop showing the old picture.
                        polled = nil
                        vmProblem = .accessOff
                    case 404:
                        return
                    case 409 where message?.contains("not using the Local VM") == true:
                        polled = nil
                        vmProblem = nil
                        return
                    default:
                        vmProblem = .unavailable(APIError.status(code: code, message: message).localizedDescription)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                    vmProblem = .unavailable(error.localizedDescription)
                }
                fetchingFirstStill = false
            }
            try? await Task.sleep(for: .seconds(busy && vmProblem == nil ? 3 : 30))
        }
    }

    @ViewBuilder
    private var waiting: some View {
        switch vmProblem {
        case .accessOff:
            notice(
                systemImage: "lock.display",
                title: "Computer access is off for this phone",
                detail: Text("Turn on Allow computer view for this phone in OpenMausBot → Settings → Remote access on your computer.")
            )
        case let .unavailable(reason):
            notice(systemImage: "display.trianglebadge.exclamationmark", title: "Can't show the Local VM", detail: Text(verbatim: reason))
        case nil:
            streamWaiting
        }
    }

    private func caption(_ systemImage: String, @ViewBuilder text: () -> Text) -> some View {
        Label { text() } icon: { Image(systemName: systemImage) }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.85))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(.bottom, 12)
    }

    private func notice(systemImage: String, title: LocalizedStringKey, detail: Text) -> some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 28))
                .foregroundStyle(Color.white.opacity(0.7))
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.85))
            detail
                .font(.system(size: 13))
                .foregroundStyle(Color.white.opacity(0.55))
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
    }

    private var streamWaiting: some View {
        VStack(spacing: 12) {
            ProgressView().tint(.white)
            Text(current.busy == true || fetchingFirstStill ? "Waiting for a frame…" : "Nothing to show yet")
                .font(.system(size: 15))
                .foregroundStyle(Color.white.opacity(0.7))
            // An idle bot is not being screenshotted at all, so this would
            // otherwise be an indefinite spinner with no explanation.
            if current.busy != true && !fetchingFirstStill {
                Text("This bot's computer is only captured while it is working.")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.white.opacity(0.45))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    @MainActor
    private func openDesktop() async {
        openingDesktop = true
        desktopError = nil
        defer { openingDesktop = false }
        do {
            desktopURL = try await session.cloudDesktop(for: current)
        } catch {
            desktopError = error.localizedDescription
        }
    }
}
