import CompanionCore
import SwiftUI

/// The compact thread label shared by the roster and the thread picker.
struct BotThreadRow: View {
    let task: BotTask
    var selected = false

    private var runtime: (title: String, icon: String, color: Color)? {
        switch task.activity {
        case "waiting-on-you": return ("Waiting on you", "hand.raised.fill", .orange)
        case "queued": return ("Queued", "clock", .secondary)
        case "working", "running": return ("Working", "arrow.triangle.2.circlepath", .accentColor)
        default:
            return task.busy == true ? ("Working", "arrow.triangle.2.circlepath", .accentColor) : nil
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: task.displayTitle)
                    .font(.body.weight(task.unread == true ? .semibold : .regular))
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)

                if runtime != nil || task.unread == true {
                    HStack(spacing: 10) {
                        if let runtime {
                            Label(runtime.title, systemImage: runtime.icon)
                                .foregroundStyle(runtime.color)
                        }
                        if task.unread == true {
                            Label("Unread", systemImage: "circle.fill")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .font(.caption.weight(.medium))
                }

                HStack(spacing: 5) {
                    if task.createdAt > 0 {
                        Text(RelativeStamp.list(task.createdAt))
                    }
                    if let opener = task.openedByLabel {
                        if task.createdAt > 0 { Text("·") }
                        Text(verbatim: opener)
                    }
                }
                .font(.caption)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if selected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
