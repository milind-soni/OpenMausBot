import SwiftUI

public struct SkillExecutionReceiptView: View {
    public let skillName: String
    public let status: String // "running", "success", "error"
    public let durationMs: Int
    public let parameters: String
    public let output: String
    
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
                    statusIcon
                    Text(skillName)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.primary)
                    if durationMs > 0 {
                        Text("• \(durationMs)ms")
                            .font(.system(size: 9.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }

                    Spacer()
                    statusBadge

                    if hasDetails {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
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
                                .foregroundStyle(.primary)
                        }
                    }
                    
                    if !output.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("OUTPUT")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#10B981"))
                            Text(output)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.primary)
                                .lineLimit(6)
                        }
                    }
                }
                .padding(8)
                .background(Color.secondary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(6)
        .background(Color.secondary.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// The status the icon carries, not a brand mark: the web transcript
    /// shows the same check, cross and spinner for settled and running tools.
    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case "success":
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.green)
        case "error":
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.red)
        case "running":
            ProgressView()
                .controlSize(.mini)
                .tint(.orange)
                .frame(width: 12, height: 12)
        default:
            Image(systemName: "circle.dotted")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
        }
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
    }
}
