import SwiftUI

public struct CommandSkillItem: Identifiable {
    public let id: String
    public let title: String
    public let description: String
    public let iconName: String
    public let brandColor: Color
    public let command: String
    
    public init(id: String, title: String, description: String, iconName: String, brandColor: Color, command: String) {
        self.id = id
        self.title = title
        self.description = description
        self.iconName = iconName
        self.brandColor = brandColor
        self.command = command
    }
}

public struct CommandSkillHUDView: View {
    @Binding public var text: String
    @Binding public var isVisible: Bool
    public let commands: [CommandSkillItem]
    public let accentColor: Color
    public let onSelectCommand: (CommandSkillItem) -> Void
    
    @Environment(\.colorScheme) private var colorScheme
    
    public static let defaultCommands: [CommandSkillItem] = [
        CommandSkillItem(
            id: "computer",
            title: "/computer",
            description: "Open live screen & desktop controls",
            iconName: "desktopcomputer",
            brandColor: Color(hex: "#38BDF8"),
            command: "/computer"
        ),
        CommandSkillItem(
            id: "tasks",
            title: "/tasks",
            description: "View and manage bot task threads",
            iconName: "square.stack.fill",
            brandColor: Color(hex: "#A855F7"),
            command: "/tasks"
        ),
        CommandSkillItem(
            id: "diff",
            title: "/diff",
            description: "Inspect latest git changes and patches",
            iconName: "arrow.triangle.pull",
            brandColor: Color(hex: "#22C55E"),
            command: "Show git diff and list modified files"
        ),
        CommandSkillItem(
            id: "retry",
            title: "/retry",
            description: "Retry the last turn with fresh context",
            iconName: "arrow.clockwise",
            brandColor: Color(hex: "#EAB308"),
            command: "Please retry the last turn"
        ),
        CommandSkillItem(
            id: "steer",
            title: "/steer",
            description: "Steer and redirect active execution",
            iconName: "steeringwheel",
            brandColor: Color(hex: "#F97316"),
            command: "Pause and explain your current plan"
        )
    ]
    
    public init(
        text: Binding<String>,
        isVisible: Binding<Bool>,
        commands: [CommandSkillItem] = CommandSkillHUDView.defaultCommands,
        accentColor: Color = .purple,
        onSelectCommand: @escaping (CommandSkillItem) -> Void
    ) {
        self._text = text
        self._isVisible = isVisible
        self.commands = commands
        self.accentColor = accentColor
        self.onSelectCommand = onSelectCommand
    }
    
    private var filteredCommands: [CommandSkillItem] {
        if text.hasPrefix("/") && text.count > 1 {
            let query = String(text.dropFirst()).lowercased()
            return commands.filter {
                $0.title.lowercased().contains(query) || $0.description.lowercased().contains(query)
            }
        }
        return commands
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 8) {
            headerBar(isDark: isDark)
            
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(filteredCommands) { cmd in
                        CommandCardView(cmd: cmd, isDark: isDark) {
                            onSelectCommand(cmd)
                            withAnimation { isVisible = false }
                            Haptics.selection()
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 8)
            }
        }
        .background(
            LinearGradient(
                colors: isDark ? [
                    Color(hex: "#0F172A").opacity(0.96),
                    Color(hex: "#1E293B").opacity(0.94)
                ] : [
                    Color.white.opacity(0.96),
                    Color(hex: "#F8FAFC").opacity(0.94)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.14) : Color.black.opacity(0.08), lineWidth: 0.8)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.25 : 0.08), radius: 8, y: 3)
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }
    
    @ViewBuilder
    private func headerBar(isDark: Bool) -> some View {
        HStack {
            HStack(spacing: 5) {
                Image(systemName: "command")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(accentColor)
                Text("SLASH COMMANDS")
                    .font(.system(size: 9.5, weight: .heavy, design: .monospaced))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
            }
            
            Spacer()
            
            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.75)) {
                    isVisible = false
                    if text == "/" { text = "" }
                }
                Haptics.selection()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15))
                    .foregroundColor(isDark ? Color(hex: "#64748B") : Color(hex: "#94A3B8"))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close slash commands")
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }
}

private struct CommandCardView: View {
    let cmd: CommandSkillItem
    let isDark: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: cmd.iconName)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(cmd.brandColor)
                    Text(cmd.title)
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundColor(isDark ? .white : Color(hex: "#0F172A"))
                }
                
                Text(cmd.description)
                    .font(.system(size: 9.5))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .padding(8)
            .frame(width: 145, height: 60, alignment: .topLeading)
            .background(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(cmd.brandColor.opacity(0.35), lineWidth: 0.8)
            )
        }
        .buttonStyle(.plain)
    }
}
