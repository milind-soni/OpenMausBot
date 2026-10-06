import CompanionCore
import ImageIO
import QuickLook
import SwiftUI
import UIKit

private struct SendableAttachmentImage: @unchecked Sendable {
    let value: CGImage?
}

private func decodeAttachmentThumbnail(_ data: Data, maximumPixelSize: Int) -> SendableAttachmentImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
        return SendableAttachmentImage(value: nil)
    }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    return SendableAttachmentImage(
        value: CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    )
}

enum AttachmentImportError: LocalizedError {
    case unreadable(String)
    case unsupported(String)
    case tooLarge(String, Int)

    var errorDescription: String? {
        switch self {
        case let .unreadable(name):
            return "OpenMausBot couldn't read \(name). Try exporting it to Files first."
        case let .unsupported(name):
            return "\(name) isn't a supported attachment. Try an image, PDF, text, Word, Excel, or PowerPoint file."
        case let .tooLarge(name, bytes):
            let limit = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
            return "\(name) is larger than the \(limit) remaining attachment limit."
        }
    }
}

struct PendingAttachmentChip: View {
    let attachment: PendingMessageAttachment
    let remove: () -> Void

    @Environment(\.displayScale) private var displayScale
    /// Decoded once per attachment, off the main actor, at the chip's own
    /// pixel size. Decoding in `body` ran a full-resolution decode of the
    /// photo (48 MB for 12 MP) on every composer render — each keystroke and
    /// each 50 ms publish while a bot streamed — to draw 34 points.
    @State private var thumbnail: UIImage?
    @State private var thumbnailFailed = false

    private static let side: CGFloat = 34

    private var thumbnailKey: String {
        "\(attachment.id)|\(Int((Self.side * displayScale).rounded(.up)))"
    }

    var body: some View {
        HStack(spacing: 8) {
            preview

            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                    .font(.system(size: 11))
                    .foregroundStyle(Color.secondary)
            }

            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 24, height: 24)
                    .background(Color.secondary.opacity(0.12), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.name)")
        }
        .padding(.leading, 7)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.secondary.opacity(0.10))
        )
        .accessibilityElement(children: .contain)
        .task(id: thumbnailKey) { await loadThumbnail() }
    }

    private func loadThumbnail() async {
        guard attachment.kind == .image else { return }
        let data = attachment.data
        let side = Int((Self.side * displayScale).rounded(.up))
        let decoded = await Task.detached(priority: .userInitiated) {
            ImageDownsampler.decode(data, fillingSquare: side)
        }.value
        guard !Task.isCancelled else { return }
        thumbnail = decoded.map { UIImage(cgImage: $0.cgImage) }
        thumbnailFailed = decoded == nil
    }

    @ViewBuilder
    private var preview: some View {
        if attachment.kind == .image, let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFill()
                .frame(width: Self.side, height: Self.side)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
        } else if attachment.kind == .image, !thumbnailFailed {
            // The few milliseconds before the first decode lands: the chip's
            // own tile, rather than a document icon that then turns into a photo.
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.secondary.opacity(0.12))
                .frame(width: Self.side, height: Self.side)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "doc.fill")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .frame(width: 34, height: 34)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
        }
    }
}

/// One attachment already present in a user message. Its desktop path is
/// transport metadata only: every byte still comes through the authenticated
/// route for the message that introduced it.
struct TranscriptAttachmentView: View {
    let attachment: DisplayedMessageAttachment
    let messageId: String
    /// Fetches the bytes, for this chat's thread. Not the session itself:
    /// observing it redrew every attachment card on every publish.
    let actions: TranscriptActions
    var foreground: Color = BubbleColor.mineText

    @State private var thumbnail: UIImage?
    @State private var thumbnailLoading = false
    @State private var previewLoading = false
    @State private var errorMessage: Text?
    @State private var thumbnailAttempt = 0
    @State private var thumbnailVisible = false
    @State private var preview: FilePreviewItem?
    @State private var previewTask: Task<Void, Never>?
    /// The card's shape once the image has been seen. Unlike the thumbnail
    /// it is kept when the card scrolls far away, so the card never shrinks
    /// back to the placeholder and jumps again on the way back.
    @State private var imageAspect: CGFloat?

    private var taskID: String {
        "\(actions.threadId)\u{1F}\(messageId)\u{1F}\(attachment.path)\u{1F}\(thumbnailAttempt)\u{1F}\(thumbnailVisible)"
    }

    private var shapeKey: String {
        "\(actions.threadId)\u{1F}\(messageId)\u{1F}\(attachment.path)"
    }

    private var knownAspect: CGFloat? {
        imageAspect ?? TranscriptImageShapes.aspect(for: shapeKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if attachment.kind == .image {
                imageCard
            } else {
                fileCard
            }

            if let errorMessage {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .accessibilityHidden(true)
                    errorMessage
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 2)
                    Button("Retry", action: retry)
                        .fontWeight(.semibold)
                        .foregroundStyle(foreground)
                }
                .font(.system(size: 11))
                .foregroundStyle(foreground.opacity(0.92))
                .accessibilityElement(children: .contain)
            }
        }
        // An image card sizes itself (TranscriptImageFit) and hugs its
        // picture, so a narrow one does not stretch a picture-only bubble.
        .frame(maxWidth: attachment.kind == .image ? nil : 320, alignment: .leading)
        .background {
            if attachment.kind == .image {
                GeometryReader { proxy in
                    let frame = proxy.frame(in: .global)
                    Color.clear
                        .onAppear { updateThumbnailVisibility(frame) }
                        .onValueChange(of: frame) { nextFrame in
                            updateThumbnailVisibility(nextFrame)
                        }
                }
            }
        }
        .task(id: taskID) {
            guard attachment.kind == .image, thumbnailVisible, thumbnail == nil else { return }
            await loadThumbnail()
        }
        .onDisappear { previewTask?.cancel() }
        .fullScreenCover(item: $preview) { item in
            FilePreviewView(item: item) {
                preview = nil
            }
        }
    }

    /// The whole image at its own shape, fitted to the bubble and never
    /// cropped, with its name beneath. The box's size comes only from the
    /// width the bubble offers and the clamped shape (TranscriptImageFit):
    /// the picture is drawn in an overlay and is never measured, so no image
    /// — however wide — can push the bubble, and with it the whole chat,
    /// past the screen's edges again.
    private var imageCard: some View {
        let aspect = knownAspect
        let width = CGFloat(aspect.map { TranscriptImageFit.maximumCardWidth(aspect: Double($0)) }
            ?? TranscriptImageFit.maximumWidth)
        return Button(action: openPreview) {
            VStack(alignment: .leading, spacing: 5) {
                imageBox(aspect: aspect)
                    .frame(maxWidth: width)
                    .background(foreground.opacity(0.12))
                    .overlay { imageContent }
                    .clipShape(RoundedRectangle(cornerRadius: 13))
                    .overlay {
                        RoundedRectangle(cornerRadius: 13)
                            .strokeBorder(foreground.opacity(0.18))
                    }

                HStack(spacing: 5) {
                    Image(systemName: "photo")
                        .accessibilityHidden(true)
                    Text(attachment.name)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if previewLoading {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(foreground)
                            .accessibilityHidden(true)
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(foreground.opacity(0.75))
                .padding(.horizontal, 2)
                .frame(maxWidth: width, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(previewLoading || thumbnailLoading)
        .accessibilityLabel("Image: \(attachment.name)")
        .accessibilityValue(thumbnail != nil ? "Loaded" : (thumbnailLoading ? "Loading" : "Unavailable"))
        .accessibilityHint(thumbnail == nil ? "Loads the image preview" : "Opens the image full screen")
    }

    /// An empty box at the card's size: the image's clamped shape once it is
    /// known, the placeholder height until then.
    @ViewBuilder
    private func imageBox(aspect: CGFloat?) -> some View {
        if let aspect {
            Color.clear.aspectRatio(aspect, contentMode: .fit)
        } else {
            Color.clear.frame(height: CGFloat(TranscriptImageFit.placeholderHeight))
        }
    }

    @ViewBuilder
    private var imageContent: some View {
        if let thumbnail {
            // Fitted, so a shape outside the card's range sits whole on the
            // backing — a phone screenshot between two bands, a panorama
            // between two strips — instead of being cropped to fill.
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFit()
        } else if thumbnailLoading {
            ProgressView()
                .tint(foreground)
        } else {
            Image(systemName: "photo")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(foreground.opacity(0.72))
        }
    }

    private var fileSymbol: String {
        switch attachment.fileFamily {
        case .video: "play.rectangle.fill"
        case .audio: "waveform"
        case .document: "doc.fill"
        }
    }

    private var fileCard: some View {
        Button(action: openPreview) {
            HStack(spacing: 10) {
                Image(systemName: fileSymbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(foreground)
                    .frame(width: 38, height: 38)
                    .background(foreground.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(previewLoading ? "Opening…" : attachment.fileFamily == .document ? "Tap to preview" : "Tap to play")
                        .font(.system(size: 11))
                        .foregroundStyle(foreground.opacity(0.68))
                }

                Spacer(minLength: 8)
                if previewLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(foreground)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(foreground.opacity(0.65))
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(foreground)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(foreground.opacity(0.10), in: RoundedRectangle(cornerRadius: 13))
            .overlay {
                RoundedRectangle(cornerRadius: 13)
                    .strokeBorder(foreground.opacity(0.12))
            }
            .contentShape(RoundedRectangle(cornerRadius: 13))
        }
        .buttonStyle(.plain)
        .disabled(previewLoading)
        .accessibilityLabel("File: \(attachment.name)")
        .accessibilityHint("Opens a preview")
    }

    @MainActor
    private func loadThumbnail() async {
        thumbnailLoading = true
        errorMessage = nil
        defer { thumbnailLoading = false }
        do {
            let downloaded = try await actions.fetchAttachment(
                messageId: messageId,
                path: attachment.path,
                cacheResult: true
            )
            try Task.checkCancellation()
            guard downloaded.data.count <= AttachmentPolicy.maximumImageBytes,
                  AttachmentPolicy.normalizedMIME(downloaded.contentType).hasPrefix("image/")
            else {
                errorMessage = Text("This image couldn't be previewed.")
                return
            }
            let decoded = await Task.detached(priority: .userInitiated) {
                decodeAttachmentThumbnail(downloaded.data, maximumPixelSize: TranscriptImageFit.thumbnailPixelSize)
            }.value
            try Task.checkCancellation()
            guard let image = decoded.value else {
                errorMessage = Text("This image couldn't be previewed.")
                return
            }
            if let aspect = TranscriptImageFit.cardAspect(width: Double(image.width), height: Double(image.height)) {
                imageAspect = CGFloat(aspect)
                TranscriptImageShapes.remember(CGFloat(aspect), for: shapeKey)
            }
            thumbnail = UIImage(cgImage: image)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = Text(verbatim: error.localizedDescription)
        }
    }

    private func openPreview() {
        guard !previewLoading else { return }
        previewTask?.cancel()
        errorMessage = nil
        previewLoading = true
        previewTask = Task { @MainActor in
            var unfinishedItem: FilePreviewItem?
            defer {
                previewLoading = false
                unfinishedItem?.cleanUp()
            }
            do {
                let downloaded = try await actions.prepareAttachmentPreview(
                    messageId: messageId,
                    path: attachment.path,
                    cacheResult: attachment.kind == .image
                )
                guard let item = FilePreviewItem(downloaded: downloaded) else {
                    errorMessage = Text("The downloaded file couldn't be previewed.")
                    return
                }
                // Adopt cleanup ownership before observing cancellation. The
                // materialized directory otherwise has a one-suspension leak
                // window between Session returning and this view owning it.
                unfinishedItem = item
                try Task.checkCancellation()
                if attachment.kind == .image {
                    guard downloaded.data.count <= AttachmentPolicy.maximumImageBytes,
                          AttachmentPolicy.normalizedMIME(downloaded.contentType).hasPrefix("image/")
                    else {
                        errorMessage = Text("This image couldn't be previewed.")
                        return
                    }
                    if thumbnail == nil {
                        let decoded = await Task.detached(priority: .userInitiated) {
                            decodeAttachmentThumbnail(downloaded.data, maximumPixelSize: 64)
                        }.value
                        try Task.checkCancellation()
                        guard decoded.value != nil else {
                            errorMessage = Text("This image couldn't be previewed.")
                            return
                        }
                    }
                }
                preview = item
                unfinishedItem = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = Text(verbatim: error.localizedDescription)
            }
        }
    }

    private func retry() {
        if attachment.kind == .image, thumbnail == nil {
            thumbnailAttempt += 1
        } else {
            openPreview()
        }
    }

    @MainActor
    private func updateThumbnailVisibility(_ frame: CGRect) {
        let windowBounds = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .bounds ?? UIScreen.main.bounds
        // Begin just before the card reaches the viewport so the placeholder
        // usually resolves during the final part of the scroll gesture.
        let visible = frame.intersects(windowBounds.insetBy(dx: 0, dy: -120))
        if thumbnailVisible != visible { thumbnailVisible = visible }
        // The transcript intentionally uses an eager VStack for correct
        // bottom anchoring. Do not let that turn every image ever visited into
        // permanent row state: keep nearby cards warm, then release the decode.
        let retentionFrame = windowBounds.insetBy(dx: 0, dy: -windowBounds.height)
        if !retentionFrame.intersects(frame), thumbnail != nil { thumbnail = nil }
    }

}

/// Card shapes seen this launch. A chat that is opened again builds its
/// cards afresh; with the shape at hand each one draws at its final height
/// straight away instead of growing out of the placeholder as it loads,
/// which would move the transcript under the reader.
@MainActor
private enum TranscriptImageShapes {
    private static var aspects: [String: CGFloat] = [:]

    static func aspect(for key: String) -> CGFloat? { aspects[key] }

    static func remember(_ aspect: CGFloat, for key: String) {
        // A bound, not a cache policy: a launch rarely sees this many images.
        if aspects.count >= 512 { aspects.removeAll(keepingCapacity: true) }
        aspects[key] = aspect
    }
}

struct FilePreviewItem: Identifiable {
    enum Kind { case markdown, text, quickLook }

    let id = UUID()
    let url: URL
    let filename: String
    let contentType: String
    let data: Data

    init?(downloaded: DownloadedFile) {
        guard let localURL = downloaded.localURL else { return nil }
        data = downloaded.data
        filename = downloaded.filename
        contentType = downloaded.contentType
        url = localURL
    }

    var kind: Kind {
        let mime = contentType.lowercased()
        let suffix = url.pathExtension.lowercased()
        if mime == "text/markdown" || suffix == "md" || suffix == "markdown" {
            return .markdown
        }
        if mime.hasPrefix("text/") || mime == "application/json" {
            return .text
        }
        return .quickLook
    }

    var text: String {
        let limit = 2 * 1_024 * 1_024
        let visible = data.prefix(limit)
        var decoded = String(decoding: visible, as: UTF8.self)
        if data.count > limit {
            decoded += "\n\n— Preview truncated. Share or open the file to read the rest. —"
        }
        return decoded
    }

    func cleanUp() {
        let directory = url.deletingLastPathComponent()
        if directory.deletingLastPathComponent().lastPathComponent == "OpenMausBotFilePreviews" {
            try? FileManager.default.removeItem(at: directory)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

struct FilePreviewView: View {
    let item: FilePreviewItem
    let close: () -> Void
    @State private var linkError: LocalizedStringKey?

    var body: some View {
        NavigationStack {
            Group {
                switch item.kind {
                case .markdown:
                    ScrollView {
                        MarkdownText(source: item.text, openLink: openPreviewLink)
                            .textSelection(.enabled)
                            .frame(maxWidth: 900, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .top)
                            .padding(20)
                    }
                case .text:
                    ScrollView([.horizontal, .vertical]) {
                        Text(item.text)
                            .font(.system(size: 14, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(20)
                    }
                case .quickLook:
                    QuickLookPreview(url: item.url)
                        .ignoresSafeArea(edges: .bottom)
                }
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(item.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done", action: close)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: item.url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share \(item.filename)")
                }
            }
        }
        .onDisappear { item.cleanUp() }
        .alert("Couldn't open link", isPresented: Binding(
            get: { linkError != nil },
            set: { if !$0 { linkError = nil } }
        )) {
            Button("OK", role: .cancel) { linkError = nil }
        } message: {
            Text(linkError ?? "That link couldn't be opened.")
        }
    }

    private func openPreviewLink(_ url: URL) -> OpenURLAction.Result {
        guard let scheme = url.scheme?.lowercased(),
              (scheme == "http" || scheme == "https"),
              url.host != nil
        else {
            linkError = "Open links to other computer files from the original chat message."
            return .handled
        }
        return .systemAction(url)
    }
}

private struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(
            _ controller: QLPreviewController,
            previewItemAt index: Int
        ) -> QLPreviewItem {
            url as NSURL
        }
    }
}
