import CompanionCore
import SwiftUI

/// The compact thread label shared by the roster and the thread picker.
struct BotThreadRow: View {
    let task: BotTask
    var selected = false
    /// The thread is holding a queued send, from the client's queue state.
    /// The harness reports this out-of-band; the activity string never says
    /// it, so the row derives it here rather than parsing activity.
    var queued = false

    private var runtime: (title: String, icon: String, color: Color)? {
        switch task.activity {
        case "waiting-on-you": return ("Waiting on you", "hand.raised.fill", .orange)
        case "working", "running": return ("Working", "arrow.triangle.2.circlepath", .accentColor)
        default:
            if queued { return ("Queued", "clock", .secondary) }
            return task.busy == true ? ("Working", "arrow.triangle.2.circlepath", .accentColor) : nil
        }
    }

    /// A closed or archived thread with nothing live in it reads quieter,
    /// like the desktop's dimmed row; a live status or unread outranks both.
    private var dimmed: Bool {
        (task.isClosed || task.isArchived) && runtime == nil && task.unread != true
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(verbatim: task.displayTitle)
                    .font(.body.weight(task.unread == true ? .semibold : .regular))
                    .foregroundStyle(dimmed ? Color.secondary : Color.primary)
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
                    if let byline = task.bylineLabel {
                        if task.createdAt > 0 { Text("·") }
                        Text(verbatim: byline)
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
        .accessibilityValue(task.isArchived ? "Archived" : dimmed ? "Closed" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
