import Foundation

/// Temporary copies made while the Share extension owns provider URLs.
///
/// A normal send/cancel removes its own directory immediately. If iOS kills
/// the extension, the containing app also sweeps old directories so selected
/// documents do not become accidental long-term App Group storage.
enum AstraSharedInbox {
    static let directoryName = "ShareInbox"

    static func removeDirectories(
        olderThan age: TimeInterval,
        now: Date = Date(),
        fileManager: FileManager = .default
    ) {
        guard let container = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: AstraSharedConfiguration.appGroupIdentifier
        ) else { return }
        let root = container.appendingPathComponent(directoryName, isDirectory: true)
        let keys: Set<URLResourceKey> = [
            .isDirectoryKey,
            .contentModificationDateKey,
            .creationDateKey,
        ]
        guard let children = try? fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else { return }

        let cutoff = now.addingTimeInterval(-max(0, age))
        for child in children {
            guard let values = try? child.resourceValues(forKeys: keys),
                  values.isDirectory == true,
                  let date = values.contentModificationDate ?? values.creationDate,
                  date <= cutoff
            else { continue }
            try? fileManager.removeItem(at: child)
        }
    }
}
