import SwiftUI
import UIKit
import CompanionCore

/// An agent identity image fetched from the paired computer with the device
/// bearer token. The mascot is deterministic fallback for missing, stale, or
/// undecodable attachments, so identity never becomes an empty placeholder.
struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: AstraState = .idle
    /// Opt-in, mirroring AstraAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @EnvironmentObject private var session: Session
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }
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
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            // Only the flat crops paint the bytes; the mascot never needs them.
            guard crop != .mascot, bot.avatarUrl != nil else { return }
            let data = await session.avatarData(for: bot)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = Self.decode(data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
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

    /// An animated GIF or WebP becomes an animated `UIImage`; everything else
    /// — and anything whose frames will not decode — stays a still.
    private static func decode(_ data: Data) -> UIImage? {
        if let animation = AnimatedImageDecoder.decode(data) {
            let frames = animation.frames.map { UIImage(cgImage: $0) }
            if let animated = UIImage.animatedImage(with: frames, duration: animation.duration) {
                return animated
            }
        }
        return UIImage(data: data)
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
        AstraAvatar(
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

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: AstraState = .idle
    /// Opt-in, mirroring AstraAvatar: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case .room:
            AstraAvatar(color: "blue", size: size, state: state, animated: animated, comets: comets)
        }
    }
}
