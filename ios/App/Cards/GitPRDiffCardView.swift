import SwiftUI

public struct GitPRDiffCardView: View {
    public let filename: String
    public let diffText: String
    public let additions: Int
    public let deletions: Int
    
    @Environment(\.colorScheme) private var colorScheme
    @State private var showDiff: Bool = true
    @State private var showAllLines: Bool = false

    private var lines: [String] { diffText.components(separatedBy: "\n") }
    private var visibleLines: ArraySlice<String> {
        lines.prefix(showAllLines ? lines.count : 80)
    }
    
    public init(
        filename: String = "Changes",
        diffText: String,
        additions: Int = 0,
        deletions: Int = 0
    ) {
        self.filename = filename
        self.diffText = diffText
        
        if additions == 0 && deletions == 0 {
            let lines = diffText.components(separatedBy: "\n")
            self.additions = lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
            self.deletions = lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
        } else {
            self.additions = additions
            self.deletions = deletions
        }
    }
    
    private var isDark: Bool { colorScheme == .dark }
    private static let green = Color(hex: "#22C55E")
    private static let red = Color(hex: "#EF4444")
    private var titleColor: Color { isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A") }
    private var mutedColor: Color { isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B") }
    private var deltaFill: Color { isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04) }
    private var hairline: Color { isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08) }
    private var codeFill: Color { isDark ? Color.black.opacity(0.55) : Color(hex: "#0F172A") }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !diffText.isEmpty {
                diffSection
            }
            Divider().background(hairline)
            footer
        }
        .padding(10)
        .background(cardGradient)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(hairline, lineWidth: 0.75)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 4, y: 1.5)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.pull")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Self.green)

            Text(filename)
                .font(.caption.weight(.bold))
                .foregroundColor(titleColor)
                .lineLimit(1)

            Spacer()

            delta
        }
    }

    /// The + / - counts.
    private var delta: some View {
        HStack(spacing: 4) {
            Text("+\(additions)")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .foregroundColor(Self.green)
            Text("-\(deletions)")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .foregroundColor(Self.red)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .background(deltaFill)
        .clipShape(Capsule())
    }

    private var diffSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            diffToggle

            if showDiff {
                diffLines

                if lines.count > 80 {
                    Button(showAllLines ? "Show first 80 lines" : "Show all \(lines.count) lines") {
                        withAnimation(.easeInOut(duration: 0.2)) { showAllLines.toggle() }
                        Haptics.selection()
                    }
                    .font(.caption2.weight(.semibold))
                    .buttonStyle(.plain)
                    .accessibilityHint("The copied diff always includes every line")
                }
            }
        }
    }

    private var diffToggle: some View {
        Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                showDiff.toggle()
            }
            Haptics.selection()
        } label: {
            HStack {
                Image(systemName: showDiff ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                Text(showDiff ? "Hide Diff" : "View Diff")
                    .font(.caption2.weight(.semibold))
                Spacer()
            }
            .foregroundColor(mutedColor)
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
    }

    private var diffLines: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                    diffLineView(line, isDark: isDark)
                }
            }
            .padding(6)
        }
        .background(codeFill)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button {
                PlatformBridge.copyToPasteboard(diffText)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "doc.on.doc")
                    Text("Copy Diff")
                }
                .font(.caption2.weight(.medium))
                .foregroundColor(mutedColor)
            }
            .buttonStyle(.plain)

            Spacer()
        }
    }

    private var cardGradient: LinearGradient {
        LinearGradient(
            colors: isDark ? [
                Color(hex: "#0D1117").opacity(0.96),
                Color(hex: "#161B22").opacity(0.92)
            ] : [
                Color.white.opacity(0.96),
                Color(hex: "#F8FAFC").opacity(0.92)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    @ViewBuilder
    private func diffLineView(_ line: String, isDark: Bool) -> some View {
        let isAddition = line.hasPrefix("+") && !line.hasPrefix("+++")
        let isDeletion = line.hasPrefix("-") && !line.hasPrefix("---")
        let isHeader = line.hasPrefix("@@") || line.hasPrefix("diff")
        
        Text(line)
            .font(.system(size: 10, design: .monospaced))
            .foregroundColor(
                isAddition ? Color(hex: "#4ADE80") :
                isDeletion ? Color(hex: "#F87171") :
                isHeader ? Color(hex: "#38BDF8") :
                Color(hex: "#E2E8F0")
            )
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(
                isAddition ? Color(hex: "#22C55E").opacity(0.15) :
                isDeletion ? Color(hex: "#EF4444").opacity(0.15) :
                Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: 2))
    }
}
