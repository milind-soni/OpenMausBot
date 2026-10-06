import Foundation
import XCTest

/// Opening a sheet on iOS-on-Mac builds a new hosting controller. That
/// controller does not inherit `@EnvironmentObject`, so a `List`, `Form`, or
/// `ScrollView` that reads `Session` traps in `EnvironmentObject.error()`
/// while the sheet is presented (`SheetBridge.present`). The Updates sheet
/// is that `ScrollView`. Every sheet or cover whose content reads one has
/// to receive it on the presented view.
final class SheetEnvironmentTests: XCTestCase {
    func testSheetRootsReceiveTheEnvironmentObjectsTheyRead() throws {
        let app = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("App")
        let required: [(file: String, view: String, objects: [String])] = [
            ("ChatListView.swift", "RoutineCalendarView()", ["session"]),
            ("ChatListView.swift", "UpdatesSheet {", ["session"]),
            ("ChatListView.swift", "WalkieView {", ["session"]),
            ("ChatListView.swift", "NewGroupSheet {", ["session"]),
            ("ChatListView.swift", "NewSectionSheet()", ["session"]),
            ("ChatListView.swift", "TaskManagerView(chat: chat)", ["session"]),
            ("ChatView.swift", "TaskManagerView(chat: current)", ["session"]),
            ("ChatView.swift", "AgentProfileView(bot: bot)", ["session"]),
            ("TasksRoutinesView.swift", "RoutineEditorView(", ["session"]),
            ("RoutineCalendarView.swift", "RoutineEditorView(", ["session"]),
            ("LiveCallBar.swift", "LiveCallSettingsSheet()", ["session", "liveCall"]),
        ]
        for item in required {
            let source = try String(contentsOf: app.appendingPathComponent(item.file), encoding: .utf8)
            let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let start = lines.firstIndex(where: { $0.contains(item.view) }) else {
                XCTFail("\(item.file) no longer presents \(item.view)")
                continue
            }
            let nextPresentation = lines[(start + 1)...].firstIndex {
                $0.contains(".sheet(") || $0.contains(".fullScreenCover(")
            } ?? lines.endIndex
            let presented = lines[start..<nextPresentation].map { $0.trimmingCharacters(in: .whitespaces) }
            for object in item.objects {
                XCTAssertTrue(
                    presented.contains(".environmentObject(\(object))"),
                    "\(item.file) presents \(item.view) without .environmentObject(\(object))"
                )
            }
        }
    }
}
