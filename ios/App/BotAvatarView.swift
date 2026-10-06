import SwiftUI
import UIKit
import CompanionCore

/// An agent identity image fetched from the paired computer with the device
/// bearer token. The mascot is deterministic fallback for missing, stale, or
/// undecodable attachments, so identity never becomes an empty placeholder.
struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @Environment(\.avatarLoader) private var avatars
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }
    /// The face's size on screen in pixels: what a still is decoded at.
    private var pixelSize: Int { max(1, Int((size * displayScale).rounded(.up))) }
    /// Which of the two renderings this bot gets. The decision itself is a
    /// pure function in `CompanionCore` so it can be tested without a
    /// rendered `Canvas`; see `resolveBotAvatarOutcome`.
    private var outcome: BotAvatarOutcome {
        resolveBotAvatarOutcome(
            crop: crop, hasUrl: bot.avatarUrl != nil, imageDecoded: image != nil, failed: failed)
    }

    var body: some View {
        Group {
            switch outcome {
            // The picture instead of the mascot, masked to the chosen shape.
            case .flatImage: flatImage
            // The mascot in the bot's own colours, which is also the fallback
            // whenever there is no usable picture so identity is never an
            // empty placeholder.
            case .gradientMascot: mascot
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name) avatar")
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)|\(pixelSize)") {
            image = nil
            failed = false
            // Only the flat crops paint the bytes; the mascot never needs them.
            guard crop != .mascot, let path = bot.avatarUrl else { return }
            let data = await avatars.data(for: bot)
            guard !Task.isCancelled else { return }
            guard let data else {
                failed = true
                return
            }
            let decoded = await AvatarImages.image(path: path, data: data, pixelSize: pixelSize)
            guard !Task.isCancelled else { return }
            guard let decoded else {
                failed = true
                return
            }
            image = decoded
        }
    }

    /// SwiftUI's `Image` draws only a `UIImage`'s static representation, so a
    /// multi-frame attachment has to go through the UIKit view that plays
    /// `images` itself. Stills keep the original path.
    @ViewBuilder
    private func attachment(_ image: UIImage) -> some View {
        if image.images == nil {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            AnimatedAttachmentView(image: image)
        }
    }

    /// Only reached with a decoded image: `resolveBotAvatarOutcome` returns
    /// `.flatImage` solely when one exists.
    @ViewBuilder private var flatImage: some View {
        if let image {
            attachment(image)
                .frame(width: size, height: size)
                .clipShape(mask)
        }
    }

    private var mascot: some View {
        MausAvatar(
            color: bot.color, size: size, bodyId: bot.mascotBody,
            state: state, animated: animated, comets: comets)
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot: AnyShape(Rectangle())
        }
    }
}

/// Decoded faces, shared by every view that draws one. A bot's face is on
/// screen in its Home row, the chat header, rooms and the Walkie sheet at
/// once, and the session caches only the bytes: each view used to decode its
/// own full-resolution copy — an uploaded avatar may be 10 MB, a 12 MP photo
/// 48 MB decoded — to fill 26 to 112 points. Stills are now thumbnailed to
/// the face's pixel size and kept, keyed by the attachment path, its byte
/// count and that size, in a cache bounded by count and decoded bytes.
private enum AvatarImages {
    private struct Decoded: @unchecked Sendable {
        let image: UIImage
        let cost: Int
    }

    private static let cache = DecodedImageCache<Decoded>(
        countLimit: 64, totalCostLimit: 32 * 1_024 * 1_024
    ) { $0.cost }

    static func image(path: String, data: Data, pixelSize: Int) async -> UIImage? {
        await cache.value(for: "\(path)|\(data.count)|\(pixelSize)") {
            decode(data, pixelSize: pixelSize)
        }?.image
    }

    /// An animated GIF or WebP becomes an animated `UIImage` (its frames are
    /// already bounded by `AnimatedImageDecoder`); everything else — and
    /// anything whose frames will not decode — stays a still.
    private static func decode(_ data: Data, pixelSize: Int) -> Decoded? {
        if let animation = AnimatedImageDecoder.decode(data) {
            let frames = animation.frames.map { UIImage(cgImage: $0) }
            if let animated = UIImage.animatedImage(with: frames, duration: animation.duration) {
                // Held longer frames repeat the same CGImage; count each once.
                var seen = Set<ObjectIdentifier>()
                let cost = animation.frames.reduce(0) { total, frame in
                    seen.insert(ObjectIdentifier(frame)).inserted ? total + frame.bytesPerRow * frame.height : total
                }
                return Decoded(image: animated, cost: cost)
            }
        }
        guard let still = ImageDownsampler.decode(data, fillingSquare: pixelSize) else { return nil }
        return Decoded(image: UIImage(cgImage: still.cgImage), cost: still.byteCount)
    }
}

/// `UIImageView` plays an animated `UIImage` on its own; SwiftUI has no
/// equivalent. Sizing is left entirely to the SwiftUI frame around it, so the
/// view never fights the layout with an intrinsic size taken from the file.
private struct AnimatedAttachmentView: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.isAccessibilityElement = false
        for axis in [NSLayoutConstraint.Axis.horizontal, .vertical] {
            view.setContentHuggingPriority(.defaultLow, for: axis)
            view.setContentCompressionResistancePriority(.defaultLow, for: axis)
        }
        view.startAnimating()
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        guard view.image !== image else { return }
        view.image = image
        view.startAnimating()
    }
}

/// Where a face's picture comes from: the session's cached, authenticated
/// fetch. An environment value rather than `@EnvironmentObject Session`,
/// which would redraw every face on screen whenever the session publishes —
/// many times a second while a fleet works — for a fetch that runs once.
struct AvatarLoader {
    private weak var session: Session?

    init(session: Session?) {
        self.session = session
    }

    @MainActor
    func data(for bot: Bot) async -> Data? {
        await session?.avatarData(for: bot)
    }
}

private struct AvatarLoaderKey: EnvironmentKey {
    static let defaultValue = AvatarLoader(session: nil)
}

extension EnvironmentValues {
    var avatarLoader: AvatarLoader {
        get { self[AvatarLoaderKey.self] }
        set { self[AvatarLoaderKey.self] = newValue }
    }
}

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: MausState = .idle
    /// Opt-in, mirroring MausAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case .room:
            MausAvatar(color: "blue", size: size, state: state, animated: animated, comets: comets)
        }
    }
}
