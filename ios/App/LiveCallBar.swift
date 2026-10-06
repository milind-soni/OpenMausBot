// The call bar: a Live call's controls, compact, above the composer, so the
// chat stays in view while you talk. Three shapes:
//
// - LiveCallBar: this phone's call on this chat — bot, "Live with Ada ·
//   m:ss", one caption line, settings, mute, hang up; or why it stopped,
//   with Try again.
// - RemoteLiveCallBar: a call on this chat that another device holds. The
//   Mac's word only (state.liveCall): "Live with Ada · m:ss", where the call
//   is on a second line, and a hang up that asks the Mac.
// - LiveCallBanner: a thin line on other screens while this phone is on a
//   call, tapping back to it.
import CompanionCore
import SwiftUI

struct LiveCallBar: View {
    let botName: String
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var liveCall: LiveCallController
    @State private var showingSettings = false

    var body: some View {
        Group {
            switch liveCall.machine.phase {
            case .idle:
                EmptyView()
            case .starting:
                // Hang up already: a start can take seconds (the microphone
                // prompt, the offer, the Mac asking OpenAI), and a call the
                // person no longer wants must not be one they have to wait
                // out. The controller ends whatever a late 201 created.
                row(
                    title: Text("Calling \(botName)…").accessibilityIdentifier("live-call-title"),
                    captions: false,
                    controls: .hangUpOnly
                )
            case .live:
                row(
                    title: LiveCallTitle(
                        botName: botName,
                        connecting: liveCall.machine.isConnecting,
                        feed: liveCall.feed
                    ),
                    captions: true,
                    controls: .full
                )
            case .ending:
                row(title: Text("Hanging up…").accessibilityIdentifier("live-call-title"), captions: false, controls: .none)
            case let .stopped(_, notice):
                stoppedRow(notice)
            }
        }
        // The gear and its sheet belong to the live row. When the call leaves
        // it the sheet goes with the row, and the flag must go too, or a
        // Try again that reaches live would open the sheet uninvited.
        .onValueChange(of: isLive) { live in
            if !live { showingSettings = false }
        }
    }

    private var isLive: Bool {
        if case .live = liveCall.machine.phase { return true }
        return false
    }

    /// Which buttons a row carries: none while hanging up, only the red
    /// hang-up while calling, settings, mute and hang-up once live.
    private enum Controls { case none, hangUpOnly, full }

    /// `title` carries its own accessibility id: "live-call-title" (and
    /// "live-call-clock" while live).
    private func row(title: some View, captions: Bool, controls: Controls) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.green)
                title
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if controls == .full {
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Color.secondary.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Live call settings")
                    .accessibilityIdentifier("live-call-settings")

                    Button { liveCall.toggleMute() } label: {
                        Image(systemName: liveCall.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(liveCall.isMuted ? LiveCallColor.red : Color.primary)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(liveCall.isMuted ? LiveCallColor.mutedBackground : Color.secondary.opacity(0.12)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(liveCall.isMuted ? "Unmute" : "Mute")
                    .accessibilityIdentifier("live-call-mute")
                }
                if controls != .none {
                    Button { liveCall.hangUp() } label: {
                        HangUpLabel()
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Hang up")
                    .accessibilityIdentifier("live-call-hangup")
                }
            }
            if captions {
                LiveCallCaptionLine(feed: liveCall.feed)
            }
        }
        // iOS-on-Mac sheet hosting does not inherit environment objects.
        .sheet(isPresented: $showingSettings) {
            LiveCallSettingsSheet()
                .environmentObject(session)
                .environmentObject(liveCall)
        }
        .modifier(BarChrome(tint: LiveCallColor.tint))
    }

    private func stoppedRow(_ notice: LiveCallNotice) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "phone.down")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.secondary)
            notice.text
                .font(.system(size: 13))
                .lineLimit(2)
                .accessibilityIdentifier("live-call-title")
            Spacer(minLength: 4)
            if notice.canRetry {
                Button("Try again") { liveCall.retry() }
                    .font(.system(size: 13, weight: .semibold))
                    .tint(LiveCallColor.action)
                    .accessibilityIdentifier("live-call-retry")
            }
            Button { liveCall.dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("live-call-dismiss")
        }
        .modifier(BarChrome(tint: nil))
    }
}

/// "Live with Ada · m:ss", or "Connecting…" until the computer says live
/// and the channel is open; the clock counts from that moment. It follows
/// the feed, so the clock redraws this line only.
private struct LiveCallTitle: View {
    let botName: String
    let connecting: Bool
    @ObservedObject var feed: LiveCallFeed

    var body: some View {
        if connecting {
            Text("Connecting…")
                .accessibilityIdentifier("live-call-title")
        } else {
            LiveCallNameAndClock(botName: botName, clock: LiveCallClock.text(feed.elapsedSeconds), id: "live-call")
        }
    }
}

/// "Live with Ada · m:ss" on one line, on this phone's bar and on the remote
/// bar. Only the name gives way: the clock takes its whole width first and
/// the name gets what is left, cut short with "…" when it needs more. The
/// clock's digits are all one width, so a long name is not cut a letter
/// shorter or longer every second. `id` names the two parts, "<id>-title"
/// and "<id>-clock"; VoiceOver reads the whole name and then the time.
private struct LiveCallNameAndClock: View {
    let botName: String
    let clock: String
    let id: String

    var body: some View {
        HStack(spacing: 0) {
            Text("Live with \(botName)")
                .accessibilityIdentifier("\(id)-title")
            Text(verbatim: " · \(clock)")
                .monospacedDigit()
                .fixedSize()
                .layoutPriority(1)
                .accessibilityLabel(Text(verbatim: clock))
                .accessibilityIdentifier("\(id)-clock")
        }
    }
}

/// The last words said, the person's in grey. It follows the feed, so each
/// word redraws this line only.
private struct LiveCallCaptionLine: View {
    @ObservedObject var feed: LiveCallFeed

    var body: some View {
        if !feed.captions.line.isEmpty {
            Text(verbatim: feed.captions.line)
                .font(.system(size: 13))
                .foregroundStyle(feed.captions.speaker == .user ? LiveCallColor.ownWords : Color.primary)
                .lineLimit(1)
                .accessibilityIdentifier("live-call-caption")
        }
    }
}

/// A call on this chat that another device holds. The clock counts from the
/// Mac's `startedAt`; hanging up asks the Mac, which tells everyone. The bar
/// goes on the Mac's answer; if the Mac (or the sidecar) refuses, its words
/// show in the app's alert and the bar stays, so the tap can be tried again.
///
/// Where the call is ("From your computer") has a line of its own, where this
/// phone's own call shows its captions: on the first line it pushed the clock
/// off a phone's width.
struct RemoteLiveCallBar: View {
    let call: LiveCallState
    let botName: String
    @EnvironmentObject private var session: Session
    /// One hang-up at a time: a second tap while the first is on its way
    /// would only earn a 404 for a call the first one ended.
    @State private var hangingUp = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.green)
                // The clock runs on the timeline, not on a timer held by this
                // view: the chat re-renders the bar as frames land, and a timer
                // re-created with each render may never get to fire.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    LiveCallNameAndClock(
                        botName: botName,
                        clock: LiveCallClock.text(LiveCallClock.elapsed(since: call.startedAt, now: context.date)),
                        id: "live-call-remote"
                    )
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                }
                Spacer(minLength: 4)
                Button {
                    hangingUp = true
                    Task {
                        await session.hangUpRemoteLiveCall(callId: call.callId)
                        hangingUp = false
                    }
                } label: {
                    HangUpLabel()
                }
                .buttonStyle(.plain)
                .disabled(hangingUp)
                .accessibilityLabel("Hang up")
                .accessibilityIdentifier("live-call-remote-hangup")
            }
            LiveCallNotice.fromDevice(call.client)
                .font(.system(size: 13))
                .foregroundStyle(LiveCallColor.detail)
                .lineLimit(1)
                .accessibilityIdentifier("live-call-remote-device")
        }
        .modifier(BarChrome(tint: LiveCallColor.tint))
        .accessibilityIdentifier("live-call-remote-bar")
    }
}

/// On screens other than the call's chat: one line, tap to go back.
struct LiveCallBanner: View {
    let open: (LiveCallMachine.Target) -> Void
    @EnvironmentObject private var liveCall: LiveCallController

    var body: some View {
        if liveCall.machine.isActive, let target = liveCall.machine.target {
            Button { open(target) } label: {
                LiveCallBannerLabel(botName: target.botName, feed: liveCall.feed)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 8)
            .accessibilityIdentifier("live-call-banner")
        }
    }
}

/// The banner's words and clock. It follows the feed, so the clock redraws
/// this label only, not the roster or the chat around it.
///
/// The words are primary text on a light green tint, with only the phone in
/// green: black on pale green in light mode, white on dark green in dark
/// mode, both well past WCAG AA. Green words on the fully green glass they
/// had before measured about 1.4:1.
private struct LiveCallBannerLabel: View {
    let botName: String
    @ObservedObject var feed: LiveCallFeed

    var body: some View {
        Label {
            Text("On a call with \(botName) · \(LiveCallClock.text(feed.elapsedSeconds))")
                .foregroundStyle(Color.primary)
        } icon: {
            Image(systemName: "phone.fill")
                .foregroundStyle(Color.green)
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .glassCapsule(tint: LiveCallColor.tint)
    }
}

/// The glass the bars sit on, the same width as the composer.
private struct BarChrome: ViewModifier {
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glassSheet(cornerRadius: 22, tint: tint)
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .frame(maxWidth: CompanionLayout.chatWidth)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("live-call-bar")
    }
}

/// The round red hang-up, on either bar.
private struct HangUpLabel: View {
    var body: some View {
        Image(systemName: "phone.down.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color.white)
            .frame(width: 32, height: 32)
            .background(Circle().fill(LiveCallColor.red))
    }
}

/// The call's colours, for the light green tint under the bars and the
/// banner. On the full green they had before, white words read at 1.95:1 in
/// dark mode and the hang-up red came out salmon. On the light tint the words
/// are primary text, black on pale green or white on dark green, and the
/// colours below keep the rest past WCAG AA in both modes.
private enum LiveCallColor {
    static let tint = Color.green.opacity(0.2)
    /// Hang up, and a muted microphone: the system red in dark mode; in
    /// light mode a deeper red (#D70015), as the system red is too pale on
    /// the pale green for its button to stand out.
    static let red = adaptive(light: UIColor(red: 0.843, green: 0, blue: 0.082, alpha: 1), dark: .systemRed)
    /// Try again, on a stopped call's plain glass: the system blue in dark
    /// mode; in light mode a deeper blue (#0040DD), as the system blue reads
    /// at 3.5:1 there.
    static let action = adaptive(light: UIColor(red: 0, green: 0.251, blue: 0.867, alpha: 1), dark: .systemBlue)
    /// The person's own words on the caption line: grey, yet dark (or light)
    /// enough for small text on either tint, which `.secondary` is not.
    static let ownWords = Color.primary.opacity(0.7)
    /// Where a remote call is, under its name and clock: the same grey.
    static let detail = ownWords
    /// Behind a muted microphone: the page's own colour, white or black, so
    /// the red slash stands out in both modes.
    static let mutedBackground = Color(uiColor: .systemBackground)

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in
            (traits.userInterfaceStyle == .dark ? dark : light).resolvedColor(with: traits)
        })
    }
}

extension LiveCallNotice {
    /// The words for each notice. Here, not in CompanionCore, so the string
    /// catalog can translate them; the classification is tested there.
    var text: Text {
        switch self {
        case .micDenied:
            return Text("Live calls need Microphone access. Enable it in Settings → MausBot.")
        case .needsKey:
            return Text("Set up Live calls on your computer first.")
        case let .busy(client, botName):
            return Text("\(Self.deviceName(client)) is on a call with \(botName.map { Text(verbatim: $0) } ?? Text("a bot")).")
        case let .unreachable(detail):
            return Text("Can't reach your computer. \(detail)")
        case let .refused(message):
            return Text(verbatim: message)
        case let .couldNotStart(detail):
            return Text("The call could not start: \(detail)")
        case .dropped:
            return Text("Call dropped.")
        case .audioNeverConnected:
            return Text("Call dropped: the audio could not connect.")
        // The end reasons in the desktop's words (call.live.* in
        // src/locales/en.json), so a call reads the same on every client.
        case .ended:
            return Text("Call ended.")
        case .endedIdle:
            return Text("Call ended after a long silence.")
        case .endedExpired:
            return Text("Call ended: it reached OpenAI's time limit.")
        case .endedContent:
            return Text("OpenAI ended the call under its content rules.")
        case .endedDeleted:
            return Text("Call ended: the chat was deleted.")
        case .endedShutdown:
            return Text("Call ended: OpenMausBot restarted.")
        // The computer's own words when it ended the call; this phone's
        // when the computer stopped taking its requests: the words the
        // harness uses for a phone it unpaired (LIVE_COPY.unpaired).
        case let .signedOut(message?):
            return Text(verbatim: message)
        case .signedOut(nil):
            return Text("Call ended: you were signed out.")
        case let .endedWithError(message, _):
            return Text(verbatim: message)
        }
    }

    /// "Your computer", for the start of a sentence. Not "your Mac": the
    /// harness runs on Linux too. A `Text`, not a `String(localized:)`, so it
    /// follows the in-app language like the sentence it sits in; a String
    /// would follow the phone's and mix two languages in one line.
    static func deviceName(_ client: String) -> Text {
        switch client {
        case "desktop": return Text("Your computer")
        case "ios": return Text("An iPhone")
        case "android": return Text("An Android phone")
        default: return Text("Another device")
        }
    }

    /// Where a call another device holds is: the remote bar's second line.
    /// The desktop's remote bar says it the same way ("Pepper is on a Live
    /// call from an iPhone"), and so does Android's.
    static func fromDevice(_ client: String) -> Text {
        switch client {
        case "desktop": return Text("From your computer")
        case "ios": return Text("From an iPhone")
        case "android": return Text("From an Android phone")
        default: return Text("From another device")
        }
    }
}
