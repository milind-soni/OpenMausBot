import SwiftUI

public struct SkillExecutionReceiptView: View {
    public let skillName: String
    public let status: String // "running", "success", "error"
    public let durationMs: Int
    public let parameters: String
    public let output: String
    
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded: Bool = false
    
    public init(
        skillName: String,
        status: String = "success",
        durationMs: Int = 0,
        parameters: String = "",
        output: String = ""
    ) {
        self.skillName = skillName
        self.status = status
        self.durationMs = durationMs
        self.parameters = parameters
        self.output = output
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        let hasDetails = !parameters.isEmpty || !output.isEmpty
        
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasDetails else { return }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver.fill")
                        .font(.system(size: 11))
                        .foregroundColor(Color(hex: "#8B5CF6"))
                    
                    Text(skillName)
                        .font(.caption2.weight(.bold))
                        .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                    
                    if durationMs > 0 {
                        Text("• \(durationMs)ms")
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    }
                    
                    Spacer()
                    
                    statusBadge
                    
                    if hasDetails {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)
            
            if isExpanded && hasDetails {
                VStack(alignment: .leading, spacing: 5) {
                    if !parameters.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("INPUT")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#8B5CF6"))
                            Text(parameters)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                        }
                    }
                    
                    if !output.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("OUTPUT")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#10B981"))
                            Text(output)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                .lineLimit(6)
                        }
                    }
                }
                .padding(8)
                .background(isDark ? Color.black.opacity(0.35) : Color.white.opacity(0.85))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(6)
        .background(
            LinearGradient(
                colors: isDark ? [
                    Color(hex: "#18181B").opacity(0.92),
                    Color(hex: "#0F172A").opacity(0.88)
                ] : [
                    Color.white.opacity(0.94),
                    Color(hex: "#F8FAFC").opacity(0.88)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(hex: "#8B5CF6").opacity(0.25), lineWidth: 0.65)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 3, y: 1)
    }
    
    @ViewBuilder
    private var statusBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
                .frame(width: 5, height: 5)
            Text(status.capitalized)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.white.opacity(0.08))
        .clipShape(Capsule())
    }
}
