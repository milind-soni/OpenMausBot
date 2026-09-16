import CompanionCore
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct LocalShareAttachment: Identifiable, Sendable {
    enum Kind: Equatable, Sendable { case image, file }

    let id: UUID
    let url: URL
    let name: String
    let mime: String
    let bytes: Int
    let kind: Kind
}

struct LoadedShareItems: Sendable {
    let text: [String]
    let urls: [URL]
    let attachments: [LocalShareAttachment]
    let ignoredCount: Int
    let inboxURL: URL
}

private struct DocumentRepresentation {
    let identifier: String
    let mime: String
    let type: UTType
}

enum ShareItemLoadingError: LocalizedError {
    case appGroupUnavailable
    case nothingSupported
    case tooManyItems
    case tooMuchText
    case tooLarge(String, Int)
    case unsupportedDocument(String)
    case unreadable(String)

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "Astra couldn't open its secure sharing folder. Open the app once, then try again."
        case .nothingSupported:
            return "There isn't any text, link, image, or supported document to send."
        case .tooManyItems:
            return "Send up to \(AttachmentPolicy.maximumItems) items at a time."
        case .tooMuchText:
            return "That text is too large to share. Send a shorter selection."
        case let .tooLarge(name, limit):
            return "\(name) is larger than \(limit) MB."
        case let .unsupportedDocument(name):
            return "\(name) isn't a supported document. Try PDF, text, Word, Excel, or PowerPoint."
        case let .unreadable(name):
            return "Astra couldn't read \(name). Try exporting it to Files first."
        }
    }
}

enum ShareItemLoader {
    private static let maximumTextCharacters = 100_000

    static func load(from context: NSExtensionContext) async throws -> LoadedShareItems {
        let extensionItems = context.inputItems.compactMap { $0 as? NSExtensionItem }
        let providers = extensionItems.flatMap { $0.attachments ?? [] }
        let attributedTexts = extensionItems.compactMap { item -> String? in
            let value = item.attributedContentText?.string
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return value.isEmpty ? nil : value
        }
        guard !providers.isEmpty || !attributedTexts.isEmpty else {
            throw ShareItemLoadingError.nothingSupported
        }
        guard providers.count <= AttachmentPolicy.maximumItems else {
            throw ShareItemLoadingError.tooManyItems
        }
        AstraSharedInbox.removeDirectories(olderThan: 0)
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AstraSharedConfiguration.appGroupIdentifier
        ) else { throw ShareItemLoadingError.appGroupUnavailable }

        let inboxRoot = container.appendingPathComponent(
            AstraSharedInbox.directoryName,
            isDirectory: true
        )
        let inbox = inboxRoot
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: inbox,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )

        do {
            var texts = attributedTexts
            var urls: [URL] = []
            var attachments: [LocalShareAttachment] = []
            var ignored = 0
            var textCharacters = attributedTexts.reduce(0) { $0 + $1.count }
            guard textCharacters <= maximumTextCharacters else {
                throw ShareItemLoadingError.tooMuchText
            }
            var attachmentBytes = 0

            for provider in providers {
                if let type = registeredType(in: provider, conformingTo: .image) {
                    let attachment = try await loadImage(provider, type: type, into: inbox)
                    attachmentBytes += attachment.bytes
                    guard attachmentBytes <= AttachmentPolicy.maximumTotalBytes else {
                        throw ShareItemLoadingError.tooLarge(
                            "Those files together",
                            AttachmentPolicy.maximumTotalBytes / (1_024 * 1_024)
                        )
                    }
                    attachments.append(attachment)
                } else if let representation = registeredDocumentRepresentation(in: provider) {
                    let attachment = try await loadFile(
                        provider,
                        representation: representation,
                        into: inbox
                    )
                    attachmentBytes += attachment.bytes
                    guard attachmentBytes <= AttachmentPolicy.maximumTotalBytes else {
                        throw ShareItemLoadingError.tooLarge(
                            "Those files together",
                            AttachmentPolicy.maximumTotalBytes / (1_024 * 1_024)
                        )
                    }
                    attachments.append(attachment)
                } else if let type = registeredType(in: provider, conformingTo: .fileURL) {
                    let attachment = try await loadFileURL(provider, type: type, into: inbox)
                    attachmentBytes += attachment.bytes
                    guard attachmentBytes <= AttachmentPolicy.maximumTotalBytes else {
                        throw ShareItemLoadingError.tooLarge(
                            "Those files together",
                            AttachmentPolicy.maximumTotalBytes / (1_024 * 1_024)
                        )
                    }
                    attachments.append(attachment)
                } else if let type = registeredType(in: provider, conformingTo: .url),
                          let url = try await loadURL(provider, type: type),
                          validWebURL(url) {
                    urls.append(url)
                } else if let type = registeredType(in: provider, conformingTo: .plainText),
                          let text = try await loadText(provider, type: type) {
                    textCharacters += text.count
                    guard textCharacters <= maximumTextCharacters else {
                        throw ShareItemLoadingError.tooMuchText
                    }
                    texts.append(text)
                } else {
                    ignored += 1
                }
            }

            guard !texts.isEmpty || !urls.isEmpty || !attachments.isEmpty else {
                throw ShareItemLoadingError.nothingSupported
            }
            return LoadedShareItems(
                text: texts,
                urls: urls,
                attachments: attachments,
                ignoredCount: ignored,
                inboxURL: inbox
            )
        } catch {
            try? FileManager.default.removeItem(at: inbox)
            throw error
        }
    }

    static func cleanUp(_ items: LoadedShareItems?) {
        guard let items else { return }
        try? FileManager.default.removeItem(at: items.inboxURL)
    }

    private static func registeredType(
        in provider: NSItemProvider,
        conformingTo expected: UTType
    ) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            UTType(identifier)?.conforms(to: expected) == true
        }
    }

    private static func registeredDocumentRepresentation(
        in provider: NSItemProvider
    ) -> DocumentRepresentation? {
        for identifier in provider.registeredTypeIdentifiers {
            guard let type = UTType(identifier),
                  type.conforms(to: .content) || type.conforms(to: .data),
                  !type.conforms(to: .image),
                  !type.conforms(to: .url),
                  !type.conforms(to: .plainText),
                  let mime = type.preferredMIMEType?.lowercased(),
                  AttachmentPolicy.documentMIMETypes.contains(mime)
            else { continue }
            return DocumentRepresentation(identifier: identifier, mime: mime, type: type)
        }

        // Some document providers advertise only generic `public.data` even
        // though their suggested filename identifies a supported format. Do
        // not let that generic representation mask a later file-URL or text
        // fallback, but use it when the filename gives us an allowlisted MIME.
        guard let suggestedName = provider.suggestedName,
              let inferred = UTType(filenameExtension: (suggestedName as NSString).pathExtension),
              let mime = inferred.preferredMIMEType?.lowercased(),
              AttachmentPolicy.documentMIMETypes.contains(mime),
              let identifier = provider.registeredTypeIdentifiers.first(where: { identifier in
                  guard let type = UTType(identifier) else { return false }
                  return type.conforms(to: .data)
                      && !type.conforms(to: .image)
                      && !type.conforms(to: .url)
                      && !type.conforms(to: .plainText)
              })
        else { return nil }
        return DocumentRepresentation(identifier: identifier, mime: mime, type: inferred)
    }

    private static func loadURL(_ provider: NSItemProvider, type: String) async throws -> URL? {
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<URL?, Error>) in
            provider.loadItem(forTypeIdentifier: type) { item, error in
                if let error { return continuation.resume(throwing: error) }
                if let url = item as? URL { return continuation.resume(returning: url) }
                if let value = item as? String {
                    return continuation.resume(returning: URL(string: value))
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private static func validWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil
        else { return false }
        return url.absoluteString.utf8.count <= 8_192
    }

    private static func loadText(_ provider: NSItemProvider, type: String) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type) { item, error in
                if let error { return continuation.resume(throwing: error) }
                if let value = item as? String { return continuation.resume(returning: value) }
                if let value = item as? NSAttributedString {
                    return continuation.resume(returning: value.string)
                }
                if let data = item as? Data {
                    return continuation.resume(returning: String(data: data, encoding: .utf8))
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private static func loadImage(
        _ provider: NSItemProvider,
        type: String,
        into inbox: URL
    ) async throws -> LocalShareAttachment {
        let copied = try await copyFileRepresentation(
            provider,
            type: type,
            into: inbox,
            maximumBytes: AttachmentPolicy.maximumFileBytes
        )
        let claimedMime = UTType(type)?.preferredMIMEType?.lowercased() ?? "application/octet-stream"
        if AttachmentPolicy.imageMIMETypes.contains(claimedMime),
           copied.bytes <= AttachmentPolicy.maximumImageBytes {
            return LocalShareAttachment(
                id: UUID(), url: copied.url, name: copied.name,
                mime: claimedMime, bytes: copied.bytes, kind: .image
            )
        }

        guard let jpeg = downsampledJPEG(from: copied.url),
              jpeg.count <= AttachmentPolicy.maximumImageBytes
        else {
            throw ShareItemLoadingError.tooLarge(
                copied.name,
                AttachmentPolicy.maximumImageBytes / (1_024 * 1_024)
            )
        }
        let converted = inbox.appendingPathComponent("\(UUID().uuidString)-image.jpg")
        try jpeg.write(to: converted, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try? FileManager.default.removeItem(at: copied.url)
        return LocalShareAttachment(
            id: UUID(), url: converted, name: "image.jpg",
            mime: "image/jpeg", bytes: jpeg.count, kind: .image
        )
    }

    private static func loadFile(
        _ provider: NSItemProvider,
        representation: DocumentRepresentation,
        into inbox: URL
    ) async throws -> LocalShareAttachment {
        let copied = try await copyFileRepresentation(
            provider,
            type: representation.identifier,
            suggestedType: representation.type,
            into: inbox,
            maximumBytes: AttachmentPolicy.maximumFileBytes
        )
        return LocalShareAttachment(
            id: UUID(), url: copied.url, name: copied.name,
            mime: representation.mime, bytes: copied.bytes, kind: .file
        )
    }

    private static func loadFileURL(
        _ provider: NSItemProvider,
        type: String,
        into inbox: URL
    ) async throws -> LocalShareAttachment {
        let suggestedName = provider.suggestedName
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type) { item, error in
                if let error { return continuation.resume(throwing: error) }
                guard let source = item as? URL, source.isFileURL else {
                    return continuation.resume(
                        throwing: ShareItemLoadingError.unreadable(suggestedName ?? "that item")
                    )
                }
                let accessed = source.startAccessingSecurityScopedResource()
                defer { if accessed { source.stopAccessingSecurityScopedResource() } }
                do {
                    let inferred = UTType(filenameExtension: source.pathExtension)
                    let mime = inferred?.preferredMIMEType?.lowercased() ?? "application/octet-stream"
                    let name = safeName(suggestedName ?? source.lastPathComponent, type: inferred)
                    guard AttachmentPolicy.documentMIMETypes.contains(mime) else {
                        throw ShareItemLoadingError.unsupportedDocument(name)
                    }
                    let copied = try copyRegularFile(
                        source,
                        name: name,
                        into: inbox,
                        maximumBytes: AttachmentPolicy.maximumFileBytes
                    )
                    continuation.resume(returning: LocalShareAttachment(
                        id: UUID(), url: copied.url, name: name,
                        mime: mime, bytes: copied.bytes, kind: .file
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func copyFileRepresentation(
        _ provider: NSItemProvider,
        type: String,
        suggestedType: UTType? = nil,
        into inbox: URL,
        maximumBytes: Int
    ) async throws -> (url: URL, name: String, bytes: Int) {
        let suggestedName = provider.suggestedName
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<(url: URL, name: String, bytes: Int), Error>) in
            provider.loadFileRepresentation(forTypeIdentifier: type) { source, error in
                if let error { return continuation.resume(throwing: error) }
                guard let source else {
                    return continuation.resume(throwing: ShareItemLoadingError.unreadable("that item"))
                }
                let accessed = source.startAccessingSecurityScopedResource()
                defer { if accessed { source.stopAccessingSecurityScopedResource() } }
                do {
                    let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
                    guard attributes[.type] as? FileAttributeType == .typeRegular else {
                        throw ShareItemLoadingError.unreadable(suggestedName ?? "that item")
                    }
                    let name = safeName(
                        suggestedName ?? source.lastPathComponent,
                        type: suggestedType ?? UTType(type)
                    )
                    let copied = try copyRegularFile(
                        source,
                        name: name,
                        into: inbox,
                        maximumBytes: maximumBytes
                    )
                    continuation.resume(returning: (copied.url, name, copied.bytes))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func copyRegularFile(
        _ source: URL,
        name: String,
        into inbox: URL,
        maximumBytes: Int
    ) throws -> (url: URL, bytes: Int) {
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw ShareItemLoadingError.unreadable(name)
        }
        let advertisedBytes = (attributes[.size] as? NSNumber)?.intValue ?? 0
        guard advertisedBytes > 0 else { throw ShareItemLoadingError.unreadable(name) }
        guard advertisedBytes <= maximumBytes else {
            throw ShareItemLoadingError.tooLarge(name, maximumBytes / (1_024 * 1_024))
        }
        let destination = inbox.appendingPathComponent("\(UUID().uuidString)-\(name)")
        // Provider URLs stop being valid when their callbacks return.
        // Stream into our own file and enforce the ceiling on bytes actually
        // read. A provider can change its temporary file after the metadata
        // check, so FileManager.copyItem plus a pre-copy stat is not a limit.
        guard FileManager.default.createFile(
            atPath: destination.path,
            contents: nil,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        ) else { throw ShareItemLoadingError.unreadable(name) }

        let sourceHandle = try FileHandle(forReadingFrom: source)
        let destinationHandle: FileHandle
        do {
            destinationHandle = try FileHandle(forWritingTo: destination)
        } catch {
            try? sourceHandle.close()
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        var copiedBytes = 0
        do {
            while let chunk = try sourceHandle.read(upToCount: 64 * 1_024), !chunk.isEmpty {
                guard copiedBytes + chunk.count <= maximumBytes else {
                    throw ShareItemLoadingError.tooLarge(
                        name,
                        maximumBytes / (1_024 * 1_024)
                    )
                }
                try destinationHandle.write(contentsOf: chunk)
                copiedBytes += chunk.count
            }
            guard copiedBytes > 0 else { throw ShareItemLoadingError.unreadable(name) }
            try sourceHandle.close()
            try destinationHandle.close()
            return (destination, copiedBytes)
        } catch {
            try? sourceHandle.close()
            try? destinationHandle.close()
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    private static func safeName(_ raw: String, type: UTType?) -> String {
        var name = URL(fileURLWithPath: raw).lastPathComponent
            .unicodeScalars
            .map { CharacterSet.controlCharacters.contains($0) ? "_" : String($0) }
            .joined()
            .replacingOccurrences(of: "\\", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { name = "Shared item" }
        if URL(fileURLWithPath: name).pathExtension.isEmpty,
           let suffix = type?.preferredFilenameExtension {
            name += ".\(suffix)"
        }
        var bounded = ""
        for character in name {
            let candidate = bounded + String(character)
            guard candidate.utf8.count <= 180 else { break }
            bounded = candidate
        }
        return bounded.isEmpty ? "Shared item" : bounded
    }

    /// Photos commonly supplies HEIC. ImageIO applies its orientation while
    /// decoding straight to a bounded thumbnail, avoiding the two full-size
    /// 48 MP buffers that would exceed a Share Extension's memory budget.
    private static func downsampledJPEG(from url: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let thumbnailOptions: CFDictionary = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 3_072,
            kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else {
            return nil
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}
