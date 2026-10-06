// What a transcript row is drawn from: plain values, and one handler for
// everything a row can ask of the chat around it.
//
// The rows used to read the whole Session for themselves and carry
// ChatView's closures, which SwiftUI cannot compare. So every publish (one
// per 50 ms while any bot in the fleet streams, whichever thread it is in)
// and every keystroke in the composer redrew every row down to its Markdown.
// Home rows had the same problem and the same fix (`CompactBotEntry`): the
// row takes the values it draws, says when two of them are equal, and is
// applied with `.equatable()`, so a row whose values did not change is not
// redrawn at all.
import CompanionCore
import SwiftUI
import UIKit

/// Where a row's tap leads outside the row: ChatView's to carry out.
enum TranscriptNavigation {
    /// An "Opened thread" chip, or a routine card's Open run.
    case thread(ThreadRef)
    /// A link to a file on the paired computer, in this message.
    case file(path: String, messageId: String)
    /// A link that resolves to nothing this phone may open.
    case refusedLink
    /// A folded reply asked to be scrolled into view once it is laid out.
    case reveal(messageId: String)
}

/// Where a row's taps go once they leave the row: ChatView's handlers, held
/// by reference.
///
/// An object rather than closures in every row. A closure made in ChatView's
/// body is a new value on every render, so a row holding one never has the
/// same fields twice; with this reference, and the rows reused while the
/// thread is unchanged (`TranscriptMemo`), an unchanged row's values are
/// identical from render to render, not just equal under its `==`.
///
/// ChatView binds it as it renders the transcript, before any row can act.
/// The handlers read ChatView's state and the session when called.
@MainActor
final class TranscriptRouter {
    fileprivate var liveChat: (() -> Chat)?
    fileprivate var navigate: ((TranscriptNavigation) -> Void)?

    func bind(liveChat: @escaping () -> Chat, navigate: @escaping (TranscriptNavigation) -> Void) {
        self.liveChat = liveChat
        self.navigate = navigate
    }
}

/// Everything a transcript row may ask of the chat it sits in.
///
/// Rows reach the session through this, at tap time, and never read its
/// state while drawing, so a publish redraws nothing by itself. Two values
/// are equal when they act for the same thread through the same session and
/// router: nothing a row draws comes from here.
struct TranscriptActions: Equatable {
    let threadId: String
    private let session: Session
    private let router: TranscriptRouter

    init(threadId: String, session: Session, router: TranscriptRouter) {
        self.threadId = threadId
        self.session = session
        self.router = router
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.threadId == rhs.threadId && lhs.session === rhs.session && lhs.router === rhs.router
    }

    /// The chat as it stands now: the session's actions take the bot or room
    /// and their thread.
    @MainActor
    private var liveChat: Chat? { router.liveChat?() }

    @MainActor
    private func navigate(_ request: TranscriptNavigation) { router.navigate?(request) }

    // MARK: Navigation

    /// A tapped link: the web opens in Safari, a file on the computer is
    /// downloaded into a preview, and anything else is refused.
    @MainActor
    func openLink(_ url: URL, messageId: String) -> OpenURLAction.Result {
        guard let target = LocalMessageLink.resolve(url) else {
            navigate(.refusedLink)
            return .handled
        }
        switch target {
        case let .web(webURL):
            return .systemAction(webURL)
        case let .desktopFile(path):
            navigate(.file(path: path, messageId: messageId))
            return .handled
        }
    }

    @MainActor
    func openThread(_ ref: ThreadRef) { navigate(.thread(ref)) }

    @MainActor
    func reveal(messageId: String) { navigate(.reveal(messageId: messageId)) }

    // MARK: Messages

    @MainActor
    func react(to message: Message, emoji: String) async {
        await session.react(to: message, in: threadId, emoji: emoji)
    }

    @MainActor
    func switchVersion(to message: Message) async {
        guard case let .bot(bot) = liveChat else { return }
        await session.switchVersion(to: message, for: bot)
    }

    @MainActor
    func edit(_ message: Message, text: String) async {
        guard case let .bot(bot) = liveChat else { return }
        await session.edit(message, for: bot, text: text)
    }

    // MARK: Cards

    @MainActor
    func answer(_ card: OptionCard, choice: String, rememberingPermission: Bool = true) async {
        guard let chat = liveChat else { return }
        await session.answer(
            chat: chat, card: card, choice: choice, rememberingPermission: rememberingPermission
        )
    }

    @MainActor
    func alwaysAllow(_ card: OptionCard) async {
        guard case let .bot(bot) = liveChat else { return }
        await session.alwaysAllow(bot: bot, card: card)
    }

    /// A question only ever answers with text, never allow or deny.
    @MainActor
    func answerQuestion(requestId: String, choice: String) async {
        await session.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: false)
    }

    @MainActor
    func updateClaude(instanceId: String) async throws -> String {
        try await session.updateClaude(instanceId: instanceId)
    }

    // MARK: Credentials

    @MainActor
    func preparedCredential(message: Message, secret: SecretRequestCardData) -> PreparedPhoneCredential? {
        guard let chat = liveChat else { return nil }
        return session.preparedCredential(chat: chat, message: message, secret: secret)
    }

    @MainActor
    func prepareCredential(
        _ value: String, message: Message, secret: SecretRequestCardData
    ) throws -> PreparedPhoneCredential {
        guard let chat = liveChat else { throw PhoneSecretError.unavailable }
        return try session.prepareCredential(value, chat: chat, message: message, secret: secret)
    }

    @MainActor
    func provideCredential(_ prepared: PreparedPhoneCredential) async throws {
        try await session.provideCredential(prepared)
    }

    @MainActor
    func discardPreparedCredential(_ prepared: PreparedPhoneCredential) {
        session.discardPreparedCredential(prepared)
    }

    // MARK: Media

    @MainActor
    func screenshot(messageId: String) async -> Data? {
        await session.image(threadId: threadId, messageId: messageId)
    }

    @MainActor
    func fetchAttachment(messageId: String, path: String, cacheResult: Bool) async throws -> DownloadedFile {
        try await session.fetchAttachment(
            threadId: threadId, messageId: messageId, path: path, cacheResult: cacheResult
        )
    }

    @MainActor
    func prepareAttachmentPreview(
        messageId: String, path: String, cacheResult: Bool
    ) async throws -> DownloadedFile {
        try await session.prepareAttachmentPreview(
            threadId: threadId, messageId: messageId, path: path, cacheResult: cacheResult
        )
    }

    @MainActor
    func voiceNoteData(for note: MessageVoiceNote) async -> Data? {
        await session.voiceNoteData(for: note)
    }
}

/// Where this phone stands for entering a credential: the pairing, the
/// route, and the session's resets. Changes rarely, so a credential card
/// redraws when one of these does and not on every publish.
struct CredentialAccess: Equatable {
    var connectionId: String?
    /// The pairing carried the computer's secret key and this phone's id.
    var pairedForSecrets = false
    /// The current route protects credentials (HTTPS or Tailscale).
    var transportProtected = false
    var status: Session.Status = .unpaired
    var resetGeneration = 0
}

/// What every row of one chat shares, worked out once per render.
struct TranscriptRowContext: Equatable {
    let threadId: String
    let name: String
    let color: String
    /// The bot, in a bot chat; nil in a room.
    let botId: String?
    /// The bot is working this thread: no editing or switching versions.
    let busy: Bool
    /// An edit is on its way to the computer, so no second one.
    let editPending: Bool
    /// The engine an "Update Claude" card would update.
    let claudeInstanceId: String?
    let credentials: CredentialAccess

    var isBot: Bool { botId != nil }
}

/// One row of the transcript, with the date line above it when a gap
/// precedes it: the unit `.equatable()` skips when nothing it draws changed.
struct TranscriptRowView: View, Equatable {
    let row: TranscriptRow
    /// When the date line shows, the time it names.
    let stamp: Date?
    /// The day the stamp was worded on: "Today 9:15" must become "Yesterday
    /// 9:15" after midnight even when the row itself has not changed.
    let today: Date
    /// Last bubble of a run from the same side: the one with the tail.
    let endsRun: Bool
    /// The versions of a user message, for its "1 of 2" switcher.
    let versions: [Message]
    /// This row is the stand-in for an edit the computer has not answered.
    let isPendingEdit: Bool
    /// Where a routine card's Open run goes; nil, no button.
    let routineRun: ThreadRef?
    let context: TranscriptRowContext
    /// The message a search landed on, for the fold that holds it only.
    let revealedMessageId: String?
    let actions: TranscriptActions

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.stamp == rhs.stamp && lhs.today == rhs.today
            && lhs.endsRun == rhs.endsRun && lhs.versions == rhs.versions
            && lhs.isPendingEdit == rhs.isPendingEdit && lhs.routineRun == rhs.routineRun
            && lhs.context == rhs.context && lhs.revealedMessageId == rhs.revealedMessageId
            && lhs.actions == rhs.actions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // a gap in time is worth marking; a timestamp
            // on every message is just noise
            if let stamp {
                Text(RelativeStamp.separator(stamp))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.secondary.opacity(0.7))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
            }
            content
        }
        // Never wider than the column, whatever is inside. A frame with only
        // a maximum takes its content's width when that is wider, and one
        // over-wide row then widened the transcript, the scroll view and the
        // whole chat screen — header and composer cut off at both edges (a
        // wide screenshot did it). An overflowing row now overflows its own
        // edge instead: yours to the left, a bot's to the right.
        .frame(minWidth: 0, maxWidth: .infinity, alignment: alignment)
    }

    private var alignment: Alignment {
        if case let .message(message) = row, message.role == .user { return .trailing }
        return .leading
    }

    @ViewBuilder private var content: some View {
        switch row {
        case let .message(message):
            MessageRow(
                message: message, versions: versions, endsRun: endsRun,
                isPendingEdit: isPendingEdit, routineRun: routineRun,
                context: context, actions: actions
            )
        case let .activityRun(items):
            ActivityRunChip(items: items, openThread: actions.openThread)
        case let .assistantTurn(turn):
            AssistantTurnChip(
                turn: turn, context: context, actions: actions, revealedMessageId: revealedMessageId
            )
        }
    }
}

/// `MessagePresentation` per message, kept while the message reads the same,
/// so a row drawn again (its card answered, the thread reopened) does not
/// parse its text again.
@MainActor
enum MessagePresentations {
    private final class Entry {
        let role: Message.Role
        let kind: Message.Kind
        let text: String?
        let value: MessagePresentation

        init(_ message: Message, _ value: MessagePresentation) {
            role = message.role
            kind = message.kind
            text = message.text
            self.value = value
        }
    }

    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 512
        return cache
    }()

    static func of(_ message: Message) -> MessagePresentation {
        let key = message.id as NSString
        if let hit = cache.object(forKey: key),
           hit.role == message.role, hit.kind == message.kind, hit.text == message.text {
            return hit.value
        }
        let value = MessagePresentation(message)
        cache.setObject(Entry(message, value), forKey: key)
        return value
    }
}

/// A frame of the bot's computer, decoded no larger than it is drawn.
///
/// A desktop screenshot decoded in full is about 16 MB of bitmap; the
/// transcript draws it a phone's width across. The decode runs off the main
/// actor through `ImageDownsampler`, straight to the drawn width, and the
/// bitmap is kept by message id and width in a `DecodedImageCache`, which
/// the system can empty under memory pressure.
enum ScreenShotImages {
    private static let cache = DecodedImageCache<DecodedImage>(
        countLimit: 64, totalCostLimit: 48 * 1024 * 1024, cost: \.byteCount
    )

    private static func key(_ messageId: String, _ pixelWidth: Int) -> String {
        "\(messageId)|\(pixelWidth)"
    }

    static func cached(messageId: String, pixelWidth: Int) -> UIImage? {
        cache.cached(key(messageId, pixelWidth)).map { UIImage(cgImage: $0.cgImage) }
    }

    /// Base64 decoding a large inline frame is work too: off the main actor.
    static func data(fromBase64 inline: String) async -> Data? {
        await Task.detached(priority: .userInitiated) { Data(base64Encoded: inline) }.value
    }

    /// `data` decoded `pixelWidth` pixels across (never larger than it is),
    /// once per message and width.
    static func decode(_ data: Data, messageId: String, pixelWidth: Int) async -> UIImage? {
        guard pixelWidth > 0 else { return nil }
        let decoded = await cache.value(for: key(messageId, pixelWidth)) {
            ImageDownsampler.decode(data, fittingWidth: pixelWidth)
        }
        return decoded.map { UIImage(cgImage: $0.cgImage) }
    }
}

#if DEBUG
/// How many times a message row has been drawn, for ResponsivenessUITests:
/// typing into a chat, or another thread's tokens, must not redraw it.
/// Shown only by the `-busy-fleet-preview` fixture's badge.
@MainActor
enum TranscriptRedrawProbe {
    private(set) static var rows = 0
    static func noteRow() { rows &+= 1 }
}
#endif
