import SwiftUI

public struct ActionChipItem: Identifiable {
    /// A stable id, not a fresh UUID per instance: the row is rebuilt from
    /// stored chips on every render, and identity that changes each time
    /// makes SwiftUI re-insert every chip instead of leaving them be.
    public let id: String
    public let title: String
    public let icon: String
    public let prompt: String

    public init(id: String = UUID().uuidString, title: String, icon: String, prompt: String) {
        self.id = id
        self.title = title
        self.icon = icon
        self.prompt = prompt
    }
}

public struct PredictiveActionChipsView: View {
    public let chips: [ActionChipItem]
    public let accentColor: Color
    public let onSelectChip: (ActionChipItem) -> Void
    
    @Environment(\.colorScheme) private var colorScheme
    
    public static let defaultChips: [ActionChipItem] = [
        ActionChipItem(title: "Show diff", icon: "arrow.triangle.pull", prompt: "Show latest git diff"),
        ActionChipItem(title: "Run tests", icon: "checkmark.seal", prompt: "Run all automated tests"),
        ActionChipItem(title: "Explain steps", icon: "text.bubble", prompt: "Explain the changes in detail"),
        ActionChipItem(title: "What's next?", icon: "sparkles", prompt: "What should we do next?")
    ]
    
    public init(
        chips: [ActionChipItem] = PredictiveActionChipsView.defaultChips,
        accentColor: Color = .purple,
        onSelectChip: @escaping (ActionChipItem) -> Void
    ) {
        self.chips = chips
        self.accentColor = accentColor
        self.onSelectChip = onSelectChip
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(chips) { chip in
                    Button {
                        onSelectChip(chip)
                        Haptics.selection()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: chip.icon)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(accentColor)
                            
                            Text(chip.title)
                                .font(.caption2.weight(.semibold))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#334155"))
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4.5)
                        .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.05))
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 3)
        }
    }
}
